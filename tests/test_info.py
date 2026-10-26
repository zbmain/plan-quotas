"""Access-control and redaction tests for the optional /info JSON endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from plan_quotas.adapters.base import BaseAdapter
from plan_quotas.app import create_app
from plan_quotas.models import Metric, UsageResult
from plan_quotas.security import InfoPasswordAuth, InfoQueryRedactor
from plan_quotas.settings import Settings


def _settings(tmp_path: Path) -> Settings:
    """Build an isolated settings object for an end-to-end /info app."""
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html></html>", encoding="utf-8")
    return Settings(
        admin_password="admin-test-password",
        data_dir=tmp_path / "data",
        static_dir=web,
        allowed_hosts="testserver,localhost,127.0.0.1",
    )


def _admin(client: TestClient) -> dict[str, str]:
    """Log in to the test admin and return its write-only CSRF header."""
    login = client.post("/api/admin/login", json={"password": "admin-test-password"})
    assert login.status_code == 200
    return {"X-CSRF-Token": login.json()["csrf_token"], "Origin": "http://testserver"}


@pytest.fixture
def app_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Use a low test-only KDF cost with a private temporary store and no poller."""
    monkeypatch.setattr(InfoPasswordAuth, "_ITERATIONS", 10_000)
    application = create_app(_settings(tmp_path), poll=False)
    with TestClient(application, base_url="http://testserver") as client:
        yield client, application


def test_info_is_open_by_default_returns_the_public_dashboard_and_never_refreshes(app_client):
    """Keep the no-password default, public allowlist and cached-only behavior."""
    client, application = app_client
    response = client.get("/info")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.json() == client.get("/api/public/dashboard").json()
    assert client.get("/info/?password=ignored").json() == response.json()


def test_info_password_setting_requires_admin_and_csrf_and_hides_hash(app_client):
    """Require the admin session to configure the independent optional password."""
    client, application = app_client
    assert client.get("/api/admin/info-settings").status_code == 401
    assert (
        client.patch("/api/admin/info-settings", json={"require_password": False}).status_code
        == 401
    )
    headers = _admin(client)
    assert client.get("/api/admin/info-settings").json() == {
        "require_password": False,
        "password_configured": False,
    }
    assert (
        client.patch(
            "/api/admin/info-settings",
            json={"require_password": True},
            headers={"Origin": "http://testserver"},
        ).status_code
        == 403
    )
    not_configured = client.patch(
        "/api/admin/info-settings", json={"require_password": True}, headers=headers
    )
    assert not_configured.status_code == 400
    secret = "private-query-secret"
    configured = client.patch(
        "/api/admin/info-settings",
        json={"require_password": True, "password": secret},
        headers=headers,
    )
    assert configured.status_code == 200
    assert configured.json() == {"require_password": True, "password_configured": True}
    assert secret not in configured.text
    assert secret not in application.state.store.config.model_dump_json()
    assert application.state.store.config.info_password_hash != "admin-test-password"

    denied = client.get("/info")
    assert denied.status_code == 401
    assert denied.headers["cache-control"] == "no-store"
    assert secret not in denied.text
    assert client.get("/info?password=wrong-secret").status_code == 401
    success = client.get("/info?password=private-query-secret")
    assert success.status_code == 200
    assert success.headers["referrer-policy"] == "no-referrer"
    assert success.json() == client.get("/api/public/dashboard").json()


def test_info_password_rotation_and_disabled_mode(app_client):
    """Preserve omitted passwords, rotate explicitly, and keep the hash on disable."""
    client, application = app_client
    headers = _admin(client)
    assert (
        client.patch(
            "/api/admin/info-settings",
            json={"require_password": True, "password": "first-query-secret"},
            headers=headers,
        ).status_code
        == 200
    )
    first_hash = application.state.store.config.info_password_hash
    blank = client.patch(
        "/api/admin/info-settings",
        json={"require_password": True, "password": ""},
        headers=headers,
    )
    assert blank.status_code == 200
    assert application.state.store.config.info_password_hash == first_hash
    assert client.get("/info?password=first-query-secret").status_code == 200

    assert (
        client.patch(
            "/api/admin/info-settings",
            json={"require_password": True, "password": "second-query-secret"},
            headers=headers,
        ).status_code
        == 200
    )
    assert application.state.store.config.info_password_hash != first_hash
    assert client.get("/info?password=first-query-secret").status_code == 401
    assert client.get("/info?password=second-query-secret").status_code == 200

    assert (
        client.patch(
            "/api/admin/info-settings", json={"require_password": False}, headers=headers
        ).status_code
        == 200
    )
    assert application.state.store.config.info_password_hash
    assert client.get("/info").status_code == 200
    assert client.get("/api/admin/info-settings").json() == {
        "require_password": False,
        "password_configured": True,
    }


