"""Remote MCP protocol and token-lifecycle checks over the ASGI HTTP boundary."""

import asyncio
import json
import socket
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from plan_quotas.adapters.base import BaseAdapter
from plan_quotas.app import create_app
from plan_quotas.settings import Settings


class EmptyAdapter(BaseAdapter):
    """Fail closed if any protocol operation unexpectedly triggers provider collection."""

    async def fetch(self, credentials, auth_type, client):
        """Raise when MCP accidentally makes an upstream request instead of reading cache."""
        raise AssertionError("MCP tools must read cached data only")


def _headers(token: str | None = None, *, origin: str = "http://testserver") -> dict[str, str]:
    """Build Streamable HTTP headers for the supported 2025-03-26 MCP protocol revision."""
    result = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-03-26",
        "Origin": origin,
    }
    if token:
        result["Authorization"] = f"Bearer {token}"
    return result


def _rpc(client: TestClient, token: str, method: str, request_id: int, params=None):
    """Send a standards-shaped JSON-RPC request through the real mounted HTTP endpoint."""
    return client.post(
        "/mcp",
        headers=_headers(token),
        json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
    )


def test_remote_mcp_protocol_and_isolated_rotatable_bearer_token(tmp_path: Path):
    """Exercise initialize, discovery, tool invocation, rotation, and revocation over HTTP."""
    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("test", encoding="utf-8")
    settings = Settings(
        admin_password="separate-admin-secret",
        data_dir=tmp_path / "private-data",
        allowed_hosts="testserver,localhost,127.0.0.1",
        static_dir=web_dir,
    )
    app = create_app(settings, adapters={"minimax": EmptyAdapter()}, poll=False)

    with TestClient(app, base_url="http://testserver") as client:
        # An admin password is not an MCP credential, and absent configuration is deny-by-default.
        denied = _rpc(client, "separate-admin-secret", "initialize", 1)
        assert denied.status_code == 401
        assert denied.headers.get("www-authenticate") == "Bearer"
        assert (
            client.post(
                "/mcp", headers=_headers(), json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/mcp",
                headers=_headers("x" * 64, origin="https://untrusted.invalid"),
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            ).status_code
            == 403
        )

        login = client.post("/api/admin/login", json={"password": "separate-admin-secret"})
        assert login.status_code == 200
        csrf = login.json()["csrf_token"]
        admin_headers = {"X-CSRF-Token": csrf, "Origin": "http://testserver"}
        created = client.post(
            "/api/admin/accounts",
            headers=admin_headers,
            json={
                "provider": "minimax",
                "alias": "MCP测试账号",
                "auth_type": "api_key",
                "credentials": {"api_key": "not-a-real-provider-key"},
            },
        )
        assert created.status_code == 201, created.text
        existing_account_id = created.json()["id"]
        first = client.post("/api/admin/mcp-token", headers=admin_headers)
        assert first.status_code == 200
        token1 = first.json()["token"]
        assert token1.startswith("pq_") and len(token1) > 40

        initialized = _rpc(
            client,
            token1,
            "initialize",
            1,
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "plan-quotas-acceptance", "version": "1.0"},
            },
        )
        assert initialized.status_code == 200, initialized.text
        init_body = initialized.json()
        assert init_body["jsonrpc"] == "2.0" and init_body["id"] == 1
        assert init_body["result"]["protocolVersion"] == "2025-03-26"
        assert init_body["result"]["serverInfo"]["name"] == "plan-quotas"

        listed = _rpc(client, token1, "tools/list", 2)
        assert listed.status_code == 200, listed.text
        names = {item["name"] for item in listed.json()["result"]["tools"]}
        assert names == {"list_accounts", "get_usage", "get_summary", "get_history"}

        summary = _rpc(client, token1, "tools/call", 3, {"name": "get_summary", "arguments": {}})
        assert summary.status_code == 200, summary.text
        call_body = summary.json()
        assert call_body["result"]["isError"] is False
        assert json.loads(call_body["result"]["content"][0]["text"])["total"] == 1

        invalid_uuid = _rpc(
            client,
            token1,
            "tools/call",
            30,
            {"name": "get_usage", "arguments": {"account_ids": ["not-a-uuid"]}},
        )
        assert invalid_uuid.status_code == 200
        assert invalid_uuid.json()["result"]["isError"] is True

        missing_account = _rpc(
            client,
            token1,
            "tools/call",
            31,
            {
                "name": "get_history",
                "arguments": {"account_id": "11111111-1111-4111-8111-111111111111", "range": "24h"},
            },
        )
        assert missing_account.status_code == 200
        assert missing_account.json()["result"]["isError"] is True

        invalid_range = _rpc(
            client,
            token1,
            "tools/call",
            32,
            {
                "name": "get_history",
                "arguments": {"account_id": existing_account_id, "range": "forever"},
            },
        )
        assert invalid_range.status_code == 200
        assert invalid_range.json()["result"]["isError"] is True

        # Token values are disclosed once by the admin route and are never included in settings.
        admin_settings = client.get("/api/admin/settings")
        assert admin_settings.status_code == 200
        assert admin_settings.json()["mcp_configured"] is True
        assert token1 not in admin_settings.text

        second = client.post("/api/admin/mcp-token", headers=admin_headers)
        assert second.status_code == 200
        token2 = second.json()["token"]
        assert token2 != token1
        assert _rpc(client, token1, "tools/list", 4).status_code == 401
        assert _rpc(client, token2, "tools/list", 5).status_code == 200

        revoked = client.delete("/api/admin/mcp-token", headers=admin_headers)
        assert revoked.status_code == 200
        assert _rpc(client, token2, "tools/list", 6).status_code == 401


