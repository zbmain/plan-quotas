"""适配中国区常用 AI Coding Plan 与余额查询接口。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from plan_quotas.adapters.base import (
    AdapterError,
    BaseAdapter,
    number,
    request_json,
    require,
    timestamp,
)
from plan_quotas.models import Metric, UsageResult

MINIMAX_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"
GLM_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
DEEPSEEK_URL = "https://api.deepseek.com/user/balance"


def _object(value: Any) -> dict[str, Any]:
    """Return a JSON object or raise a safe parse error."""
    if not isinstance(value, dict):
        raise AdapterError("invalid_response")
    return value


def _unwrap_data(value: Any) -> dict[str, Any]:
    """Unwrap known provider response envelopes without exposing raw content."""
    root = _object(value)
    data = root.get("data", root)
    return _object(data)


def _auth_header(credentials: dict[str, str], auth_type: str) -> dict[str, str]:
    """Build the MiniMax or GLM authorization header from an allowed credential."""
    if auth_type == "api_key":
        return {"Authorization": f"Bearer {require(credentials, 'api_key')}"}
    if auth_type == "cookie":
        return {"Cookie": require(credentials, "cookie")}
    raise AdapterError("invalid_credentials")


def _minimax_metrics(rows: Any) -> list[Metric]:
    """Convert MiniMax remaining-percentage records to usage metrics."""
    if not isinstance(rows, list):
        raise AdapterError("invalid_response")
    metrics: list[Metric] = []
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            continue
        model_name = raw.get("model_name")
        if model_name and str(model_name).lower() not in {"general", "coding", "text"}:
            continue
        for suffix, remaining_key, reset_key, label, window in (
            ("interval", "current_interval_remaining_percent", "remains_time", "短周期", "5h"),
            ("weekly", "current_weekly_remaining_percent", "weekly_remains_time", "长周期", "week"),
        ):
            remaining_percent = number(raw.get(remaining_key))
            if remaining_percent is None:
                continue
            reset_seconds = number(raw.get(reset_key))
            reset_at = None
            if reset_seconds is not None and reset_seconds >= 0:
                reset_at = datetime.now(UTC) + timedelta(milliseconds=reset_seconds)
            metrics.append(
                Metric(
                    id=f"{suffix}-{index}",
                    label=label,
                    unit="%",
                    remaining=remaining_percent,
                    used_percent=100.0 - remaining_percent,
                    window=window,
                    resets_at=reset_at,
                )
            )
    if not metrics:
        raise AdapterError("invalid_response")
    return metrics


class MiniMaxAdapter(BaseAdapter):
    """Read MiniMax China Coding Plan remaining quota."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch the fixed MiniMax endpoint and return only normalized quota fields."""
        payload = await request_json(
            client, "GET", MINIMAX_URL, headers=_auth_header(credentials, auth_type)
        )
        root = _object(payload)
        base_resp = root.get("base_resp")
        if isinstance(base_resp, dict) and number(base_resp.get("status_code")) not in (None, 0):
            raise AdapterError("auth_required")
        metrics = _minimax_metrics(root.get("model_remains"))
        title = root.get("current_subscribe_title") or root.get("plan_name")
        return UsageResult(
            plan=str(title)[:120] if title else None, metrics=metrics, source="minimax"
        ), None


def _glm_window(row: dict[str, Any], index: int) -> str | None:
    """Map observed GLM quota metadata and leave undocumented windows unknown."""
    kind = str(row.get("type", "")).upper()
    unit = number(row.get("unit"))
    count = number(row.get("number"))
    if kind == "TOKENS_LIMIT" and unit == 3 and count == 5:
        return "5h"
    if kind == "TOKENS_LIMIT" and unit == 6 and count == 1:
        return "week"
    if kind == "TIME_LIMIT":
        return "monthly" if unit == 5 and count == 1 else None
    return f"quota-{index + 1}"


