"""Adapters for Codex, Claude, Cursor and Google Antigravity usage endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

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

CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CLAUDE_ORGS_URL = "https://claude.ai/api/organizations"
CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token"
CURSOR_USAGE_URL = "https://www.cursor.com/api/usage-summary"
ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"


def _metric_window(window: dict[str, Any], metric_id: str, label: str) -> Metric:
    """Convert a Codex window using its reported duration, retaining its positional fallback."""
    used_percent = number(window.get("used_percent"))
    resets_at = timestamp(window.get("reset_at"))
    remaining_percent = 100 - used_percent if used_percent is not None else None
    seconds = number(window.get("limit_window_seconds"))
    window_name = label
    if seconds == 18000:
        window_name = "5h"
    elif seconds == 604800:
        window_name = "week"
    elif seconds is not None and seconds > 0:
        for unit_seconds, suffix in (
            (604800, "w"),
            (86400, "d"),
            (3600, "h"),
            (60, "m"),
            (1, "s"),
        ):
            amount = seconds / unit_seconds
            if amount.is_integer():
                window_name = f"{int(amount)}{suffix}"
                break
        else:
            window_name = f"{seconds:g}s"
    return Metric(
        id=metric_id,
        label=label,
        unit="%",
        used=used_percent,
        limit=100 if used_percent is not None else None,
        remaining=remaining_percent,
        used_percent=used_percent,
        window=window_name,
        resets_at=resets_at,
    )


def _token_expired(credentials: dict[str, str]) -> bool:
    """Check imported expiry metadata with a small clock-skew allowance."""
    expiry = timestamp(credentials.get("expires_at"))
    return expiry is not None and expiry.timestamp() <= datetime.now(UTC).timestamp() + 30


async def _refresh_oauth(
    credentials: dict[str, str],
    client: httpx.AsyncClient,
    token_url: str,
    *,
    require_client_secret: bool,
    json_payload: bool = False,
) -> dict[str, str]:
    """Refresh imported OAuth credentials using only provider-required imported fields."""
    refresh_token = credentials.get("refresh_token", "").strip()
    client_id = credentials.get("client_id", "").strip()
    client_secret = credentials.get("client_secret", "").strip()
    if not refresh_token or not client_id or (require_client_secret and not client_secret):
        raise AdapterError("auth_required")
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    if require_client_secret:
        payload["client_secret"] = client_secret
    data = await request_json(
        client,
        "POST",
        token_url,
        json=payload if json_payload else None,
        data=None if json_payload else payload,
        headers={"Accept": "application/json"},
        oauth_token=True,
    )
    if not isinstance(data, dict):
        raise AdapterError("invalid_response")
    if data.get("error") == "invalid_grant":
        raise AdapterError("auth_required")
    access_token = data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise AdapterError("invalid_response")
    rotated = dict(credentials)
    rotated["access_token"] = access_token
    next_refresh = data.get("refresh_token")
    if isinstance(next_refresh, str) and next_refresh:
        rotated["refresh_token"] = next_refresh
    expires_in = number(data.get("expires_in"))
    if expires_in is not None and expires_in > 0:
        rotated["expires_at"] = str(datetime.now(UTC).timestamp() + expires_in)
    else:
        rotated.pop("expires_at", None)
    return rotated


async def _authorized_json(
    client: httpx.AsyncClient,
    url: str,
    credentials: dict[str, str],
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    token_url: str,
    require_client_secret: bool,
    refresh_json: bool = False,
) -> tuple[Any, dict[str, str] | None]:
    """Call a fixed OAuth endpoint, refreshing once on expiry or unauthorized response."""
    rotated: dict[str, str] | None = None
    current = credentials
    if _token_expired(credentials):
        current = await _refresh_oauth(
            credentials,
            client,
            token_url,
            require_client_secret=require_client_secret,
            json_payload=refresh_json,
        )
        rotated = current
    request_headers = {"Authorization": f"Bearer {require(current, 'access_token')}"}
    request_headers.update(headers or {})
    try:
        result = await request_json(
            client, "POST" if body is not None else "GET", url, headers=request_headers, json=body
        )
    except AdapterError as error:
        if error.code != "auth_required" or rotated is not None:
            if rotated is not None:
                error.rotated_credentials = rotated
            raise
        current = await _refresh_oauth(
            credentials,
            client,
            token_url,
            require_client_secret=require_client_secret,
            json_payload=refresh_json,
        )
        rotated = current
        request_headers["Authorization"] = f"Bearer {require(current, 'access_token')}"
        try:
            result = await request_json(
                client,
                "POST" if body is not None else "GET",
                url,
                headers=request_headers,
                json=body,
            )
        except AdapterError as retry_error:
            retry_error.rotated_credentials = rotated
            raise
    return result, rotated


class CodexAdapter(BaseAdapter):
    """Read the signed-in Codex account's WHAM usage windows."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch Codex usage with imported OAuth credentials and safe metrics."""
        if auth_type != "oauth":
            raise AdapterError("invalid_credentials")
        headers = {"Accept": "application/json"}
        account_id = credentials.get("account_id", "").strip()
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id
        data, rotated = await _authorized_json(
            client,
            CODEX_USAGE_URL,
            credentials,
            headers=headers,
            token_url=OPENAI_TOKEN_URL,
            require_client_secret=False,
        )
        if not isinstance(data, dict):
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        rate_limit = data.get("rate_limit")
        if not isinstance(rate_limit, dict):
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        metrics: list[Metric] = []
        for key, label in (("primary_window", "主要额度"), ("secondary_window", "次要额度")):
            window = rate_limit.get(key)
            if isinstance(window, dict):
                if (
                    number(window.get("used_percent")) is not None
                    or timestamp(window.get("reset_at")) is not None
                ):
                    metrics.append(_metric_window(window, key, label))
        if not metrics:
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        plan = data.get("plan_type")
        return UsageResult(
            plan=plan if isinstance(plan, str) else None, metrics=metrics, source="codex_wham"
        ), rotated