def test_info_password_configuration_survives_app_restart(tmp_path: Path, monkeypatch):
    """Persist the password mode and salted hash in the regular atomic config file."""
    monkeypatch.setattr(InfoPasswordAuth, "_ITERATIONS", 10_000)
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, poll=False), base_url="http://testserver") as client:
        headers = _admin(client)
        configured = client.patch(
            "/api/admin/info-settings",
            json={"require_password": True, "password": "restart-query-secret"},
            headers=headers,
        )
        assert configured.status_code == 200
    with TestClient(create_app(settings, poll=False), base_url="http://testserver") as restarted:
        assert restarted.get("/info").status_code == 401
        assert restarted.get("/info?password=restart-query-secret").status_code == 200


def test_info_password_attempts_are_rate_limited(app_client):
    """Reject repeated incorrect passwords from one peer after five attempts."""
    client, _ = app_client
    headers = _admin(client)
    assert (
        client.patch(
            "/api/admin/info-settings",
            json={"require_password": True, "password": "right-secret"},
            headers=headers,
        ).status_code
        == 200
    )
    for _ in range(5):
        assert client.get("/info?password=wrong-secret").status_code == 401
    assert client.get("/info?password=wrong-secret").status_code == 429


@pytest.mark.asyncio
async def test_concurrent_info_password_checks_cannot_bypass_the_attempt_limit(monkeypatch):
    """Serialize parallel KDF checks so only five failures pass the rolling limiter."""
    import asyncio

    monkeypatch.setattr(InfoPasswordAuth, "_ITERATIONS", 10_000)
    auth = InfoPasswordAuth()
    password_hash = await asyncio.to_thread(auth.hash_password, "correct-password")
    outcomes = await asyncio.gather(
        *(auth.verify(password_hash, "wrong-password", "same-peer") for _ in range(12)),
        return_exceptions=True,
    )

    assert sum(outcome is False for outcome in outcomes) == 5
    throttled = [outcome for outcome in outcomes if isinstance(outcome, Exception)]
    assert len(throttled) == 7
    assert all(getattr(outcome, "status_code", None) == 429 for outcome in throttled)


@pytest.mark.asyncio
async def test_info_query_redactor_erases_every_query_before_downstream_logging():
    """Scrub known and unknown query values from path variants and every response status."""
    captured = {}
    messages = []

    async def inner(scope, receive, send):
        """Record only the scope state an inner router and its server logger can observe."""
        captured["path"] = scope["path"]
        captured["raw_path"] = scope["raw_path"]
        captured["query"] = scope["query_string"]
        captured["password"] = scope["state"]["info_query_password"]
        await send({"type": "http.response.start", "status": 404, "headers": []})
        await send({"type": "http.response.body", "body": b"missing"})

    async def capture(message):
        """Collect ASGI response messages without exposing their request URL."""
        messages.append(message)

    async def no_receive():
        """Stand in for a GET receive callable without an incoming request body."""
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/info/private",
        "raw_path": b"/info/private?password=raw-secret&arbitrary=raw-marker",
        "query_string": b"password=raw-secret&arbitrary=raw-marker",
        "headers": [],
        "state": {},
    }
    await InfoQueryRedactor(inner)(scope, no_receive, capture)
    assert captured == {
        "path": "/info/private",
        "raw_path": b"/info/private",
        "query": b"",
        "password": "raw-secret",
    }
    assert all(b"raw-secret" not in str(message).encode() for message in messages)
    headers = dict(messages[0]["headers"])
    assert headers[b"cache-control"] == b"no-store"
    assert headers[b"referrer-policy"] == b"no-referrer"