def _glm_mcp_metrics(row: dict[str, Any], window: str | None) -> list[Metric]:
    """Normalize GLM MCP tool-call usage details when the provider returns them."""
    details = row.get("usageDetails")
    if not isinstance(details, list):
        return []
    labels = {
        "search-prime": "联网搜索",
        "web-reader": "网页阅读",
        "zread": "仓库检索",
    }
    metrics: list[Metric] = []
    for detail in details:
        if not isinstance(detail, dict):
            continue
        used = number(detail.get("usage"))
        if used is None:
            continue
        code = detail.get("modelCode")
        normalized_code = str(code).lower() if code is not None else ""
        label = labels.get(normalized_code)
        if label is None:
            continue
        metrics.append(
            Metric(
                id=f"glm-mcp-{normalized_code}",
                label=f"{label}调用次数",
                unit="次",
                used=used,
                window=window,
            )
        )
    return metrics


def _glm_metrics(data: dict[str, Any]) -> list[Metric]:
    """Normalize GLM limit records while preserving unknown amounts as null."""
    limits = data.get("limits")
    if not isinstance(limits, list):
        raise AdapterError("invalid_response")
    metrics: list[Metric] = []
    for index, raw in enumerate(limits):
        if not isinstance(raw, dict):
            continue
        usage = number(raw.get("usage"))
        used = number(raw.get("currentValue"))
        remaining = number(raw.get("remaining"))
        percent = number(raw.get("percentage"))
        if used is None and usage is not None and remaining is not None:
            used = usage - remaining
        if remaining is None and usage is not None and used is not None:
            remaining = usage - used
        reset_at = timestamp(raw.get("nextResetTime"))
        kind = str(raw.get("type", "")).upper()
        is_mcp_limit = kind == "TIME_LIMIT"
        is_mcp_calls = is_mcp_limit and number(raw.get("unit")) == 5
        unit = "次" if is_mcp_limit else "tokens"
        metrics.append(
            Metric(
                id=f"glm-{index}",
                label="MCP 调用次数" if is_mcp_calls else "GLM Coding Plan",
                unit=unit,
                used=used,
                limit=usage,
                remaining=remaining,
                used_percent=percent,
                window=_glm_window(raw, index),
                resets_at=reset_at,
            )
        )
        if is_mcp_calls:
            metrics.extend(_glm_mcp_metrics(raw, _glm_window(raw, index)))
    if not metrics:
        raise AdapterError("invalid_response")
    return metrics


class GLMAdapter(BaseAdapter):
    """Read Zhipu GLM Coding Plan quota limits."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch the fixed GLM quota endpoint with a bearer API key."""
        if auth_type != "api_key":
            raise AdapterError("invalid_credentials")
        payload = await request_json(
            client,
            "GET",
            GLM_URL,
            headers={"Authorization": f"Bearer {require(credentials, 'api_key')}"},
        )
        data = _unwrap_data(payload)
        return UsageResult(plan="GLM Coding Plan", metrics=_glm_metrics(data), source="glm"), None


def _deepseek_metrics(data: dict[str, Any]) -> list[Metric]:
    """Create separate currency-aware metrics for DeepSeek balance components."""
    rows = data.get("balance_infos")
    if not isinstance(rows, list):
        raise AdapterError("invalid_response")
    metrics: list[Metric] = []
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            continue
        currency = raw.get("currency")
        if currency not in {"CNY", "USD"}:
            continue
        for field, label in (
            ("total_balance", "总余额"),
            ("granted_balance", "赠送余额"),
            ("topped_up_balance", "充值余额"),
        ):
            amount = number(raw.get(field))
            if amount is None:
                continue
            metrics.append(
                Metric(
                    id=f"balance-{index}-{field}",
                    label=label,
                    kind="balance",
                    unit=str(currency),
                    remaining=amount,
                    currency=str(currency),
                )
            )
    if not metrics:
        raise AdapterError("invalid_response")
    return metrics


class DeepSeekAdapter(BaseAdapter):
    """Read the official DeepSeek API balance endpoint."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch DeepSeek balances and keep currencies as separate metrics."""
        if auth_type != "api_key":
            raise AdapterError("invalid_credentials")
        payload = await request_json(
            client,
            "GET",
            DEEPSEEK_URL,
            headers={"Authorization": f"Bearer {require(credentials, 'api_key')}"},
        )
        root = _object(payload)
        return UsageResult(
            plan=None,
            metrics=_deepseek_metrics(root),
            source="deepseek",
        ), None
