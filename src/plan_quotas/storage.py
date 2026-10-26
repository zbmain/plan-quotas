"""Secure, file-backed persistence for configuration, credentials and usage history."""

from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import stat
import threading
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from plan_quotas.models import AppConfig, Snapshot, UsageResult, utc_now


class StoreError(RuntimeError):
    """Represent invalid or unsafe persisted state without silently discarding it."""


class Store:
    """Persist application state under a private directory with process and thread locks."""

    _RANGES = {
        "24h": (timedelta(hours=24), timedelta(minutes=5)),
        "7d": (timedelta(days=7), timedelta(hours=1)),
        "30d": (timedelta(days=30), timedelta(hours=6)),
    }

    def __init__(self, data_dir: Path):
        """Create a store handle; call open before accessing persisted data."""
        self.data_dir = Path(data_dir)
        self.config = AppConfig()
        self._lock_fd: int | None = None
        self._mutex = threading.RLock()
        self._key: bytes | None = None

    def open(self) -> None:
        """Create and secure the data directory, key material, and exclusive process lock."""
        with self._mutex:
            if self._lock_fd is not None:
                return
            if self.data_dir.is_symlink():
                raise StoreError("data directory must not be a symlink")
            self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.data_dir, 0o700)
            if not self.data_dir.is_dir():
                raise StoreError("data directory is not a directory")
            lock_path = self.data_dir / ".lock"
            fd = self._open_regular(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                os.close(fd)
                raise StoreError("data directory is already in use") from exc
            self._lock_fd = fd
            try:
                key_path = self.data_dir / "master.key"
                enc_path = self.data_dir / "secrets.enc"
                if not key_path.exists() and (
                    enc_path.exists() or Path(str(enc_path) + ".bak").exists()
                ):
                    raise StoreError("encrypted credentials exist but master.key is missing")
                if not key_path.exists():
                    self._atomic_write(key_path, secrets.token_bytes(32), backup=False)
                key = self._read_regular(key_path)
                if len(key) != 32:
                    raise StoreError("master.key has an invalid length")
                self._key = key
                self.config = self.load_config()
            except Exception:
                self.close()
                raise

    def close(self) -> None:
        """Release the exclusive data-directory lock."""
        with self._mutex:
            if self._lock_fd is not None:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
                os.close(self._lock_fd)
                self._lock_fd = None
            self._key = None

    def load_config(self) -> AppConfig:
        """Load the main configuration, recovering from its backup if needed."""
        with self._mutex:
            path = self.data_dir / "config.json"
            if not path.exists():
                backup = Path(str(path) + ".bak")
                if not backup.exists():
                    return AppConfig()
                try:
                    backup_bytes = self._read_regular(backup)
                    restored = AppConfig.model_validate_json(backup_bytes)
                except Exception as backup_error:
                    raise StoreError("configuration backup is unreadable") from backup_error
                self._atomic_write(path, backup_bytes, backup=False)
                return restored
            try:
                return AppConfig.model_validate_json(self._read_regular(path))
            except Exception:
                backup = Path(str(path) + ".bak")
                try:
                    backup_bytes = self._read_regular(backup)
                    restored = AppConfig.model_validate_json(backup_bytes)
                except Exception as backup_error:
                    raise StoreError("configuration and backup are unreadable") from backup_error
                self._atomic_write(path, backup_bytes, backup=False)
                return restored

    def save_config(self, config: AppConfig) -> None:
        """Atomically persist configuration while retaining the prior version as a backup."""
        with self._mutex:
            payload = config.model_dump_json().encode("utf-8")
            self._atomic_write(self.data_dir / "config.json", payload, backup=True)
            self.config = config

    def set_credentials(self, account_id: str, credentials: dict[str, str]) -> None:
        """Encrypt and atomically store credentials for one UUID account."""
        account_id = self._validate_id(account_id)
        with self._mutex:
            records = self._load_secrets()
            records[account_id] = credentials
            self._write_secrets(records)

    def get_credentials(self, account_id: str) -> dict[str, str]:
        """Return a copy of an account's decrypted credentials, or an empty mapping."""
        account_id = self._validate_id(account_id)
        with self._mutex:
            return dict(self._load_secrets().get(account_id, {}))

    def delete_account_data(self, account_id: str) -> None:
        """Remove credentials, latest snapshot and history files for a UUID account."""
        account_id = self._validate_id(account_id)
        with self._mutex:
            self._prune_config_account(account_id)
            secrets_map = self._load_secrets()
            secrets_map.pop(account_id, None)
            self._write_secrets(secrets_map, backup=False, prune_backup=True)
            snapshot = self._account_dir(account_id) / "snapshot.json"
            self._unlink_regular(snapshot)
            account_dir = self._account_dir(account_id) / "history"
            if account_dir.exists():
                if account_dir.is_symlink() or not account_dir.is_dir():
                    raise StoreError("unsafe account history path")
                for item in account_dir.iterdir():
                    self._unlink_regular(item)
                account_dir.rmdir()
            parent = self._account_dir(account_id)
            if parent.exists() and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()

    def save_snapshot(self, snapshot: Snapshot) -> None:
        """Atomically save the latest status and usage data for an account."""
        account_id = self._validate_id(snapshot.account_id)
        with self._mutex:
            path = self._account_dir(account_id) / "snapshot.json"
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(path.parent, 0o700)
            self._atomic_write(path, snapshot.model_dump_json().encode(), backup=False)

    def get_snapshot(self, account_id: str) -> Snapshot:
        """Load the latest snapshot or return a pending snapshot for a new account."""
        account_id = self._validate_id(account_id)
        with self._mutex:
            path = self._account_dir(account_id) / "snapshot.json"
            if not path.exists():
                return Snapshot(account_id=account_id)
            try:
                snapshot = Snapshot.model_validate_json(self._read_regular(path))
            except Exception as exc:
                raise StoreError("snapshot is unreadable") from exc
            if snapshot.account_id != account_id:
                raise StoreError("snapshot account id mismatch")
            return snapshot

    def append_history(self, account_id: str, data: UsageResult) -> None:
        """Append an observation to its UTC-day JSONL file after repairing a torn tail."""
        account_id = self._validate_id(account_id)
        with self._mutex:
            stamp = data.fetched_at.astimezone(UTC)
            folder = self._account_dir(account_id) / "history"
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(folder, 0o700)
            path = folder / f"{stamp:%Y-%m-%d}.jsonl"
            self._repair_jsonl_tail(path)
            fd = self._open_regular(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            try:
                os.write(fd, data.model_dump_json().encode("utf-8") + b"\n")
                os.fsync(fd)
            finally:
                os.close(fd)

    def history(self, account_id: str, range_name: str) -> dict[str, Any]:
        """Return bucketed history, marking empty buckets and likely quota resets."""
        account_id = self._validate_id(account_id)
        if range_name not in self._RANGES:
            raise ValueError("range_name must be 24h, 7d, or 30d")
        span, bucket = self._RANGES[range_name]
        end = utc_now()
        start = end - span
        with self._mutex:
            observations = self._read_history(account_id, start, end)
        bucket_count = int(span / bucket)
        buckets: list[dict[str, Any] | None] = [None] * bucket_count
        for observation in observations:
            offset = (observation.fetched_at.astimezone(UTC) - start).total_seconds()
            index = min(bucket_count - 1, max(0, int(offset // bucket.total_seconds())))
            buckets[index] = observation
        points: list[dict[str, Any]] = []
        previous: UsageResult | None = None
        for index, observation in enumerate(buckets):
            timestamp = start + index * bucket
            if observation is None:
                points.append(
                    {"timestamp": timestamp.isoformat(), "metrics": [], "gap": True, "reset": False}
                )
                continue
            metric_values = [metric.model_dump(mode="json") for metric in observation.metrics]
            reset = self._is_reset(previous, observation)
            points.append(
                {
                    "timestamp": observation.fetched_at.astimezone(UTC).isoformat(),
                    "metrics": metric_values,
                    "gap": False,
                    "reset": reset,
                }
            )
            previous = observation
        return {"account_id": account_id, "range": range_name, "points": points}

    def cleanup_history(self) -> None:
        """Delete history files older than 30 days while retaining account snapshots."""
        cutoff = utc_now().date() - timedelta(days=30)
        with self._mutex:
            root = self.data_dir / "accounts"
            if not root.exists():
                return
            self._assert_real_directory(root)
            for account in root.iterdir():
                if account.is_symlink() or not account.is_dir():
                    raise StoreError("unsafe account path")
                folder = account / "history"
                if not folder.exists():
                    continue
                self._assert_real_directory(folder)
                for item in folder.iterdir():
                    self._assert_regular(item)
                    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.jsonl", item.name)
                    if match and date.fromisoformat(match.group(1)) < cutoff:
                        item.unlink()

    def _load_secrets(self) -> dict[str, dict[str, str]]:
        """Decrypt the secrets file and recover from its backup on corruption."""
        path = self.data_dir / "secrets.enc"
        if not path.exists():
            backup = Path(str(path) + ".bak")
            if not backup.exists():
                return {}
            try:
                backup_bytes = self._read_regular(backup)
                records = self._decrypt(backup_bytes)
            except Exception as backup_error:
                raise StoreError("encrypted credentials backup is unreadable") from backup_error
            self._atomic_write(path, backup_bytes, backup=False)
            return records
        try:
            return self._decrypt(self._read_regular(path))
        except Exception:
            backup = Path(str(path) + ".bak")
            try:
                backup_bytes = self._read_regular(backup)
                restored = self._decrypt(backup_bytes)
            except Exception as backup_error:
                raise StoreError(
                    "encrypted credentials and backup are unreadable"
                ) from backup_error
            self._atomic_write(path, backup_bytes, backup=False)
            return restored

    def _write_secrets(
        self,
        records: dict[str, dict[str, str]],
        *,
        backup: bool = True,
        prune_backup: bool = False,
    ) -> None:
        """Encrypt all credentials as one authenticated AES-256-GCM payload."""
        payload = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode()
        nonce = secrets.token_bytes(12)
        encrypted = AESGCM(self._require_key()).encrypt(nonce, payload, b"plan-quotas-secrets-v1")
        envelope = json.dumps(
            {"v": 1, "nonce": nonce.hex(), "ciphertext": encrypted.hex()}, separators=(",", ":")
        ).encode()
        target = self.data_dir / "secrets.enc"
        if prune_backup:
            # Replace the old backup first so deleted credentials do not survive there.
            self._write_atomic_no_backup(Path(str(target) + ".bak"), envelope)
            self._atomic_write(target, envelope, backup=False)
        else:
            self._atomic_write(target, envelope, backup=backup)

    def _prune_config_account(self, account_id: str) -> None:
        """Remove a deleted account from active config and its recovery backup."""
        for path in (self.data_dir / "config.json", self.data_dir / "config.json.bak"):
            if not path.exists():
                continue
            try:
                config = AppConfig.model_validate_json(self._read_regular(path))
            except Exception as exc:
                raise StoreError("cannot safely remove account from configuration") from exc
            accounts = [account for account in config.accounts if account.id != account_id]
            if len(accounts) != len(config.accounts):
                updated = config.model_copy(update={"accounts": accounts})
                self._atomic_write(path, updated.model_dump_json().encode(), backup=False)
        self.config = self.config.model_copy(
            update={
                "accounts": [
                    account for account in self.config.accounts if account.id != account_id
                ]
            }
        )

    def _decrypt(self, envelope: bytes) -> dict[str, dict[str, str]]:
        """Authenticate and decrypt one versioned credentials envelope."""
        data = json.loads(envelope)
        if data.get("v") != 1:
            raise StoreError("unsupported credentials version")
        plaintext = AESGCM(self._require_key()).decrypt(
            bytes.fromhex(data["nonce"]),
            bytes.fromhex(data["ciphertext"]),
            b"plan-quotas-secrets-v1",
        )
        result = json.loads(plaintext)
        if not isinstance(result, dict):
            raise StoreError("invalid credentials payload")
        return result

    def _read_history(self, account_id: str, start: datetime, end: datetime) -> list[UsageResult]:
        """Read complete JSONL records in the selected time interval."""
        folder = self._account_dir(account_id) / "history"
        if not folder.exists():
            return []
        self._assert_real_directory(folder)
        observations: list[UsageResult] = []
        day = start.date()
        while day <= end.date():
            path = folder / f"{day.isoformat()}.jsonl"
            if path.exists():
                for line in self._read_regular(path).splitlines(keepends=True):
                    if not line.endswith(b"\n"):
                        continue
                    try:
                        item = UsageResult.model_validate_json(line)
                    except Exception:
                        continue
                    stamp = item.fetched_at.astimezone(UTC)
                    if start <= stamp <= end:
                        observations.append(item)
            day += timedelta(days=1)
        observations.sort(key=lambda item: item.fetched_at)
        return observations

    def _repair_jsonl_tail(self, path: Path) -> None:
        """Truncate only an incomplete final line so a later append stays parseable."""
        if not path.exists():
            return
        data = self._read_regular(path)
        if not data or data.endswith(b"\n"):
            return
        last_newline = data.rfind(b"\n")
        fd = self._open_regular(path, os.O_WRONLY, 0o600)
        try:
            os.ftruncate(fd, last_newline + 1)
            os.fsync(fd)
        finally:
            os.close(fd)

    def _atomic_write(self, path: Path, payload: bytes, *, backup: bool) -> None:
        """Write a private temporary file, sync it, preserve backup, and replace atomically."""
        self._assert_parent(path.parent)
        if path.exists() or path.is_symlink():
            self._assert_regular(path)
        mode = 0o600
        temp = path.parent / f".{path.name}.{secrets.token_hex(8)}.tmp"
        fd = self._open_regular(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        try:
            if backup and path.exists():
                current = self._read_regular(path)
                self._write_atomic_no_backup(Path(str(path) + ".bak"), current)
            os.replace(temp, path)
            os.chmod(path, mode, follow_symlinks=False)
            self._fsync_dir(path.parent)
        finally:
            if temp.exists():
                temp.unlink()

    def _write_atomic_no_backup(self, path: Path, payload: bytes) -> None:
        """Atomically replace a backup file without creating another backup generation."""
        self._atomic_write(path, payload, backup=False)

    def _open_regular(self, path: Path, flags: int, mode: int) -> int:
        """Open a regular file without following symlinks and enforce private permissions."""
        fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), mode)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            raise StoreError(f"unsafe non-regular file: {path.name}")
        os.fchmod(fd, mode)
        return fd

    def _read_regular(self, path: Path) -> bytes:
        """Read a regular file through a no-follow descriptor."""
        fd = self._open_regular(path, os.O_RDONLY, 0o600)
        try:
            chunks: list[bytes] = []
            while chunk := os.read(fd, 65536):
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            os.close(fd)

    def _unlink_regular(self, path: Path) -> None:
        """Remove a regular file while refusing symlinks and special files."""
        if path.exists() or path.is_symlink():
            self._assert_regular(path)
            path.unlink()

    @staticmethod
    def _assert_regular(path: Path) -> None:
        """Reject symlinks and non-regular filesystem entries."""
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise StoreError(f"unsafe file: {path.name}")

    @staticmethod
    def _assert_real_directory(path: Path) -> None:
        """Reject symlinked directories before traversing account data."""
        if path.is_symlink() or not path.is_dir():
            raise StoreError(f"unsafe directory: {path.name}")

    def _assert_parent(self, parent: Path) -> None:
        """Ensure all generated files remain directly under the private data tree."""
        try:
            parent.resolve(strict=True).relative_to(self.data_dir.resolve(strict=True))
        except (OSError, ValueError) as exc:
            raise StoreError("file path escaped data directory") from exc
        self._assert_real_directory(parent)

    def _account_dir(self, account_id: str) -> Path:
        """Return a validated account directory path."""
        account_id = self._validate_id(account_id)
        root = self.data_dir / "accounts"
        root.mkdir(mode=0o700, exist_ok=True)
        os.chmod(root, 0o700)
        self._assert_real_directory(root)
        path = root / account_id
        if path.exists() or path.is_symlink():
            self._assert_real_directory(path)
        return path

    @staticmethod
    def _validate_id(account_id: str) -> str:
        """Require a canonical UUID to prevent traversal and ambiguous identifiers."""
        try:
            parsed = UUID(account_id)
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError("account_id must be a UUID") from exc
        canonical = str(parsed)
        if account_id.lower() != canonical:
            raise ValueError("account_id must be a canonical UUID")
        return canonical

    def _require_key(self) -> bytes:
        """Return loaded encryption key or reject use before open()."""
        if self._key is None:
            raise StoreError("store is not open")
        return self._key

    @staticmethod
    def _is_reset(previous: UsageResult | None, current: UsageResult) -> bool:
        """Detect quota resets from usage changes or a reset boundary that has passed."""
        if previous is None:
            return False
        prior = {metric.id: metric for metric in previous.metrics if metric.kind == "quota"}
        for metric in current.metrics:
            old = prior.get(metric.id)
            if old is None or metric.kind != "quota":
                continue
            if old.resets_at and metric.resets_at:
                moved_forward = metric.resets_at - old.resets_at > timedelta(seconds=60)
                boundary_passed = current.fetched_at >= old.resets_at
                if moved_forward and boundary_passed:
                    return True
            if old.used is not None and metric.used is not None and metric.used < old.used:
                return True
            if (
                old.remaining is not None
                and metric.remaining is not None
                and metric.remaining > old.remaining
            ):
                return True
            if old.limit is not None and metric.limit is not None and metric.limit < old.limit:
                return True
        return False

    @staticmethod
    def _fsync_dir(path: Path) -> None:
        """Sync directory metadata after atomic replacement."""
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
