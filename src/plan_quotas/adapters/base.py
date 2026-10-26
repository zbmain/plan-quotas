"""Adapter contract and safe transport shared by every provider."""

import asyncio
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from plan_quotas.models import UsageResult


class AdapterError(Exception):
    """Expose a safe machine-readable failure without upstream response contents."""

    def __init__(self, code: str, *, retry_after: int | None = None):
        """Retain only an allowlisted category and optional retry delay."""
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


class BaseAdapter:
    """Fetch usage with fixed URLs and return optional rotated credentials."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Implement provider collection; never return raw credentials in UsageResult."""
        raise NotImplementedError


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    oauth_token: bool = False,
    forbidden_code: str = "auth_required",
    **kwargs: Any,
) -> Any:
    """Request a fixed provider endpoint, retrying only transient failures once."""
    for attempt in range(2):
        try:
            response = await client.request(
                method, url, timeout=15, follow_redirects=False, **kwargs
            )
        except httpx.RequestError:
            if attempt == 0:
                await asyncio.sleep(0.25)
                continue
            raise AdapterError("network_error") from None
        if response.status_code == 401:
            raise AdapterError("auth_required")
        if response.status_code == 403:
            raise AdapterError(forbidden_code)
        if response.status_code == 429:
            raw = response.headers.get("retry-after", "60")
            try:
                delay = int(raw)
            except ValueError:
                try:
                    delay = int((parsedate_to_datetime(raw) - datetime.now(UTC)).total_seconds())
                except (ValueError, TypeError, OverflowError):
                    delay = 60
            raise AdapterError("rate_limited", retry_after=max(1, min(delay, 86400)))
        if response.status_code == 400 and oauth_token:
            try:
                body = response.json()
            except ValueError:
                body = None
            error_code = body.get("error") if isinstance(body, dict) else None
            if isinstance(error_code, str) and error_code in {
                "invalid_grant",
                "invalid_client",
                "unauthorized_client",
            }:
                raise AdapterError("auth_required")
        if response.status_code >= 500 and attempt == 0:
            await asyncio.sleep(0.25)
            continue
        if not response.is_success:
            raise AdapterError("upstream_error")
        try:
            return response.json()
        except ValueError:
            raise AdapterError("invalid_response") from None
    raise AdapterError("network_error")


def require(credentials: dict[str, str], key: str) -> str:
    """Read a required credential without exposing it in validation errors."""
    value = credentials.get(key, "").strip()
    if not value:
        raise AdapterError("invalid_credentials")
    return value


def timestamp(value: Any) -> datetime | None:
    """Normalize documented epoch or ISO provider timestamps to aware UTC."""
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)) or str(value).replace(".", "", 1).isdigit():
            number = float(value)
            return datetime.fromtimestamp(number / 1000 if number > 1e11 else number, UTC)
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=UTC) if result.tzinfo is None else result.astimezone(UTC)
    except (ValueError, OverflowError, OSError):
        return None


def number(value: Any) -> float | None:
    """Convert optional numeric fields, preserving unknown rather than inventing zero."""
    import math

    try:
        result = float(value) if value is not None and value != "" else None
        return result if result is not None and math.isfinite(result) else None
    except (ValueError, TypeError):
        return None