@pytest.mark.integration
def test_official_mcp_sdk_connects_to_uvicorn_loopback(tmp_path: Path):
    """Verify the official remote client against a real local Uvicorn TCP listener."""
    import httpx
    import uvicorn
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("test", encoding="utf-8")
    settings = Settings(
        admin_password="loopback-admin-password",
        data_dir=tmp_path / "private-data",
        allowed_hosts="127.0.0.1,localhost,testserver",
        static_dir=web_dir,
        public_origin="",
    )
    admin_app = create_app(settings, adapters={}, poll=False)

    # Generate the MCP credential through the same authenticated administrator API.
    with TestClient(admin_app, base_url="http://testserver") as admin_client:
        login = admin_client.post("/api/admin/login", json={"password": "loopback-admin-password"})
        assert login.status_code == 200
        token_response = admin_client.post(
            "/api/admin/mcp-token",
            headers={"X-CSRF-Token": login.json()["csrf_token"], "Origin": "http://testserver"},
        )
        assert token_response.status_code == 200
        token = token_response.json()["token"]

    # Use a fresh app lifespan because a completed lifespan cannot be restarted safely.
    app = create_app(settings, adapters={}, poll=False)

    # Bind port zero to ask the OS for an available loopback port, then release it for Uvicorn.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]

    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="critical", lifespan="on")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            if not thread.is_alive():
                raise AssertionError("Uvicorn stopped before starting")
            time.sleep(0.025)
        assert server.started, "Uvicorn did not start within 10 seconds"

        async def exercise_client() -> None:
            """Initialize the official SDK client and invoke a read-only MCP tool."""
            base = f"http://127.0.0.1:{port}"
            async with httpx.AsyncClient(
                headers={"Authorization": f"Bearer {token}", "Origin": base},
                timeout=10,
            ) as http_client:
                async with streamable_http_client(
                    f"{base}/mcp", http_client=http_client
                ) as streams:
                    read_stream, write_stream, _ = streams
                    async with ClientSession(read_stream, write_stream) as session:
                        initialized = await session.initialize()
                        assert initialized.serverInfo.name == "plan-quotas"
                        tools = await session.list_tools()
                        assert {tool.name for tool in tools.tools} == {
                            "list_accounts",
                            "get_usage",
                            "get_summary",
                            "get_history",
                        }
                        result = await session.call_tool("get_summary", {})
                        assert result.isError is False
                        assert json.loads(result.content[0].text)["total"] == 0

        asyncio.run(exercise_client())
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        assert not thread.is_alive(), "Uvicorn loopback server did not shut down cleanly"
