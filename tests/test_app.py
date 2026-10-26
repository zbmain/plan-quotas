"""End-to-end HTTP checks for the public and administrator application surfaces."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from plan_quotas.adapters.base import BaseAdapter
from plan_quotas.app import create_app
from plan_quotas.models import Metric, UsageResult
from plan_quotas.settings import Settings
from plan_quotas.storage import StoreError


@pytest.mark.parametrize("layout", ["data_under_assets", "same_root", "web_under_data", "symlink"])
def test_private_data_cannot_overlap_public_static_files(tmp_path: Path, layout: str):
    """Reject unsafe deployment paths before creating keys or mounting public assets."""
    public = tmp_path / "web"
    private = tmp_path / "private"
    if layout == "data_under_assets":
        private = public / "assets"
    elif layout == "same_root":
        private = public
    elif layout == "web_under_data":
        public = private / "web"
    else:
        public.mkdir()
        private.symlink_to(public / "assets", target_is_directory=True)
    with pytest.raises(StoreError, match="non-overlapping"):
        create_app(Settings(data_dir=private, static_dir=public), poll=False)
    assert not (private / "master.key").exists()


class FakeAdapter(BaseAdapter):
    """Return deterministic quota data while recording calls for HTTP assertions."""

    def __init__(self) -> None:
        """Initialize a single successful response and request counter."""
        self.calls = 0

    async def fetch(self, credentials, auth_type, client):
        """Return metrics with both known and unknown values for serialization tests."""
        self.calls += 1
        secret = next(iter(credentials.values()), "")
        return (
            UsageResult(
                plan="测试套餐",
                source="fake",
                fetched_at=datetime.now(UTC),
                metrics=[
                    Metric(
                        id="weekly",
                        label=f"额度 {secret}" if secret else "周额度",
                        used=3,
                        limit=10,
                        remaining=7,
                        used_percent=30,
                        window="本周",
                    ),
                    Metric(id="unknown", label="未知额度", used=None, limit=None, remaining=None),
                ],
            ),
            None,
        )


class RotatingOAuthAdapter(BaseAdapter):
    """Return a refreshed OAuth bundle and retain each credential set observed."""

    def __init__(self) -> None:
        """Initialize the credential capture list used by rotation assertions."""
        self.seen: list[dict[str, str]] = []

    async def fetch(self, credentials, auth_type, client):
        """Return safe usage and a rotated access/refresh token pair."""
        self.seen.append(dict(credentials))
        return (
            UsageResult(plan="OAuth", source="fake", metrics=[Metric(id="q", label="额度")]),
            {
                **credentials,
                "access_token": "rotated-access-secret",
                "refresh_token": "rotated-refresh-secret",
            },
        )


class SecretFailureAdapter(BaseAdapter):
    """Raise an exception carrying a secret to check the HTTP error boundary."""

    async def fetch(self, credentials, auth_type, client):
        """Raise a deliberately unsafe message that must be reduced to a fixed code."""
        raise RuntimeError(f"upstream leaked {next(iter(credentials.values()))}")


class ConcurrencyAdapter(BaseAdapter):
    """Track simultaneous provider requests made by connection tests and polling."""

    def __init__(self) -> None:
        """Initialize active-request counters for the shared limiter assertion."""
        self.active = 0
        self.peak = 0

    async def fetch(self, credentials, auth_type, client):
        """Hold a request slot briefly so concurrent callers overlap measurably."""
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(0.03)
            return UsageResult(source="concurrency-test"), None
        finally:
            self.active -= 1


@pytest.fixture
def http_app(tmp_path: Path):
    """Run the complete FastAPI lifespan with isolated disk storage and fake provider."""
    web_dir = tmp_path / "web"
    (web_dir / "assets").mkdir(parents=True)
    (web_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
    (web_dir / "assets" / "app.js").write_text("console.log('test')", encoding="utf-8")
    adapter = FakeAdapter()
    settings = Settings(
        admin_password="admin-test-password",
        data_dir=tmp_path / "private-data",
        allowed_hosts="testserver,localhost,127.0.0.1",
        static_dir=web_dir,
    )
    app = create_app(settings, adapters={"minimax": adapter}, poll=False)
    with TestClient(app, base_url="http://testserver") as client:
        yield client, adapter, settings


def _login(client: TestClient) -> str:
    """Log in and return the synchronizer token used by administrator writes."""
    response = client.post("/api/admin/login", json={"password": "admin-test-password"})
    assert response.status_code == 200
    assert response.cookies.get("pq_session")
    return response.json()["csrf_token"]


def _admin_headers(csrf: str) -> dict[str, str]:
    """Build same-origin headers for state-changing administrator requests."""
    return {"X-CSRF-Token": csrf, "Origin": "http://testserver"}


def test_anonymous_admin_routes_are_rejected(http_app):
    """Every private administrator read and write requires an authenticated session."""
    client, _, _ = http_app
    assert client.get("/api/admin/session").status_code == 401
    assert client.get("/api/admin/accounts").status_code == 401
    assert client.post("/api/admin/accounts", json={}).status_code == 401
    assert client.patch("/api/admin/settings", json={"interval_minutes": 10}).status_code == 401
    assert client.post("/api/admin/mcp-token").status_code == 401


def test_login_cookie_csrf_origin_and_login_rate_limit(http_app):
    """Login issues a scoped HttpOnly cookie; mutations need CSRF and trusted origin."""
    client, _, _ = http_app
    response = client.post("/api/admin/login", json={"password": "admin-test-password"})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert "path=/api/admin" in cookie

    csrf = response.json()["csrf_token"]
    assert client.patch("/api/admin/settings", json={"interval_minutes": 10}).status_code == 403
    assert (
        client.patch(
            "/api/admin/settings",
            json={"interval_minutes": 10},
            headers={"X-CSRF-Token": csrf, "Origin": "https://attacker.invalid"},
        ).status_code
        == 403
    )
    updated = client.patch(
        "/api/admin/settings", json={"interval_minutes": 10}, headers=_admin_headers(csrf)
    )
    assert updated.status_code == 200
    assert updated.json()["interval_minutes"] == 10

    client.post("/api/admin/logout", headers=_admin_headers(csrf))
    assert client.get("/api/admin/session").status_code == 401

    for _ in range(5):
        failed = client.post("/api/admin/login", json={"password": "wrong-password"})
        assert failed.status_code == 401
    throttled = client.post("/api/admin/login", json={"password": "wrong-password"})
    assert throttled.status_code == 429


def test_public_dashboard_and_validation_never_echo_credentials(http_app):
    """Public data uses a narrow allowlist and validation errors suppress input values."""
    client, _, _ = http_app
    providers = client.get("/api/public/providers")
    assert providers.status_code == 200
    assert {item["id"] for item in providers.json()} >= {"minimax", "glm", "codex"}
    assert "opencode" not in {item["id"] for item in providers.json()}

    dashboard = client.get("/api/public/dashboard")
    assert dashboard.status_code == 200
    assert dashboard.json()["accounts"] == []
    assert dashboard.json()["summary"]["total"] == 0

    secret = "must-never-echo-this-input"
    invalid = client.post("/api/admin/login", json={"password": secret, "unexpected": secret})
    assert invalid.status_code == 422
    assert secret not in invalid.text

    invalid_account = client.post(
        "/api/admin/accounts",
        json={
            "provider": "minimax",
            "alias": secret,
            "auth_type": "api_key",
            "credentials": {"api_key": secret, "arbitrary_url": secret},
        },
    )
    assert invalid_account.status_code == 401  # Authentication runs before payload validation.
    assert secret not in invalid_account.text


def test_account_crud_credentials_refresh_and_unknown_values(http_app):
    """Configured accounts can be managed while public/admin responses hide credentials."""
    client, adapter, settings = http_app
    csrf = _login(client)
    secret = "minimax-fake-api-key"
    headers = _admin_headers(csrf)
    created = client.post(
        "/api/admin/accounts",
        headers=headers,
        json={
            "provider": "minimax",
            "alias": "工作账号",
            "auth_type": "api_key",
            "credentials": {"api_key": secret},
        },
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    UUID(account_id)

    admin_accounts = client.get("/api/admin/accounts").json()
    assert len(admin_accounts) == 1
    assert admin_accounts[0]["credential_configured"] is True
    assert admin_accounts[0]["credential_keys"] == ["api_key"]
    assert admin_accounts[0]["verification"] == "verified"
    assert secret not in str(admin_accounts)

    refreshed = client.post(f"/api/admin/accounts/{account_id}/refresh", headers=headers)
    assert refreshed.status_code == 200
    assert refreshed.json() == {"ok": True, "status": "ok"}
    assert adapter.calls == 1

    dashboard = client.get("/api/public/dashboard").json()
    public = dashboard["accounts"][0]
    serialized = str(dashboard)
    assert public["alias"] == "工作账号"
    assert public["status"] == "ok"
    assert "auth_type" not in public and "credential_keys" not in public
    assert secret not in serialized
    metrics = public["data"]["metrics"]
    assert metrics[0]["label"] == "额度 [已隐藏]"
    assert metrics[1]["used"] is None and metrics[1]["limit"] is None
    assert dashboard["summary"]["healthy"] == 1

    updated = client.patch(
        f"/api/admin/accounts/{account_id}", headers=headers, json={"alias": "个人账号"}
    )
    assert updated.status_code == 200
    assert updated.json()["alias"] == "个人账号"
    assert client.get("/api/public/accounts/not-a-uuid/history").status_code == 422
    assert client.get(f"/api/public/accounts/{account_id}/history?range=all").status_code == 422

    deleted = client.delete(f"/api/admin/accounts/{account_id}", headers=headers)
    assert deleted.status_code == 200
    assert client.get("/api/public/dashboard").json()["accounts"] == []
    assert not (settings.data_dir / "accounts" / account_id).exists()


def test_verification_is_limited_to_real_provider_auth_pairs(http_app):
    """A successful mock or unsupported auth method never claims provider verification."""
    client, _, _ = http_app
    headers = _admin_headers(_login(client))
    for auth_type, credentials in (
        ("api_key", {"api_key": "verified-pair-key"}),
        ("cookie", {"cookie": "session=unverified"}),
    ):
        created = client.post(
            "/api/admin/accounts",
            headers=headers,
            json={
                "provider": "minimax",
                "alias": f"{auth_type}账号",
                "auth_type": auth_type,
                "credentials": credentials,
            },
        )
        assert created.status_code == 201
    entries = client.get("/api/admin/accounts").json()
    verification = {item["auth_type"]: item["verification"] for item in entries}
    assert verification == {"api_key": "verified", "cookie": "not_tested"}


def test_private_files_and_path_traversal_are_not_web_assets(http_app):
    """Private deployment files and encoded traversal attempts never become responses."""
    client, _, settings = http_app
    (settings.data_dir / "probe.txt").write_text("private-marker", encoding="utf-8")
    (settings.data_dir / ".env").write_text("ADMIN_PASSWORD=private-marker", encoding="utf-8")
    secret_paths = [
        "/.env",
        "/master.key",
        "/secrets.enc",
        "/config.json",
        "/private-data/master.key",
        "/assets/../.env",
        "/assets/%2e%2e/%2e%2e/private-data/probe.txt",
    ]
    for path in secret_paths:
        response = client.get(path)
        assert response.status_code in {400, 404}, (path, response.status_code, response.text)
        assert "private-marker" not in response.text

    assert client.get("/").status_code == 200
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/healthz").json() == {"status": "ok"}


def test_oauth_connection_rotation_is_reused_when_account_is_saved(tmp_path: Path):
    """A successful OAuth test carries rotated credentials into a subsequent account save."""
    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("test", encoding="utf-8")
    adapter = RotatingOAuthAdapter()
    app = create_app(
        Settings(
            admin_password="admin-test-password",
            data_dir=tmp_path / "data",
            allowed_hosts="testserver",
            static_dir=web_dir,
        ),
        adapters={"codex": adapter},
        poll=False,
    )
    with TestClient(app, base_url="http://testserver") as client:
        csrf = _login(client)
        headers = _admin_headers(csrf)
        original = {
            "access_token": "original-access-secret",
            "refresh_token": "original-refresh-secret",
        }
        tested = client.post(
            "/api/admin/test",
            headers=headers,
            json={"provider": "codex", "auth_type": "oauth", "credentials": original},
        )
        assert tested.status_code == 200, tested.text
        assert adapter.seen[0] == original
        assert "rotated-access-secret" not in tested.text
        assert "rotated-refresh-secret" not in tested.text

        created = client.post(
            "/api/admin/accounts",
            headers=headers,
            json={
                "provider": "codex",
                "alias": "OAuth账号",
                "auth_type": "oauth",
                "credentials": original,
            },
        )
        assert created.status_code == 201, created.text
        account_id = created.json()["id"]
        refreshed = client.post(f"/api/admin/accounts/{account_id}/refresh", headers=headers)
        assert refreshed.status_code == 200
        assert adapter.seen[-1] == {
            **original,
            "access_token": "rotated-access-secret",
            "refresh_token": "rotated-refresh-secret",
        }


def test_connection_errors_and_credential_validation_are_secret_safe(http_app):
    """Unknown adapter failures, unsupported auth and arbitrary endpoint fields fail safely."""
    client, _, _ = http_app
    csrf = _login(client)
    headers = _admin_headers(csrf)
    secret = "do-not-return-this-secret"
    invalid_auth = client.post(
        "/api/admin/test",
        headers=headers,
        json={"provider": "minimax", "auth_type": "oauth", "credentials": {"access_token": secret}},
    )
    assert invalid_auth.status_code == 400
    assert secret not in invalid_auth.text

    invalid_field = client.post(
        "/api/admin/test",
        headers=headers,
        json={
            "provider": "minimax",
            "auth_type": "api_key",
            "credentials": {"api_key": secret, "url": "https://attacker.invalid"},
        },
    )
    assert invalid_field.status_code == 400
    assert secret not in invalid_field.text


def test_unexpected_connection_exception_does_not_echo_secret(tmp_path: Path):
    """Connection test failures expose a fixed error code rather than exception messages."""
    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("test", encoding="utf-8")
    app = create_app(
        Settings(
            admin_password="admin-test-password",
            data_dir=tmp_path / "data",
            allowed_hosts="testserver",
            static_dir=web_dir,
        ),
        adapters={"minimax": SecretFailureAdapter()},
        poll=False,
    )
    with TestClient(app, base_url="http://testserver") as client:
        csrf = _login(client)
        secret = "adapter-error-secret"
        response = client.post(
            "/api/admin/test",
            headers=_admin_headers(csrf),
            json={
                "provider": "minimax",
                "auth_type": "api_key",
                "credentials": {"api_key": secret},
            },
        )
        assert response.status_code == 502
        assert response.json() == {"detail": "invalid_response"}
        assert secret not in response.text


@pytest.mark.asyncio
async def test_connection_test_and_polling_share_four_request_slots(tmp_path: Path):
    """Admin connection tests and background polling share the global concurrency cap."""
    import httpx

    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("test", encoding="utf-8")
    adapter = ConcurrencyAdapter()
    app = create_app(
        Settings(
            admin_password="concurrency-admin-password",
            data_dir=tmp_path / "data",
            allowed_hosts="testserver",
            static_dir=web_dir,
        ),
        adapters={"minimax": adapter},
        poll=False,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            login = await client.post(
                "/api/admin/login", json={"password": "concurrency-admin-password"}
            )
            assert login.status_code == 200
            headers = {
                "X-CSRF-Token": login.json()["csrf_token"],
                "Origin": "http://testserver",
            }
            created = await client.post(
                "/api/admin/accounts",
                headers=headers,
                json={
                    "provider": "minimax",
                    "alias": "轮询账号",
                    "auth_type": "api_key",
                    "credentials": {"api_key": "integration-key"},
                },
            )
            assert created.status_code == 201
            account_id = created.json()["id"]
            tests = [
                client.post(
                    "/api/admin/test",
                    headers=headers,
                    json={
                        "provider": "minimax",
                        "auth_type": "api_key",
                        "credentials": {"api_key": f"test-key-{index}"},
                    },
                )
                for index in range(4)
            ]
            polling = app.state.service.refresh(account_id)
            responses = await asyncio.gather(*tests, polling)
            assert all(response.status_code == 200 for response in responses[:4])
            assert responses[4].status == "ok"
            assert adapter.peak == 4
            assert adapter.peak <= 4


def test_request_size_host_and_origin_boundaries(http_app):
    """Reject oversized payloads and requests using an untrusted host or browser origin."""
    client, _, _ = http_app
    oversized = client.post(
        "/api/admin/login",
        content=b"x" * 131073,
        headers={"Content-Type": "application/json"},
    )
    assert oversized.status_code == 413
    assert client.get("/healthz", headers={"Host": "attacker.invalid"}).status_code == 400
    assert (
        client.get(
            "/api/public/dashboard", headers={"Origin": "https://attacker.invalid"}
        ).status_code
        == 403
    )
