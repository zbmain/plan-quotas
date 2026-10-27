"""Tests for private file persistence, encrypted credentials, and history handling."""

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from plan_quotas.models import Account, AppConfig, Metric, Snapshot, UsageResult
from plan_quotas.storage import Store, StoreError


def _usage(at: datetime, used: float = 1, remaining: float = 9) -> UsageResult:
    """Build one compact quota observation for storage tests."""
    return UsageResult(
        source="test",
        fetched_at=at,
        metrics=[Metric(id="weekly", label="Weekly", used=used, limit=10, remaining=remaining)],
    )


def test_open_secures_files_and_exclusive_lock(tmp_path: Path) -> None:
    """The data directory is private and a second Store cannot acquire its lock."""
    first = Store(tmp_path / "data")
    first.open()
    try:
        assert (tmp_path / "data").stat().st_mode & 0o777 == 0o700
        assert (tmp_path / "data" / "master.key").stat().st_mode & 0o777 == 0o600
        with pytest.raises(StoreError, match="already in use"):
            Store(tmp_path / "data").open()
    finally:
        first.close()
    Store(tmp_path / "data").open()


def test_config_atomic_backup_recovery(tmp_path: Path) -> None:
    """A damaged config recovers from the last atomic backup without data loss."""
    store = Store(tmp_path / "data")
    store.open()
    store.save_config(AppConfig(interval_minutes=7))
    store.save_config(AppConfig(interval_minutes=9))
    (tmp_path / "data" / "config.json").write_text("broken")
    assert store.load_config().interval_minutes == 7
    store.close()


def test_credentials_are_encrypted_and_missing_key_fails_closed(tmp_path: Path) -> None:
    """Credentials are encrypted at rest and missing key material is never regenerated."""
    data_dir = tmp_path / "data"
    store = Store(data_dir)
    store.open()
    account_id = str(uuid4())
    store.set_credentials(account_id, {"token": "secret-value"})
    raw = (data_dir / "secrets.enc").read_text()
    assert "secret-value" not in raw
    assert store.get_credentials(account_id) == {"token": "secret-value"}
    store.close()
    (data_dir / "master.key").unlink()
    with pytest.raises(StoreError, match="master.key is missing"):
        Store(data_dir).open()
    assert not (data_dir / "master.key").exists()


def test_invalid_account_ids_and_symlinked_secret_are_rejected(tmp_path: Path) -> None:
    """Identifiers cannot escape the account tree and secret symlinks are rejected."""
    store = Store(tmp_path / "data")
    store.open()
    with pytest.raises(ValueError, match="UUID"):
        store.get_credentials("../../outside")
    target = tmp_path / "outside"
    target.write_text("{}")
    (tmp_path / "data" / "secrets.enc").symlink_to(target)
    with pytest.raises(StoreError):
        store.get_credentials(str(uuid4()))
    store.close()


def test_snapshot_history_torn_tail_bucket_gaps_and_reset(tmp_path: Path) -> None:
    """History repair, bucketing, gaps and quota reset markers remain explicit."""
    store = Store(tmp_path / "data")
    store.open()
    account_id = str(uuid4())
    pending = store.get_snapshot(account_id)
    assert pending.status == "pending"
    snapshot = Snapshot(account_id=account_id, status="ok", data=_usage(datetime.now(UTC)))
    store.save_snapshot(snapshot)
    assert store.get_snapshot(account_id).status == "ok"
    now = datetime.now(UTC)
    first, second = now - timedelta(minutes=10), now - timedelta(minutes=5)
    store.append_history(account_id, _usage(first, used=8, remaining=2))
    history_file = tmp_path / "data" / "accounts" / account_id / "history" / f"{now:%Y-%m-%d}.jsonl"
    with history_file.open("ab") as stream:
        stream.write(b'{"partial":')
    store.append_history(account_id, _usage(second, used=1, remaining=9))
    parsed_lines = [line for line in history_file.read_bytes().splitlines() if line]
    assert len(parsed_lines) == 2
    result = store.history(account_id, "24h")
    assert len(result["points"]) == 288
    assert any(point["gap"] for point in result["points"])
    assert any(point["reset"] for point in result["points"])
    store.close()


def test_reset_detection_ignores_small_reset_time_jitter() -> None:
    """A small provider reset-time wobble does not mark every poll as a reset."""
    sampled_at = datetime.now(UTC)
    old_reset = sampled_at + timedelta(minutes=10)
    previous = UsageResult(
        source="test",
        fetched_at=sampled_at,
        metrics=[Metric(id="quota", label="Quota", used=10, remaining=90, resets_at=old_reset)],
    )
    current = UsageResult(
        source="test",
        fetched_at=sampled_at + timedelta(seconds=5),
        metrics=[
            Metric(
                id="quota",
                label="Quota",
                used=10,
                remaining=90,
                resets_at=old_reset + timedelta(seconds=30),
            )
        ],
    )

    assert Store._is_reset(previous, current) is False


def test_reset_detection_waits_until_old_boundary_passes() -> None:
    """A large reset-time shift alone is insufficient before the old boundary."""
    sampled_at = datetime.now(UTC)
    old_reset = sampled_at + timedelta(minutes=10)
    previous = UsageResult(
        source="test",
        fetched_at=sampled_at,
        metrics=[Metric(id="quota", label="Quota", used=10, remaining=90, resets_at=old_reset)],
    )
    current = UsageResult(
        source="test",
        fetched_at=sampled_at + timedelta(minutes=5),
        metrics=[
            Metric(
                id="quota",
                label="Quota",
                used=10,
                remaining=90,
                resets_at=old_reset + timedelta(minutes=5),
            )
        ],
    )

    assert Store._is_reset(previous, current) is False


