"""Shared, secret-free models used by adapters, HTTP and MCP."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DEFAULT_PAGE_TITLE = "plan-quotas · 配额簿 AI 用量面板"

ProviderId = Literal[
    "minimax",
    "glm",
    "kimi",
    "deepseek",
    "volcengine",
    "aliyun",
    "codex",
    "claude",
    "cursor",
    "opencode",
    "antigravity",
]
AuthType = Literal["api_key", "cookie", "oauth", "jwt", "aksk"]


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""
    return datetime.now(UTC)


class Metric(BaseModel):
    """Describe a single observed quota, balance or cost without merging unlike units."""

    id: str
    label: str
    kind: Literal["quota", "balance", "cost"] = "quota"
    unit: str = "%"
    used: float | None = None
    limit: float | None = None
    remaining: float | None = None
    used_percent: float | None = None
    window: str | None = None
    resets_at: datetime | None = None
    currency: str | None = None
    model_config = ConfigDict(allow_inf_nan=False)


class UsageResult(BaseModel):
    """Represent only whitelisted adapter output; raw responses never reach clients."""

    plan: str | None = None
    metrics: list[Metric] = Field(default_factory=list)
    source: str
    fetched_at: datetime = Field(default_factory=utc_now)


class Account(BaseModel):
    """Store account configuration separately from credentials."""

    id: str
    provider: ProviderId
    alias: str = Field(min_length=1, max_length=80)
    auth_type: AuthType
    enabled: bool = True
    order: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class Snapshot(BaseModel):
    """Keep the last successful data together with the latest collection status."""

    account_id: str
    status: Literal["pending", "ok", "auth_required", "rate_limited", "error", "disabled"] = (
        "pending"
    )
    data: UsageResult | None = None
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    error_code: str | None = None
    retry_at: datetime | None = None


class AppConfig(BaseModel):
    """Version the persisted non-secret configuration."""

    version: int = 1
    page_title: str = Field(default=DEFAULT_PAGE_TITLE, min_length=1, max_length=120)
    interval_minutes: float = Field(default=1, ge=0.5, le=60)
    accounts: list[Account] = Field(default_factory=list)
    mcp_token_hash: str | None = None
    info_require_password: bool = False
    info_password_hash: str | None = None
