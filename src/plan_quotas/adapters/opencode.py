"""Read OpenCode Go quotas and optional Console prepaid balance from fixed JSON APIs."""

import re
from datetime import datetime, timedelta
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
from plan_quotas.models import Metric, UsageResult, utc_now

# The former /zen/go/v1/usage route proxies this endpoint in OpenCode's migration source.
OPENCODE_USAGE_URL = "https://opencode.ai/inference/go/v1/usage"
OPENCODE_GO_STATUS_URL = "https://opencode.ai/console/api/go/status"
OPENCODE_BILLING_URL = "https://opencode.ai/console/api/billing/status"
_WINDOWS = (
    ("rolling", "fiveHour", "短周期", "5h"),
    ("weekly", "week", "长周期", "week"),
    ("monthly", "month", "月度额度", "month"),
)


def _quota_number(value: Any) -> float | None:
    """Keep missing counters unknown and reject malformed or negative quota values."""
    if value is None:
        return None
    result = None if isinstance(value, bool) else number(value)
    if result is None or result < 0:
        raise AdapterError("invalid_response")
    return result


def _reset_at(window: dict, now: datetime) -> datetime | None:
    """Prefer provider timestamps and only derive a reset when seconds are supplied."""
    absolute = window.get("resetsAt") or window.get("resetAt")
    if not isinstance(absolute, bool) and (reset := timestamp(absolute)) is not None:
        return reset
    seconds = _quota_number(window.get("resetInSec"))
    if seconds is None:
        return None
    try:
        return now + timedelta(seconds=seconds)
    except OverflowError:
        return None


def _metric(
    key: str, label: str, window: str, percent: float | None, reset: datetime | None
) -> Metric:
    """Express reported subscription consumption as percentages, preserving overages."""
    percent = _quota_number(percent)
    return Metric(
        id=f"opencode-{key}",
        label=label,
        unit="%",
        used=percent,
        limit=100 if percent is not None else None,
        remaining=max(0, 100 - percent) if percent is not None else None,
        used_percent=percent,
        window=window,
        resets_at=reset,
    )


def _api_metrics(payload: Any, now: datetime) -> list[Metric]:
    """Parse Go's percent fields in percentage units: 0.5 means 0.5%, never 50%."""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        raise AdapterError("invalid_response")
    metrics = []
    for key, _, label, window in _WINDOWS:
        item = usage.get(key)
        if item is None:
            continue
        if not isinstance(item, dict):
            raise AdapterError("invalid_response")
        metrics.append(
            _metric(key, label, window, _quota_number(item.get("percent")), _reset_at(item, now))
        )
    if not metrics:
        raise AdapterError("invalid_response")
    return metrics


def _console_metrics(payload: Any, now: datetime) -> list[Metric]:
    """Convert Console micro-cent meters to quotas; only monthly reset uses endsAt."""
    if payload is None:
        return []
    if not isinstance(payload, dict) or "access" not in payload:
        raise AdapterError("invalid_response")
    access = payload["access"]
    if access is None:
        return []
    meters = access.get("meters") if isinstance(access, dict) else None
    if not isinstance(meters, dict):
        raise AdapterError("invalid_response")
    metrics = []
    for key, console_key, label, window in _WINDOWS:
        item = meters.get(console_key)
        if item is None:
            continue
        if not isinstance(item, dict):
            raise AdapterError("invalid_response")
        used = _quota_number(item.get("usedMicroCents"))
        limit = _quota_number(item.get("limitMicroCents"))
        percent = (
            used / limit * 100 if used is not None and limit is not None and limit > 0 else None
        )
        reset = _reset_at(item, now)
        if key == "monthly" and item.get("resetsAt") is None:
            reset = _reset_at({"resetsAt": access.get("endsAt")}, now)
        metrics.append(_metric(key, label, window, percent, reset))
    if not metrics:
        raise AdapterError("invalid_response")
    return metrics


def _prepaid_balance(payload: Any) -> Metric | None:
    """Read signed prepaid USD balance, without substituting available credit or invoice debt."""
    if not isinstance(payload, dict) or not isinstance(payload.get("mode"), str):
        raise AdapterError("invalid_response")
    if payload.get("billingMode") != "prepaid" or payload["mode"] != "pay-as-you-go":
        return None
    raw = payload.get("balanceMicroCents")
    if not isinstance(raw, str) or not re.fullmatch(r"-?\d+", raw, flags=re.ASCII):
        raise AdapterError("invalid_response")
    balance = number(raw)
    if balance is None:
        raise AdapterError("invalid_response")
    return Metric(
        id="opencode-balance",
        label="账户余额",
        kind="balance",
        unit="USD",
        currency="USD",
        remaining=balance / 100_000_000,
    )


class OpenCodeAdapter(BaseAdapter):
    """Keep API-key subscriptions and explicitly scoped Console cookie reads independent."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Read Go quotas using its key, or Console quotas and balance using a workspace cookie."""
        headers = {"Accept": "application/json"}
        if auth_type == "api_key":
            headers["Authorization"] = f"Bearer {require(credentials, 'api_key')}"
            payload = await request_json(
                client,
                "GET",
                OPENCODE_USAGE_URL,
                headers=headers,
                forbidden_code="subscription_unavailable",
            )
            now = utc_now()
            return UsageResult(
                plan="OpenCode Go",
                source="opencode_go_api",
                metrics=_api_metrics(payload, now),
                fetched_at=now,
            ), None
        if auth_type != "cookie":
            raise AdapterError("invalid_credentials")
        workspace = require(credentials, "workspace_id")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", workspace):
            raise AdapterError("invalid_credentials")
        headers.update({"Cookie": require(credentials, "cookie"), "x-org-id": workspace})
        payload = await request_json(
            client,
            "GET",
            OPENCODE_GO_STATUS_URL,
            headers=headers,
            forbidden_code="subscription_unavailable",
        )
        now = utc_now()
        metrics = _console_metrics(payload, now)
        has_subscription = bool(metrics)
        try:
            balance = _prepaid_balance(
                await request_json(client, "GET", OPENCODE_BILLING_URL, headers=headers)
            )
        except AdapterError:
            # An unavailable optional balance must not discard valid Go quota observations.
            if not has_subscription:
                raise
            balance = None
        if balance is not None:
            metrics.append(balance)
        if not metrics:
            raise AdapterError("subscription_unavailable")
        return UsageResult(
            plan="OpenCode Go" if has_subscription else None,
            source="opencode_console",
            metrics=metrics,
            fetched_at=now,
        ), None