@pytest.mark.asyncio
async def test_info_query_redactor_rejects_duplicate_passwords_and_sanitizes_redirects():
    """Treat duplicate password parameters as invalid and redact queries before redirects."""
    captured = {}
    messages = []

    async def redirect(scope, receive, send):
        """Record safe state and return a redirect-like response without reflecting its URL."""
        captured.update(scope["state"])
        await send({"type": "http.response.start", "status": 307, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def capture(message):
        """Collect response headers for the middleware-only test."""
        messages.append(message)

    async def no_receive():
        """Return an empty request for the middleware-only test."""
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/info/",
        "raw_path": b"/info/?password=one&password=two",
        "query_string": b"password=one&password=two",
        "headers": [],
        "state": {},
    }
    await InfoQueryRedactor(redirect)(scope, no_receive, capture)
    assert captured["info_query_password"] is None
    assert captured["info_query_invalid"] is True
    assert scope["query_string"] == b""
    assert all(b"one" not in str(message).encode() for message in messages)


class CountingAdapter(BaseAdapter):
    """Return one deterministic metric and count provider requests."""

    def __init__(self):
        """Initialize the provider request counter."""
        self.calls = 0

    async def fetch(self, credentials, auth_type, client):
        """Return a safe fake result while counting actual upstream calls."""
        self.calls += 1
        return UsageResult(
            plan="测试套餐", source="fake", metrics=[Metric(id="q", label="额度", used=2, limit=10)]
        ), None


def test_info_reads_cached_account_usage_without_provider_calls(tmp_path: Path, monkeypatch):
    """Confirm /info serves configured account snapshots without fetching providers."""
    monkeypatch.setattr(InfoPasswordAuth, "_ITERATIONS", 10_000)
    adapter = CountingAdapter()
    application = create_app(_settings(tmp_path), adapters={"minimax": adapter}, poll=False)
    with TestClient(application, base_url="http://testserver") as client:
        headers = _admin(client)
        created = client.post(
            "/api/admin/accounts",
            headers=headers,
            json={
                "provider": "minimax",
                "alias": "缓存账号",
                "auth_type": "api_key",
                "credentials": {"api_key": "upstream-secret"},
            },
        )
        assert created.status_code == 201
        account_id = created.json()["id"]
        assert adapter.calls == 0

        empty_info = client.get("/info")
        assert empty_info.status_code == 200
        assert adapter.calls == 0

        refreshed = client.post(f"/api/admin/accounts/{account_id}/refresh", headers=headers)
        assert refreshed.status_code == 200
        assert adapter.calls == 1
        snapshot = client.get("/api/public/dashboard").json()
        info = client.get("/info")
        assert info.status_code == 200
        assert info.json() == snapshot
        assert info.json()["accounts"][0]["alias"] == "缓存账号"
        assert "upstream-secret" not in info.text
        assert adapter.calls == 1


def test_real_uvicorn_access_logs_never_include_info_query_strings(tmp_path: Path):
    """Exercise Uvicorn itself to prove query values disappear from access logs."""
    import io
    import logging
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    application = create_app(_settings(tmp_path), poll=False)
    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host="127.0.0.1",
            port=0,
            log_config=None,
            access_log=True,
            lifespan="on",
        )
    )
    listening = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listening.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listening.bind(("127.0.0.1", 0))
    except PermissionError:
        listening.close()
        pytest.skip("sandbox policy prevents starting a local Uvicorn listener")
    listening.listen(128)
    listening.setblocking(False)
    server_port = listening.getsockname()[1]
    server_thread = threading.Thread(
        target=server.run, kwargs={"sockets": [listening]}, daemon=True
    )
    log_output = io.StringIO()
    access_logger = logging.getLogger("uvicorn.access")
    handler = logging.StreamHandler(log_output)
    previous_level = access_logger.level
    previous_propagate = access_logger.propagate
    access_logger.setLevel(logging.INFO)
    access_logger.propagate = True
    access_logger.addHandler(handler)
    server_thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and server_thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        info_password = "uvicorn-info-secret"
        application.state.store.save_config(
            application.state.store.config.model_copy(
                update={
                    "info_require_password": True,
                    "info_password_hash": InfoPasswordAuth.hash_password(info_password),
                }
            )
        )
        with httpx.Client(base_url=f"http://127.0.0.1:{server_port}") as client:
            assert (
                client.get("/info?password=access-secret&unknown=unknown-secret").status_code == 401
            )
            assert client.get("/info?password=wrong-secret").status_code == 401
            assert client.get(f"/info?password={info_password}").status_code == 200
            assert (
                client.get("/info/not-found?password=404-secret&unknown=404-marker").status_code
                == 404
            )
            assert client.post("/info?password=405-secret&unknown=405-marker").status_code == 404
            assert (
                client.get("/info//?password=redirect-secret&unknown=redirect-marker").status_code
                == 404
            )
    finally:
        server.should_exit = True
        server_thread.join(timeout=5)
        access_logger.removeHandler(handler)
        handler.close()
        access_logger.setLevel(previous_level)
        access_logger.propagate = previous_propagate
        listening.close()

    output = log_output.getvalue()
    for secret in (
        "access-secret",
        "unknown-secret",
        "404-secret",
        "404-marker",
        "405-secret",
        "405-marker",
        "redirect-secret",
        "redirect-marker",
        "wrong-secret",
        "uvicorn-info-secret",
    ):
        assert secret not in output
    assert "?" not in output
    assert 'GET /info HTTP/1.1" 200' in output
    assert 'GET /info HTTP/1.1" 401' in output
    assert 'GET /info/not-found HTTP/1.1" 404' in output