class ClaudeAdapter(BaseAdapter):
    """Read Claude subscription usage for imported OAuth or session-cookie credentials."""

    async def _usage(
        self, client: httpx.AsyncClient, credentials: dict[str, str], auth_type: str
    ) -> tuple[dict[str, Any], dict[str, str] | None]:
        """Resolve an organization internally and return its usage response."""
        if auth_type == "oauth":
            data, rotated = await _authorized_json(
                client,
                CLAUDE_OAUTH_USAGE_URL,
                credentials,
                headers={"Accept": "application/json", "anthropic-beta": "oauth-2025-04-20"},
                token_url=CLAUDE_REFRESH_URL,
                require_client_secret=False,
                refresh_json=True,
            )
            if not isinstance(data, dict):
                error = AdapterError("invalid_response")
                if rotated is not None:
                    error.rotated_credentials = rotated
                raise error
            return data, rotated
        if auth_type != "cookie":
            raise AdapterError("invalid_credentials")
        cookie = require(credentials, "cookie")
        headers = {"Cookie": cookie, "Accept": "application/json"}
        organizations = await request_json(client, "GET", CLAUDE_ORGS_URL, headers=headers)
        if not isinstance(organizations, list) or not organizations:
            raise AdapterError("invalid_response")
        organization_id = next(
            (
                org.get("uuid")
                for org in organizations
                if isinstance(org, dict) and isinstance(org.get("uuid"), str)
            ),
            None,
        )
        if not organization_id:
            raise AdapterError("invalid_response")
        url = f"https://claude.ai/api/organizations/{quote(organization_id, safe='')}/usage"
        result = await request_json(client, "GET", url, headers=headers)
        if not isinstance(result, dict):
            raise AdapterError("invalid_response")
        return result, None

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch Claude usage and expose only known quota fields."""
        data, rotated = await self._usage(client, credentials, auth_type)
        metrics: list[Metric] = []
        for metric_id, label in (
            ("five_hour", "5 小时"),
            ("seven_day", "7 天"),
            ("seven_day_sonnet", "Sonnet 7 天"),
            ("seven_day_opus", "Opus 7 天"),
        ):
            window = data.get(metric_id)
            if not isinstance(window, dict):
                continue
            utilization = number(window.get("utilization"))
            reset_at = timestamp(window.get("resets_at"))
            if utilization is None and reset_at is None:
                continue
            metrics.append(
                Metric(
                    id=metric_id,
                    label=label,
                    unit="%",
                    used_percent=utilization,
                    used=utilization,
                    limit=100 if utilization is not None else None,
                    remaining=100 - utilization if utilization is not None else None,
                    window=label,
                    resets_at=reset_at,
                )
            )
        if not metrics:
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        plan = data.get("plan")
        return UsageResult(
            plan=plan if isinstance(plan, str) else None, metrics=metrics, source="claude_usage"
        ), rotated


class CursorAdapter(BaseAdapter):
    """Read Cursor subscription usage from its fixed usage-summary endpoint."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch Cursor plan counters using an imported session cookie."""
        if auth_type != "cookie":
            raise AdapterError("invalid_credentials")
        data = await request_json(
            client,
            "GET",
            CURSOR_USAGE_URL,
            headers={"Cookie": require(credentials, "cookie"), "Accept": "application/json"},
        )
        if not isinstance(data, dict):
            raise AdapterError("invalid_response")
        metrics: list[Metric] = []
        plan_usage = None
        individual_usage = data.get("individualUsage")
        team_usage = data.get("teamUsage")
        if isinstance(individual_usage, dict):
            candidate = individual_usage.get("plan")
            if isinstance(candidate, dict):
                plan_usage = candidate
        cycle_end = timestamp(data.get("billingCycleEnd"))
        if plan_usage is not None:
            for key, label in (
                ("autoPercentUsed", "Cursor Models"),
                ("apiPercentUsed", "Other Models"),
                ("totalPercentUsed", "套餐总用量"),
            ):
                used_percent = number(plan_usage.get(key))
                if used_percent is None:
                    continue
                used_percent = max(0, min(100, used_percent))
                metrics.append(
                    Metric(
                        id=f"plan_{key}",
                        label=label,
                        unit="%",
                        used=used_percent,
                        limit=100,
                        remaining=100 - used_percent,
                        used_percent=used_percent,
                        window="账单周期",
                        resets_at=cycle_end,
                    )
                )
            plan_used_cents = number(plan_usage.get("used"))
            plan_limit_cents = number(plan_usage.get("limit"))
            plan_remaining_cents = number(plan_usage.get("remaining"))
            if any(
                value is not None
                for value in (plan_used_cents, plan_limit_cents, plan_remaining_cents)
            ):
                metrics.append(
                    Metric(
                        id="included_spend",
                        label="套餐内消费",
                        kind="cost",
                        unit="USD",
                        used=plan_used_cents / 100 if plan_used_cents is not None else None,
                        limit=plan_limit_cents / 100 if plan_limit_cents is not None else None,
                        remaining=(
                            plan_remaining_cents / 100 if plan_remaining_cents is not None else None
                        ),
                        currency="USD",
                        window="账单周期",
                        resets_at=cycle_end,
                    )
                )

        on_demand = None
        if isinstance(individual_usage, dict):
            on_demand = individual_usage.get("onDemand")
        if not isinstance(on_demand, dict) and isinstance(team_usage, dict):
            on_demand = team_usage.get("onDemand")
        if isinstance(on_demand, dict):
            used_cents = number(on_demand.get("used"))
            limit_cents = number(on_demand.get("limit"))
            if used_cents is not None or limit_cents is not None:
                used_usd = used_cents / 100 if used_cents is not None else None
                limit_usd = limit_cents / 100 if limit_cents is not None else None
                metrics.append(
                    Metric(
                        id="on_demand",
                        label="按量消费",
                        kind="cost",
                        unit="USD",
                        used=used_usd,
                        limit=limit_usd,
                        remaining=(
                            max(0, limit_usd - used_usd)
                            if limit_usd is not None and used_usd is not None
                            else None
                        ),
                        currency="USD",
                        window="账单周期",
                        resets_at=cycle_end,
                    )
                )

        buckets = data.get("usage")
        if isinstance(buckets, dict):
            for key, label in (("gpt-4", "GPT-4 使用量"), ("gpt-3.5-turbo", "GPT-3.5 使用量")):
                bucket = buckets.get(key)
                if isinstance(bucket, dict):
                    used = number(bucket.get("numRequests"))
                    limit = number(bucket.get("maxRequestUsage"))
                    metrics.append(
                        Metric(
                            id=key,
                            label=label,
                            unit="次",
                            used=used,
                            limit=limit,
                            remaining=max(0, limit - used)
                            if used is not None and limit is not None
                            else None,
                            window="账单周期",
                        )
                    )
        plan = data.get("membershipType") or data.get("plan")
        if not metrics:
            raise AdapterError("invalid_response")
        return UsageResult(
            plan=plan if isinstance(plan, str) else None,
            metrics=metrics,
            source="cursor_usage_summary",
        ), None


