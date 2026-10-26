"""Tests for account polling, public payload safety, and refresh coordination."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from plan_quotas.adapters.base import AdapterError, BaseAdapter
from plan_quotas.models import Account, AppConfig, Metric, Snapshot, UsageResult
from plan_quotas.service import QuotaService
from plan_quotas.storage import Store, StoreError


class StubAdapter(BaseAdapter):
    """Return a controllable usage result or safe adapter error for service tests."""

    def __init__(self, result=None, error=None, entered=None, release=None):
        """Set a result, error, and optional async gate for concurrency scenarios."""
        self.result = result
        self.error = error
        self.entered = entered
        self.release = release
        self.calls = 0

    async def fetch(self, credentials, auth_type, client):
        """Return the configured response while counting provider calls."""
        self.calls += 1
        if self.entered:
            self.entered.set()
        if self.release:
            await self.release.wait()
        if self.error:
            raise self.error
        return self.result, None


def _result(remaining=10, label="剩余额度"):
    """Build a quota result for service behavior tests."""
    return UsageResult(
        source="test-source",
        plan="Pro",
        metrics=[
            Metric(id="weekly", label=label, used=90 - remaining, limit=100, remaining=remaining)
        ],
    )


def _make_service(tmp_path: Path, adapter: StubAdapter):
    """Create a private test store with one enabled GLM account."""
    store = Store(tmp_path / "data")
    store.open()
    account_id = str(uuid4())
    account = Account(id=account_id, provider="glm", alias="工作账号", auth_type="api_key")
    store.save_config(AppConfig(accounts=[account]))
    store.set_credentials(account_id, {"api_key": "very-secret-token"})
    client = httpx.AsyncClient()
    return store, account_id, client, QuotaService(store, client, {"glm": adapter})


@pytest.mark.asyncio
async def test_refresh_persists_snapshot_and_dashboard_is_allowlisted(tmp_path: Path):
    """Successful polling stores safe data and marks quotas below 20 percent as low."""
    adapter = StubAdapter(result=_result(remaining=10))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        snapshot = await service.refresh(account_id)
        assert snapshot.status == "ok"
        assert store.get_snapshot(account_id).data.source == "provider_adapter"
        dashboard = service.dashboard()
        assert dashboard["summary"]["healthy"] == 1
        assert dashboard["summary"]["low"] == 1
        assert dashboard["accounts"][0]["verification"] == "not_tested"
        serialized = str(dashboard)
        for secret_field in ("auth_type", "api_key", "credentials", "very-secret-token"):
            assert secret_field not in serialized
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_auth_required_pauses_until_reset(tmp_path: Path):
    """Authentication failures stop polling until reset_account clears the pause."""
    adapter = StubAdapter(result=_result(), error=AdapterError("auth_required"))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        failed = await service.refresh(account_id)
        assert failed.status == "auth_required"
        assert failed.error_code == "auth_required"
        await service.refresh(account_id)
        assert adapter.calls == 1
        reset = service.reset_account(account_id)
        assert reset.status == "pending"
        adapter.error = None
        success = await service.refresh(account_id)
        assert success.status == "ok"
        assert adapter.calls == 2
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_rate_limit_uses_retry_at_and_manual_refresh_cooldown(tmp_path: Path):
    """A rate limit prevents early collection and manual refreshes respect 60 seconds."""
    adapter = StubAdapter(error=AdapterError("rate_limited", retry_after=3600))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        limited = await service.refresh(account_id, manual=True)
        assert limited.status == "rate_limited"
        assert limited.retry_at and limited.retry_at > datetime.now(UTC)
        await service.refresh(account_id)
        assert adapter.calls == 1
        service._manual_refreshes[account_id] = datetime.now(UTC)
        await service.refresh(account_id, manual=True)
        assert adapter.calls == 1
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_duplicate_refreshes_are_coalesced(tmp_path: Path):
    """Concurrent refresh requests for one account issue one adapter call."""
    entered, release = asyncio.Event(), asyncio.Event()
    adapter = StubAdapter(result=_result(), entered=entered, release=release)
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        first = asyncio.create_task(service.refresh(account_id))
        await entered.wait()
        second = asyncio.create_task(service.refresh(account_id))
        await asyncio.sleep(0)
        release.set()
        snapshots = await asyncio.gather(first, second)
        assert adapter.calls == 1
        assert all(item.status == "ok" for item in snapshots)
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_changed_credentials_discard_inflight_result(tmp_path: Path):
    """A response collected against replaced credentials is never persisted."""
    entered, release = asyncio.Event(), asyncio.Event()
    adapter = StubAdapter(result=_result(), entered=entered, release=release)
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        task = asyncio.create_task(service.refresh(account_id))
        await entered.wait()
        store.set_credentials(account_id, {"api_key": "replacement-secret-token"})
        release.set()
        response = await task
        assert response.status == "pending"
        assert store.get_snapshot(account_id).data is None
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_unknown_adapter_exception_maps_to_fixed_safe_code(tmp_path: Path):
    """Unknown exceptions never leak their message into persisted error fields."""
    adapter = StubAdapter(error=RuntimeError("token=very-secret-token upstream body"))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        snapshot = await service.refresh(account_id)
        assert snapshot.status == "error"
        assert snapshot.error_code == "invalid_response"
        assert "very-secret-token" not in snapshot.model_dump_json()
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_failure_preserves_last_successful_data(tmp_path: Path):
    """A failed refresh records the safe error while preserving previous usage."""
    adapter = StubAdapter(result=_result(remaining=50))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        previous = await service.refresh(account_id)
        adapter.error = AdapterError("network_error")
        failed = await service.refresh(account_id, manual=True)
        assert failed.status == "error"
        assert failed.data == previous.data
        assert failed.error_code == "network_error"
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_rotated_credentials_survive_later_adapter_error(tmp_path: Path):
    """A token rotated before a quota failure is saved while the failure remains visible."""
    adapter = StubAdapter(error=AdapterError("rate_limited", retry_after=120))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    rotated = {"access_token": "rotated-secret-token", "refresh_token": "new-refresh-token"}
    adapter.error.rotated_credentials = rotated
    try:
        snapshot = await service.refresh(account_id)
        assert snapshot.status == "rate_limited"
        assert snapshot.error_code == "rate_limited"
        assert store.get_credentials(account_id) == rotated
        assert "rotated-secret-token" not in snapshot.model_dump_json()
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_stale_failure_is_not_counted_healthy(tmp_path: Path):
    """Old successful data becomes stale immediately when the latest refresh fails."""
    adapter = StubAdapter(result=_result())
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        now = datetime.now(UTC)
        store.save_snapshot(
            Snapshot(
                account_id=account_id,
                status="error",
                error_code="network_error",
                data=_result(),
                last_attempt_at=now,
                last_success_at=now,
            )
        )
        view = service.dashboard()
        assert view["accounts"][0]["stale"] is True
        assert view["summary"]["healthy"] == 0
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_public_account_views_follow_configured_order(tmp_path: Path):
    """Dashboard, usage and account listing share the configured account order."""
    adapter = StubAdapter(result=_result())
    store, first_id, client, service = _make_service(tmp_path, adapter)
    second = Account(
        id=str(uuid4()),
        provider="glm",
        alias="排在前面",
        auth_type="api_key",
        order=-2,
    )
    first = store.config.accounts[0].model_copy(update={"order": 5})
    store.save_config(AppConfig(accounts=[first, second]))
    try:
        expected = [second.id, first_id]
        assert [item["id"] for item in service.dashboard()["accounts"]] == expected
        assert [item["id"] for item in service.get_usage()] == expected
        assert [item["id"] for item in service.list_accounts()] == expected
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_reset_account_clears_any_status_and_manual_cooldown(tmp_path: Path):
    """Credential replacement resets any prior error state and permits immediate retry."""
    adapter = StubAdapter(result=_result())
    store, account_id, client, service = _make_service(tmp_path, adapter)
    try:
        store.save_snapshot(
            Snapshot(
                account_id=account_id,
                status="error",
                error_code="network_error",
                last_attempt_at=datetime.now(UTC),
                retry_at=datetime.now(UTC),
            )
        )
        service._manual_refreshes[account_id] = datetime.now(UTC)
        reset = service.reset_account(account_id)
        assert reset.status == "pending"
        assert reset.error_code is None
        assert reset.last_attempt_at is None
        assert reset.retry_at is None
        assert account_id not in service._manual_refreshes
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_history_write_failure_keeps_new_snapshot(tmp_path: Path, monkeypatch, caplog):
    """A history append failure does not roll back the successful usage snapshot."""
    adapter = StubAdapter(result=_result(remaining=17))
    store, account_id, client, service = _make_service(tmp_path, adapter)

    def fail_history(*args, **kwargs):
        """Simulate a transient disk failure in the history writer."""
        raise StoreError("private path details")

    monkeypatch.setattr(store, "append_history", fail_history)
    try:
        result = await service.refresh(account_id)
        persisted = store.get_snapshot(account_id)
        assert result.status == "ok"
        assert result.data.metrics[0].remaining == 17
        assert persisted.status == "ok"
        assert persisted.data.metrics[0].remaining == 17
        assert "private path details" not in caplog.text
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_scheduler_survives_snapshot_and_cleanup_errors(tmp_path: Path, monkeypatch, caplog):
    """A transient store failure is isolated and the scheduler continues next tick."""
    adapter = StubAdapter(result=_result())
    store, account_id, client, service = _make_service(tmp_path, adapter)
    original_get_snapshot = store.get_snapshot
    original_cleanup = store.cleanup_history
    reads = 0
    cleanups = 0
    waits = 0

    def fail_first_snapshot(account):
        """Fail the first scheduler snapshot read without poisoning later calls."""
        nonlocal reads
        reads += 1
        if reads == 1:
            raise StoreError("secret or path details")
        return original_get_snapshot(account)

    def fail_first_cleanup():
        """Fail one cleanup attempt and allow the next one to recover."""
        nonlocal cleanups
        cleanups += 1
        if cleanups == 1:
            raise StoreError("private cleanup details")
        return original_cleanup()

    async def tick_wait(awaitable, timeout):
        """Advance the scheduler twice without waiting for its five-second timer."""
        nonlocal waits
        waits += 1
        awaitable.close()
        if waits >= 2:
            stop.set()

    stop = asyncio.Event()
    monkeypatch.setattr(store, "get_snapshot", fail_first_snapshot)
    monkeypatch.setattr(store, "cleanup_history", fail_first_cleanup)
    monkeypatch.setattr(asyncio, "wait_for", tick_wait)
    try:
        await service.run(stop)
        assert reads >= 3
        assert cleanups == 2
        assert adapter.calls == 1
        assert "secret or path details" not in caplog.text
        assert "private cleanup details" not in caplog.text
    finally:
        await client.aclose()
        store.close()


@pytest.mark.asyncio
async def test_long_credential_is_removed_before_text_truncation(tmp_path: Path):
    """Long credential values cannot leak when they cross the 160-character cap."""
    long_secret = "secret-" + "x" * 240
    adapter = StubAdapter(result=_result(label=f"额度:{long_secret}:tail"))
    store, account_id, client, service = _make_service(tmp_path, adapter)
    store.set_credentials(account_id, {"api_key": long_secret})
    try:
        snapshot = await service.refresh(account_id)
        serialized = snapshot.model_dump_json()
        assert long_secret not in serialized
        assert snapshot.data.metrics[0].label.startswith("额度:[已隐藏]")
    finally:
        await client.aclose()
        store.close()