def test_reset_detection_marks_forward_shift_after_old_boundary() -> None:
    """A new reset over one minute later after the old reset time marks a reset."""
    sampled_at = datetime.now(UTC)
    old_reset = sampled_at + timedelta(minutes=10)
    previous = UsageResult(
        source="test",
        fetched_at=sampled_at,
        metrics=[Metric(id="quota", label="Quota", used=10, remaining=90, resets_at=old_reset)],
    )
    current = UsageResult(
        source="test",
        fetched_at=old_reset + timedelta(seconds=1),
        metrics=[
            Metric(
                id="quota",
                label="Quota",
                used=10,
                remaining=90,
                resets_at=old_reset + timedelta(minutes=5),
            )
        ],
    )

    assert Store._is_reset(previous, current) is True


def test_delete_account_data_removes_credentials_snapshot_and_history(tmp_path: Path) -> None:
    """Account deletion clears every account-specific persisted artifact."""
    store = Store(tmp_path / "data")
    store.open()
    account_id = str(uuid4())
    store.set_credentials(account_id, {"token": "s"})
    store.save_snapshot(Snapshot(account_id=account_id, status="ok"))
    store.append_history(account_id, _usage(datetime.now(UTC)))
    store.delete_account_data(account_id)
    assert store.get_credentials(account_id) == {}
    assert store.get_snapshot(account_id).status == "pending"
    assert store.history(account_id, "24h")["points"]
    store.close()


def test_load_empty_default_and_save_account_config(tmp_path: Path) -> None:
    """A fresh store starts with defaults and can persist account metadata."""
    store = Store(tmp_path / "data")
    store.open()
    account = Account(id=str(uuid4()), provider="glm", alias="工作号", auth_type="api_key")
    store.save_config(AppConfig(accounts=[account]))
    assert store.load_config().accounts[0].alias == "工作号"
    store.close()


def test_delete_prunes_config_and_encrypted_credential_backups(tmp_path: Path) -> None:
    """Deleted account ids and credentials are removed from both primary and backups."""
    store = Store(tmp_path / "data")
    store.open()
    account_id = str(uuid4())
    account = Account(id=account_id, provider="glm", alias="待删除", auth_type="api_key")
    store.save_config(AppConfig(accounts=[account]))
    store.save_config(AppConfig())
    store.set_credentials(account_id, {"api_key": "old-secret-value"})
    store.set_credentials(account_id, {"api_key": "new-secret-value"})

    store.delete_account_data(account_id)

    for name in ("config.json", "config.json.bak"):
        path = tmp_path / "data" / name
        if path.exists():
            assert account_id not in path.read_text()
            assert AppConfig.model_validate_json(path.read_bytes()).accounts == []
    encrypted_backup = (tmp_path / "data" / "secrets.enc.bak").read_bytes()
    assert store._decrypt(encrypted_backup) == {}
    assert store.get_credentials(account_id) == {}
    store.close()


def test_missing_primary_config_and_credentials_restore_from_backup(tmp_path: Path) -> None:
    """A missing primary file recovers its backup instead of returning empty state."""
    store = Store(tmp_path / "data")
    store.open()
    account = Account(id=str(uuid4()), provider="glm", alias="恢复账号", auth_type="api_key")
    store.save_config(AppConfig(accounts=[account]))
    store.save_config(AppConfig())
    (tmp_path / "data" / "config.json").unlink()
    assert store.load_config().accounts[0].id == account.id
    assert (tmp_path / "data" / "config.json").exists()

    store.set_credentials(account.id, {"api_key": "recovery-token-one"})
    store.set_credentials(account.id, {"api_key": "recovery-token-two"})
    (tmp_path / "data" / "secrets.enc").unlink()
    assert store.get_credentials(account.id) == {"api_key": "recovery-token-one"}
    assert (tmp_path / "data" / "secrets.enc").exists()
    store.close()


def test_complete_data_directory_backup_restores_all_persisted_state(tmp_path: Path) -> None:
    """A copied private data directory restores key, config, credentials and observations."""
    source_dir = tmp_path / "source-data"
    backup_dir = tmp_path / "restored-data"
    original = Store(source_dir)
    original.open()
    account = Account(id=str(uuid4()), provider="minimax", alias="备份账号", auth_type="api_key")
    fetched_at = datetime.now(UTC)
    expected_usage = _usage(fetched_at, used=36, remaining=64)
    original.save_config(
        AppConfig(
            accounts=[account],
            page_title="备份恢复后的用量面板",
            mcp_token_hash="fake-mcp-token-hash",
        )
    )
    original.set_credentials(account.id, {"api_key": "fake-backup-credential"})
    original.save_snapshot(
        Snapshot(
            account_id=account.id,
            status="ok",
            data=expected_usage,
            last_attempt_at=fetched_at,
            last_success_at=fetched_at,
        )
    )
    original.append_history(account.id, expected_usage)
    original_key = (source_dir / "master.key").read_bytes()
    original.close()

    shutil.copytree(source_dir, backup_dir)

    restored = Store(backup_dir)
    restored.open()
    try:
        assert (backup_dir / "master.key").read_bytes() == original_key
        assert restored.config.mcp_token_hash == "fake-mcp-token-hash"
        assert restored.config.page_title == "备份恢复后的用量面板"
        assert restored.config.accounts == [account]
        assert restored.get_credentials(account.id) == {"api_key": "fake-backup-credential"}
        snapshot = restored.get_snapshot(account.id)
        assert snapshot.status == "ok"
        assert snapshot.data.metrics[0].remaining == 64
        points = restored.history(account.id, "24h")["points"]
        recorded = [point for point in points if not point["gap"]]
        assert len(recorded) == 1
        assert recorded[0]["metrics"][0]["remaining"] == 64
    finally:
        restored.close()