class AntigravityAdapter(BaseAdapter):
    """Query existing Antigravity model quotas through Google Cloud Code Assist."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Read per-model remaining fractions without creating projects or onboarding users."""
        if auth_type != "oauth":
            raise AdapterError("invalid_credentials")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        project_id = credentials.get("project_id", "").strip()
        load_body: dict[str, Any] = {"metadata": {"ideType": "ANTIGRAVITY"}}
        if project_id:
            load_body["cloudaicompanionProject"] = project_id
        load_data, rotated = await _authorized_json(
            client,
            f"{ANTIGRAVITY_BASE_URL}:loadCodeAssist",
            credentials,
            headers=headers,
            body=load_body,
            token_url=GOOGLE_TOKEN_URL,
            require_client_secret=True,
        )
        if not isinstance(load_data, dict):
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        resolved_project = load_data.get("cloudaicompanionProject")
        if isinstance(resolved_project, dict):
            resolved_project = resolved_project.get("id")
        if isinstance(resolved_project, str) and resolved_project:
            project_id = resolved_project
        model_body: dict[str, Any] = {"project": project_id} if project_id else {}
        try:
            models_data, next_rotation = await _authorized_json(
                client,
                f"{ANTIGRAVITY_BASE_URL}:fetchAvailableModels",
                credentials if rotated is None else rotated,
                headers=headers,
                body=model_body,
                token_url=GOOGLE_TOKEN_URL,
                require_client_secret=True,
            )
        except AdapterError as error:
            if rotated is not None and getattr(error, "rotated_credentials", None) is None:
                error.rotated_credentials = rotated
            raise
        if not isinstance(models_data, dict):
            error = AdapterError("invalid_response")
            if next_rotation is not None or rotated is not None:
                error.rotated_credentials = next_rotation or rotated
            raise error
        raw_models = models_data.get("models")
        if not isinstance(raw_models, dict):
            error = AdapterError("invalid_response")
            if next_rotation is not None or rotated is not None:
                error.rotated_credentials = next_rotation or rotated
            raise error
        metrics: list[Metric] = []
        for model_key, model_data in raw_models.items():
            if not isinstance(model_data, dict):
                continue
            if model_data.get("isInternal") is True:
                continue
            quota = model_data.get("quotaInfo")
            if not isinstance(quota, dict):
                continue
            remaining = number(quota.get("remainingFraction"))
            if remaining is None:
                continue
            remaining_percent = max(0, min(100, remaining * 100))
            display_name = model_data.get("displayName")
            model_name = model_data.get("model")
            label = next(
                (
                    value.strip()[:120]
                    for value in (display_name, model_name, model_key)
                    if isinstance(value, str) and value.strip()
                ),
                "模型",
            )
            metrics.append(
                Metric(
                    id=model_key,
                    label=label,
                    unit="%",
                    remaining=remaining_percent,
                    used=100 - remaining_percent,
                    limit=100,
                    used_percent=100 - remaining_percent,
                    resets_at=timestamp(quota.get("resetTime")),
                    window="模型额度",
                )
            )
        rotated = next_rotation or rotated
        if not metrics:
            error = AdapterError("invalid_response")
            if rotated is not None:
                error.rotated_credentials = rotated
            raise error
        tier = load_data.get("paidTier") or load_data.get("currentTier")
        tier_name = tier if isinstance(tier, str) else None
        if isinstance(tier, dict):
            tier_name = tier.get("name") or tier.get("id")
        return UsageResult(
            plan=tier_name if isinstance(tier_name, str) else None,
            metrics=metrics,
            source="antigravity_models",
        ), rotated
