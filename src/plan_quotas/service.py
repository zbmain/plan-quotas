"""Coordinate provider polling and expose a secret-free view of persisted usage."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from plan_quotas.adapters.base import AdapterError, BaseAdapter
from plan_quotas.catalog import VERIFIED_AUTH_METHODS
from plan_quotas.models import Account, Metric, Snapshot, UsageResult, utc_now
from plan_quotas.storage import Store

logger = logging.getLogger(__name__)

_SAFE_ERRORS = {
    "auth_required",
    "invalid_credentials",
    "rate_limited",
    "network_error",
    "upstream_error",
    "invalid_response",
    "subscription_unavailable",
}
_STATUS_FOR_ERROR = {
    "auth_required": "auth_required",
    "invalid_credentials": "auth_required",
    "rate_limited": "rate_limited",
    "network_error": "error",
    "upstream_error": "error",
    "invalid_response": "error",
    "subscription_unavailable": "error",
}


class QuotaService:
    """Poll configured adapters and provide safe public account and usage views."""

    def __init__(
        self,
        store: Store,
        client: httpx.AsyncClient,
        adapters: dict[str, BaseAdapter],
    ) -> None:
        """Bind persistence, shared HTTP transport, and provider adapters."""
        self.store = store
        self.client = client
        self.adapters = adapters
        self._semaphore = asyncio.Semaphore(4)
        self._account_locks: dict[str, asyncio.Lock] = {}
        self._manual_refreshes: dict[str, datetime] = {}
        self._last_cleanup_date: date | None = None

    def account_lock(self, account_id: str) -> asyncio.Lock:
        """Return the shared per-account lock used by refresh and account mutations."""
        if account_id not in self._account_locks:
            self._account_locks[account_id] = asyncio.Lock()
        return self._account_locks[account_id]

    def collection_slot(self) -> asyncio.Semaphore:
        """Return the shared four-request limiter for tests and scheduled collections."""
        return self._semaphore

    async def refresh(self, account_id: str, manual: bool = False) -> Snapshot:
        """Refresh one account, applying cooldowns and discarding stale concurrent results."""
        lock = self.account_lock(account_id)
        was_locked = lock.locked()
        async with lock:
            account = self._find_account(account_id)
            if account is None:
                return Snapshot(account_id=account_id)
            current = self.store.get_snapshot(account_id)
            if was_locked:
                return current
            if not account.enabled:
                disabled = current.model_copy(update={"status": "disabled", "error_code": None})
                self.store.save_snapshot(disabled)
                return disabled
            now = utc_now()
            if current.status == "auth_required":
                return current
            if current.status == "rate_limited" and current.retry_at and current.retry_at > now:
                return current
            last_manual = self._manual_refreshes.get(account_id)
            if manual and last_manual and now - last_manual < timedelta(seconds=60):
                return current
            if manual:
                self._manual_refreshes[account_id] = now

            credentials = self.store.get_credentials(account_id)
            async with self._semaphore:
                # A route may have changed credentials while this refresh waited for capacity.
                account = self._find_account(account_id)
                if account is None:
                    return current
                if self.store.get_credentials(account_id) != credentials:
                    return self.store.get_snapshot(account_id)
                try:
                    adapter = self.adapters.get(account.provider)
                    if adapter is None:
                        raise AdapterError("invalid_response")
                    result, rotated = await adapter.fetch(
                        credentials, account.auth_type, self.client
                    )
                    safe_result = self._sanitize_result(result, {**credentials, **(rotated or {})})
                except AdapterError as exc:
                    return self._handle_adapter_error(account_id, credentials, current, exc, now)
                except Exception:
                    # Adapter exceptions may contain request URLs, response bodies, or credentials.
                    return self._save_failure(
                        account_id, credentials, current, "invalid_response", now
                    )
                if not self._still_current(account_id, credentials):
                    return self.store.get_snapshot(account_id)
                if rotated is not None:
                    self.store.set_credentials(account_id, rotated)
                snapshot = Snapshot(
                    account_id=account_id,
                    status="ok",
                    data=safe_result,
                    last_attempt_at=now,
                    last_success_at=safe_result.fetched_at,
                )
                self.store.save_snapshot(snapshot)
                try:
                    self.store.append_history(account_id, safe_result)
                except Exception:
                    # Keep the successful snapshot if history cannot be written.
                    logger.warning(
                        "quota_service_error code=history_write_failed account_id=%s",
                        account_id,
                    )
                return snapshot

    def reset_account(self, account_id: str) -> Snapshot:
        """Clear an authentication pause after the administrator replaces credentials."""
        current = self.store.get_snapshot(account_id)
        reset = current.model_copy(
            update={
                "status": "pending",
                "error_code": None,
                "retry_at": None,
                "last_attempt_at": None,
            }
        )
        self._manual_refreshes.pop(account_id, None)
        self.store.save_snapshot(reset)
        return reset

    def list_accounts(
        self, provider: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        """List only public account metadata, optionally filtering by provider or status."""
        results = []
        for account in self._ordered_accounts():
            snapshot = self.store.get_snapshot(account.id)
            effective_status = "disabled" if not account.enabled else snapshot.status
            if provider and account.provider != provider:
                continue
            if status and effective_status != status:
                continue
            results.append(self._public_account(account, snapshot))
        return results

    def get_usage(
        self,
        account_ids: list[str] | None = None,
        provider: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return current cached usage for selected accounts without credential fields."""
        selected = set(account_ids) if account_ids is not None else None
        return [
            self._public_account(account, self.store.get_snapshot(account.id), include_data=True)
            for account in self._ordered_accounts()
            if (selected is None or account.id in selected)
            and (provider is None or account.provider == provider)
        ]

    def dashboard(self) -> dict[str, Any]:
        """Build the public dashboard payload and aggregate account health counts."""
        accounts = [
            self._public_account(account, self.store.get_snapshot(account.id), include_data=True)
            for account in self._ordered_accounts()
        ]
        active = [account for account in accounts if account["enabled"]]
        successful = [item for item in active if item["status"] == "ok" and not item["stale"]]
        errors = [
            item for item in active if item["status"] in {"auth_required", "rate_limited", "error"}
        ]
        low = [item for item in successful if self._is_low(item["data"])]
        updated = [item["last_success_at"] for item in accounts if item["last_success_at"]]
        return {
            "accounts": accounts,
            "summary": {
                "total": len(accounts),
                "healthy": len(successful),
                "low": len(low),
                "errors": len(errors),
                "updated_at": max(updated) if updated else None,
            },
            "interval_minutes": self.store.config.interval_minutes,
        }

    def summary(self) -> dict[str, Any]:
        """Return public dashboard totals grouped by provider."""
        dashboard = self.dashboard()
        by_provider: dict[str, dict[str, int]] = {}
        for account in dashboard["accounts"]:
            counts = by_provider.setdefault(
                account["provider"], {"total": 0, "healthy": 0, "low": 0, "errors": 0}
            )
            counts["total"] += 1
            if account["status"] == "ok" and not account["stale"]:
                counts["healthy"] += 1
                if self._is_low(account["data"]):
                    counts["low"] += 1
            elif account["status"] in {"auth_required", "rate_limited", "error"}:
                counts["errors"] += 1
        return {**dashboard["summary"], "by_provider": by_provider}

    def history(self, account_id: str, range_name: str) -> dict[str, Any]:
        """Read bucketed usage history for a validated account identifier."""
        if self._find_account(account_id) is None:
            return {"account_id": account_id, "range": range_name, "points": []}
        return self.store.history(account_id, range_name)

    async def run(self, stop: asyncio.Event) -> None:
        """Poll due enabled accounts and run daily history retention cleanup."""
        while not stop.is_set():
            now = utc_now()
            interval = timedelta(minutes=self.store.config.interval_minutes)
            due = []
            for account in self.store.config.accounts:
                if not account.enabled:
                    continue
                try:
                    snapshot = self.store.get_snapshot(account.id)
                    reference = snapshot.last_attempt_at or snapshot.last_success_at
                    if reference is None or now - reference >= interval:
                        due.append(account.id)
                except Exception:
                    logger.warning(
                        "quota_service_error code=snapshot_read_failed account_id=%s",
                        account.id,
                    )
            if due:
                results = await asyncio.gather(
                    *(self.refresh(account_id) for account_id in due), return_exceptions=True
                )
                for account_id, result in zip(due, results, strict=True):
                    if isinstance(result, Exception):
                        logger.warning(
                            "quota_service_error code=refresh_failed account_id=%s", account_id
                        )
            if self._last_cleanup_date != now.date():
                try:
                    self.store.cleanup_history()
                    self._last_cleanup_date = now.date()
                except Exception:
                    logger.warning("quota_service_error code=history_cleanup_failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=5)
            except TimeoutError:
                continue

    def _handle_adapter_error(
        self,
        account_id: str,
        credentials: dict[str, str],
        previous: Snapshot,
        error: AdapterError,
        attempted_at: datetime,
    ) -> Snapshot:
        """Persist a safe adapter error and any token rotation completed before that error."""
        raw_code = getattr(error, "code", None)
        code = (
            raw_code
            if isinstance(raw_code, str) and raw_code in _SAFE_ERRORS
            else "invalid_response"
        )
        retry_at = None
        if code == "rate_limited":
            retry_after = getattr(error, "retry_after", None)
            delay = max(1, min(retry_after, 86400) if isinstance(retry_after, int) else 60)
            retry_at = utc_now() + timedelta(seconds=delay)
        failure_credentials = credentials
        rotated = getattr(error, "rotated_credentials", None)
        if rotated is not None and (
            not isinstance(rotated, dict)
            or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in rotated.items()
            )
        ):
            rotated = None
            code = "invalid_response"
            retry_at = None
        if rotated is not None and self._still_current(account_id, credentials):
            self.store.set_credentials(account_id, rotated)
            failure_credentials = rotated
        return self._save_failure(
            account_id, failure_credentials, previous, code, attempted_at, retry_at
        )

    def _save_failure(
        self,
        account_id: str,
        credentials: dict[str, str],
        previous: Snapshot,
        code: str,
        attempted_at: datetime,
        retry_at: datetime | None = None,
    ) -> Snapshot:
        """Persist an allowlisted failure only while the account and credentials remain current."""
        if not self._still_current(account_id, credentials):
            return self.store.get_snapshot(account_id)
        snapshot = Snapshot(
            account_id=account_id,
            status=_STATUS_FOR_ERROR.get(code, "error"),
            data=previous.data,
            last_attempt_at=attempted_at,
            last_success_at=previous.last_success_at,
            error_code=code,
            retry_at=retry_at,
        )
        self.store.save_snapshot(snapshot)
        return snapshot

    def _still_current(self, account_id: str, credentials: dict[str, str]) -> bool:
        """Check configuration membership and credential revision before committing a result."""
        return (
            self._find_account(account_id) is not None
            and self.store.get_credentials(account_id) == credentials
        )

    def _find_account(self, account_id: str) -> Account | None:
        """Find current account configuration by its opaque identifier."""
        return next((item for item in self.store.config.accounts if item.id == account_id), None)

    def _ordered_accounts(self) -> list[Account]:
        """Return accounts in stable configured display order."""
        return sorted(self.store.config.accounts, key=lambda item: item.order)

    def _public_account(
        self, account: Account, snapshot: Snapshot, *, include_data: bool = False
    ) -> dict[str, Any]:
        """Create the strict public account allowlist without auth metadata or secrets."""
        now = utc_now()
        stale = bool(
            snapshot.data
            and (
                snapshot.status != "ok"
                or snapshot.last_success_at is None
                or now - snapshot.last_success_at
                > timedelta(minutes=self.store.config.interval_minutes * 2)
            )
        )
        record: dict[str, Any] = {
            "id": account.id,
            "provider": account.provider,
            "alias": account.alias,
            "enabled": account.enabled,
            "status": "disabled" if not account.enabled else snapshot.status,
            "stale": stale,
            "last_attempt_at": snapshot.last_attempt_at,
            "last_success_at": snapshot.last_success_at,
            "error_code": snapshot.error_code,
            "verification": (
                "verified"
                if (account.provider, account.auth_type) in VERIFIED_AUTH_METHODS
                else "not_tested"
            ),
        }
        if include_data:
            record["data"] = snapshot.data.model_dump(mode="json") if snapshot.data else None
        return record

    @staticmethod
    def _sanitize_result(result: UsageResult, credentials: dict[str, str]) -> UsageResult:
        """Strip credential substrings and constrain adapter output to the shared result model."""
        secrets_found = [
            value for value in credentials.values() if isinstance(value, str) and value
        ]

        def clean(value: str | None, fallback: str | None = None) -> str | None:
            if value is None:
                return None
            cleaned = value
            for secret in secrets_found:
                cleaned = re.sub(re.escape(secret), "[已隐藏]", cleaned, flags=re.IGNORECASE)
            return cleaned[:160] or fallback

        metrics = []
        for index, metric in enumerate(result.metrics):
            metric_id = clean(metric.id, f"metric-{index}") or f"metric-{index}"
            label = clean(metric.label, "额度") or "额度"
            window = clean(metric.window)
            currency = clean(metric.currency)
            unit = clean(metric.unit, "%") or "%"
            metrics.append(
                Metric(
                    id=metric_id,
                    label=label,
                    kind=metric.kind,
                    unit=unit,
                    used=metric.used,
                    limit=metric.limit,
                    remaining=metric.remaining,
                    used_percent=metric.used_percent,
                    window=window,
                    resets_at=metric.resets_at,
                    currency=currency,
                )
            )
        fetched_at = result.fetched_at
        fetched_at = (
            fetched_at.replace(tzinfo=UTC)
            if fetched_at.tzinfo is None
            else fetched_at.astimezone(UTC)
        )
        return UsageResult(
            plan=clean(result.plan),
            metrics=metrics,
            source="provider_adapter",
            fetched_at=fetched_at,
        )

    @staticmethod
    def _is_low(data: dict[str, Any] | None) -> bool:
        """Mark a quota low when remaining is at most 20 percent of its known limit."""
        if not data:
            return False
        for metric in data.get("metrics", []):
            if metric.get("kind") != "quota":
                continue
            remaining = metric.get("remaining")
            limit = metric.get("limit")
            if remaining is not None and limit and limit > 0 and remaining / limit <= 0.2:
                return True
            if metric.get("used_percent") is not None and metric["used_percent"] >= 80:
                return True
        return False
