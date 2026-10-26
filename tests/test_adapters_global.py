"""Mocked contract tests for overseas provider adapters."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from plan_quotas.adapters.base import AdapterError, request_json
from plan_quotas.adapters.global_providers import (
    CLAUDE_OAUTH_USAGE_URL,
    CLAUDE_ORGS_URL,
    CLAUDE_REFRESH_URL,
    CODEX_USAGE_URL,
    CURSOR_USAGE_URL,
    GOOGLE_TOKEN_URL,
    OPENAI_TOKEN_URL,
    AntigravityAdapter,
    ClaudeAdapter,
    CodexAdapter,
    CursorAdapter,
)


def mock_client(handler):
    """Create an async HTTP client backed only by a deterministic handler."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_codex_wham_maps_primary_secondary_windows_and_account_header():
    """Keep only quota fields from the Codex WHAM response."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == CODEX_USAGE_URL
        assert request.headers["Authorization"] == "Bearer access-secret"
        assert request.headers["ChatGPT-Account-Id"] == "private-account"
        return httpx.Response(
            200,
            json={
                "plan_type": "plus",
                "email": "hidden@example.com",
                "rate_limit": {
                    "primary_window": {"used_percent": 25, "reset_at": 1_800_000_000},
                    "secondary_window": {"used_percent": 0},
                },
            },
        )

    async with mock_client(handler) as client:
        result, rotated = await CodexAdapter().fetch(
            {"access_token": "access-secret", "account_id": "private-account"}, "oauth", client
        )
    assert rotated is None
    assert result.plan == "plus"
    assert [metric.remaining for metric in result.metrics] == [75, 100]
    assert all("email" not in metric.model_dump() for metric in result.metrics)


@pytest.mark.asyncio
async def test_claude_oauth_maps_windows_and_reset_times():
    """Map Claude OAuth usage windows without returning organization details."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == CLAUDE_OAUTH_USAGE_URL
        assert request.headers["Authorization"] == "Bearer claude-token"
        return httpx.Response(
            200,
            json={
                "plan": "pro",
                "organization_id": "must-not-escape",
                "five_hour": {"utilization": 12.5, "resets_at": "2030-01-01T00:00:00Z"},
                "seven_day": {"utilization": 40},
            },
        )

    async with mock_client(handler) as client:
        result, _ = await ClaudeAdapter().fetch({"access_token": "claude-token"}, "oauth", client)
    assert result.plan == "pro"
    assert [metric.used_percent for metric in result.metrics] == [12.5, 40]
    assert "must-not-escape" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_claude_cookie_discovers_organization_but_does_not_expose_it():
    """Use the first available organization internally for cookie-based usage."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Cookie"] == "sessionKey=private-cookie"
        if request.url == CLAUDE_ORGS_URL:
            return httpx.Response(200, json=[{"uuid": "org-secret", "name": "Private Org"}])
        assert request.url.path == "/api/organizations/org-secret/usage"
        return httpx.Response(200, json={"five_hour": {"utilization": 5}})

    async with mock_client(handler) as client:
        result, rotated = await ClaudeAdapter().fetch(
            {"cookie": "sessionKey=private-cookie"}, "cookie", client
        )
    assert rotated is None
    assert result.metrics[0].used_percent == 5
    assert "org-secret" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_cursor_cookie_maps_usage_summary():
    """Expose Cursor counters and cost fields from the usage-summary endpoint."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == CURSOR_USAGE_URL
        assert request.headers["Cookie"] == "WorkosCursorSessionToken=session-secret"
        return httpx.Response(
            200,
            json={
                "membershipType": "pro",
                "usage": {"gpt-4": {"numRequests": 3, "maxRequestUsage": 10}},
                "totalPrompts": 8,
                "onDemandUsage": 1.25,
                "email": "private@example.com",
            },
        )

    async with mock_client(handler) as client:
        result, rotated = await CursorAdapter().fetch(
            {"cookie": "WorkosCursorSessionToken=session-secret"}, "cookie", client
        )
    assert rotated is None
    assert result.plan == "pro"
    assert result.metrics[0].used == 3
    assert result.metrics[0].remaining == 7
    assert "private@example.com" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_cursor_usage_summary_maps_plan_percentages_and_cents():
    """Map Cursor's current individualUsage pools, on-demand cents, and billing reset."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == CURSOR_USAGE_URL
        return httpx.Response(
            200,
            json={
                "membershipType": "ultra",
                "billingCycleEnd": "2030-03-01T00:00:00Z",
                "individualUsage": {
                    "plan": {
                        "used": 1516,
                        "limit": 2000,
                        "remaining": 484,
                        "autoPercentUsed": 25.5,
                        "apiPercentUsed": 40,
                        "totalPercentUsed": 30,
                    },
                    "onDemand": {"enabled": True, "used": 275, "limit": 2500},
                },
                "privateAccountId": "must-not-escape",
            },
        )

    async with mock_client(handler) as client:
        result, _ = await CursorAdapter().fetch({"cookie": "session-cookie"}, "cookie", client)
    assert result.plan == "ultra"
    assert [metric.id for metric in result.metrics] == [
        "plan_autoPercentUsed",
        "plan_apiPercentUsed",
        "plan_totalPercentUsed",
        "included_spend",
        "on_demand",
    ]
    assert result.metrics[0].used_percent == 25.5
    assert result.metrics[0].remaining == 74.5
    assert result.metrics[1].used_percent == 40
    assert result.metrics[2].used_percent == 30
    assert result.metrics[3].used == 15.16
    assert result.metrics[3].limit == 20
    assert result.metrics[3].remaining == 4.84
    assert result.metrics[4].used == 2.75
    assert result.metrics[4].limit == 25
    assert result.metrics[4].remaining == 22.25
    assert all(metric.resets_at is not None for metric in result.metrics)
    assert "must-not-escape" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_cursor_team_on_demand_is_read_and_unrecognized_shape_fails():
    """Accept teamUsage on-demand amounts but reject successful empty metric results."""
    responses = [
        {"membershipType": "team", "teamUsage": {"onDemand": {"used": 50, "limit": 1000}}},
        {"membershipType": "unknown-plan", "individualUsage": {"onDemand": {"enabled": False}}},
    ]
    index = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal index
        body = responses[index]
        index += 1
        return httpx.Response(200, json=body)

    async with mock_client(handler) as client:
        result, _ = await CursorAdapter().fetch({"cookie": "team-cookie"}, "cookie", client)
        with pytest.raises(AdapterError) as error:
            await CursorAdapter().fetch({"cookie": "team-cookie"}, "cookie", client)
    assert result.metrics[0].id == "on_demand"
    assert result.metrics[0].used == 0.5
    assert error.value.code == "invalid_response"


@pytest.mark.asyncio
async def test_antigravity_uses_load_and_fetch_only_and_hides_model_ids():
    """Query model quotas without invoking onboarding or exposing provider identifiers."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        assert request.headers["Authorization"] == "Bearer google-token"
        if request.url.path.endswith(":loadCodeAssist"):
            assert json.loads(request.content)["metadata"]["ideType"] == "ANTIGRAVITY"
            return httpx.Response(
                200,
                json={
                    "cloudaicompanionProject": {"id": "project-secret"},
                    "paidTier": {"name": "pro", "id": "paid-tier-id"},
                    "currentTier": {"name": "standard"},
                },
            )
        assert request.url.path.endswith(":fetchAvailableModels")
        assert json.loads(request.content) == {"project": "project-secret"}
        return httpx.Response(
            200,
            json={
                "models": {
                    "gemini-secret-model": {
                        "displayName": "Gemini Flash",
                        "quotaInfo": {
                            "remainingFraction": 0.25,
                            "resetTime": "2030-02-01T00:00:00Z",
                        },
                    },
                    "internal-model": {
                        "displayName": "Internal Hidden Model",
                        "isInternal": True,
                        "quotaInfo": {"remainingFraction": 0.9},
                    },
                    "model-key-without-display-name": {
                        "model": "Fallback Model Name",
                        "quotaInfo": {"remainingFraction": 0.5},
                    },
                    "key-only-model": {"quotaInfo": {"remainingFraction": 0.1}},
                }
            },
        )

    async with mock_client(handler) as client:
        result, rotated = await AntigravityAdapter().fetch(
            {"access_token": "google-token"}, "oauth", client
        )
    assert rotated is None
    assert len(calls) == 2
    assert result.plan == "pro"
    assert [metric.id for metric in result.metrics] == [
        "gemini-secret-model",
        "model-key-without-display-name",
        "key-only-model",
    ]
    assert [metric.label for metric in result.metrics] == [
        "Gemini Flash",
        "Fallback Model Name",
        "key-only-model",
    ]
    assert result.metrics[0].remaining == 25
    encoded = json.dumps(result.model_dump(mode="json"))
    assert "gemini-secret-model" in encoded  # Stable provider key is required as the metric ID.
    assert "Internal Hidden Model" not in encoded
    assert "internal-model" not in encoded
    assert "project-secret" not in encoded
    assert not any("onboard" in call.lower() for call in calls)


@pytest.mark.asyncio
async def test_antigravity_paid_tier_string_and_metric_ids_are_stable_across_order():
    """Prefer string paidTier and retain model keys when upstream model order changes."""
    model_sets = [
        {
            "alpha-model": {"quotaInfo": {"remainingFraction": 0.2}},
            "beta-model": {"quotaInfo": {"remainingFraction": 0.8}},
        },
        {
            "beta-model": {"quotaInfo": {"remainingFraction": 0.8}},
            "alpha-model": {"quotaInfo": {"remainingFraction": 0.2}},
        },
    ]
    call_index = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_index
        if request.url.path.endswith(":loadCodeAssist"):
            return httpx.Response(200, json={"paidTier": "Ultra", "currentTier": "Basic"})
        models = model_sets[call_index % len(model_sets)]
        call_index += 1
        return httpx.Response(200, json={"models": models})

    async with mock_client(handler) as client:
        first, _ = await AntigravityAdapter().fetch({"access_token": "token"}, "oauth", client)
        second, _ = await AntigravityAdapter().fetch({"access_token": "token"}, "oauth", client)
    assert first.plan == second.plan == "Ultra"
    assert {metric.id for metric in first.metrics} == {metric.id for metric in second.metrics}


@pytest.mark.asyncio
async def test_antigravity_paid_tier_id_is_used_when_name_is_absent():
    """Fall back to the paid tier identifier when the provider omits its display name."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(":loadCodeAssist"):
            return httpx.Response(200, json={"paidTier": {"id": "tier-enterprise"}})
        return httpx.Response(
            200,
            json={"models": {"enterprise-model": {"quotaInfo": {"remainingFraction": 1}}}},
        )

    async with mock_client(handler) as client:
        result, _ = await AntigravityAdapter().fetch({"access_token": "token"}, "oauth", client)
    assert result.plan == "tier-enterprise"


@pytest.mark.asyncio
async def test_codex_refreshes_expired_oauth_once_and_returns_rotated_credentials():
    """Persist renewed OAuth credentials separately from the safe usage result."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == OPENAI_TOKEN_URL:
            assert "client_id=oauth-client" in request.content.decode()
            assert "client_secret" not in request.content.decode()
            return httpx.Response(200, json={"access_token": "new-access", "expires_in": 3600})
        assert request.url == CODEX_USAGE_URL
        assert request.headers["Authorization"] == "Bearer new-access"
        return httpx.Response(200, json={"rate_limit": {"primary_window": {"used_percent": 1}}})

    credentials = {
        "access_token": "old-access",
        "refresh_token": "refresh-secret",
        "client_id": "oauth-client",
        "expires_at": str((datetime.now(UTC) - timedelta(minutes=1)).timestamp()),
    }
    async with mock_client(handler) as client:
        result, rotated = await CodexAdapter().fetch(credentials, "oauth", client)
    assert result.metrics[0].used_percent == 1
    assert rotated is not None
    assert rotated["access_token"] == "new-access"
    assert rotated["refresh_token"] == "refresh-secret"
    assert "new-access" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_claude_refresh_uses_json_and_public_client_fields():
    """Send Claude refresh fields as JSON without requiring a client secret."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == CLAUDE_REFRESH_URL:
            payload = json.loads(request.content)
            assert payload == {
                "grant_type": "refresh_token",
                "refresh_token": "claude-refresh",
                "client_id": "claude-client",
            }
            return httpx.Response(200, json={"access_token": "claude-new", "expires_in": 1200})
        assert request.url == CLAUDE_OAUTH_USAGE_URL
        assert request.headers["Authorization"] == "Bearer claude-new"
        return httpx.Response(200, json={"five_hour": {"utilization": 2}})

    credentials = {
        "access_token": "expired",
        "refresh_token": "claude-refresh",
        "client_id": "claude-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        result, rotated = await ClaudeAdapter().fetch(credentials, "oauth", client)
    assert result.metrics[0].used_percent == 2
    assert rotated is not None and rotated["access_token"] == "claude-new"


@pytest.mark.asyncio
async def test_rotated_tokens_are_attached_if_usage_request_fails_after_refresh():
    """Make refreshed credentials available to the service even if quota polling fails."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == OPENAI_TOKEN_URL:
            return httpx.Response(
                200, json={"access_token": "rotated-access", "refresh_token": "rotated-refresh"}
            )
        return httpx.Response(429, headers={"Retry-After": "15"}, text="private response body")

    credentials = {
        "access_token": "expired",
        "refresh_token": "old-refresh",
        "client_id": "codex-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "rate_limited"
    assert error.value.rotated_credentials["refresh_token"] == "rotated-refresh"
    assert "private response body" not in str(error.value)


@pytest.mark.asyncio
async def test_antigravity_refreshes_with_supplied_google_client_fields():
    """Use only supplied Google OAuth client fields when refreshing credentials."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == GOOGLE_TOKEN_URL:
            payload = request.content.decode()
            assert "actual-client-secret" in payload
            return httpx.Response(
                200,
                json={
                    "access_token": "renewed-google",
                    "refresh_token": "renewed-refresh",
                    "expires_in": 1800,
                },
            )
        assert request.headers["Authorization"] == "Bearer renewed-google"
        if request.url.path.endswith(":loadCodeAssist"):
            return httpx.Response(200, json={})
        return httpx.Response(
            200, json={"models": {"gemini": {"quotaInfo": {"remainingFraction": 0.5}}}}
        )

    credentials = {
        "access_token": "expired",
        "refresh_token": "google-refresh",
        "client_id": "provided-client",
        "client_secret": "actual-client-secret",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        result, rotated = await AntigravityAdapter().fetch(credentials, "oauth", client)
    assert result.metrics[0].remaining == 50
    assert rotated is not None
    assert rotated["refresh_token"] == "renewed-refresh"


@pytest.mark.asyncio
async def test_missing_refresh_fields_fails_safely_without_refresh_attempt():
    """Reject expired imported OAuth credentials when refresh parameters are absent."""

    def handler(request: httpx.Request) -> httpx.Response:
        pytest.fail(f"unexpected network request to {request.url.host}")

    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(
                {"access_token": "old", "expires_at": "2000-01-01T00:00:00Z"}, "oauth", client
            )
    assert error.value.code == "auth_required"
    assert "old" not in str(error.value)


@pytest.mark.asyncio
async def test_refresh_failure_does_not_leak_upstream_body_or_secrets():
    """Collapse rejected refresh responses to a safe authentication error."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == OPENAI_TOKEN_URL:
            return httpx.Response(401, text="refresh-token-secret invalid")
        pytest.fail("usage request must not follow failed refresh")

    credentials = {
        "access_token": "old",
        "refresh_token": "refresh-token-secret",
        "client_id": "client",
        "client_secret": "client-secret",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "auth_required"
    assert "secret" not in str(error.value)


@pytest.mark.asyncio
async def test_oauth_refresh_rate_limit_preserves_retry_after_and_safe_error_code():
    """Keep token-endpoint throttling retryable instead of permanently pausing auth."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == OPENAI_TOKEN_URL:
            return httpx.Response(
                429,
                headers={"Retry-After": "37"},
                text="refresh-secret should never escape",
            )
        pytest.fail("usage request must not run after a limited refresh")

    credentials = {
        "access_token": "expired",
        "refresh_token": "refresh-secret",
        "client_id": "codex-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "rate_limited"
    assert error.value.retry_after == 37
    assert "refresh-secret" not in str(error.value)


@pytest.mark.asyncio
async def test_successful_refresh_with_malformed_token_response_is_not_auth_required():
    """Treat an empty successful token response as schema drift rather than bad login."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "private"})

    credentials = {
        "access_token": "expired",
        "refresh_token": "refresh-secret",
        "client_id": "codex-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "invalid_response"
    assert "private" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("oauth_error", "expected_code"),
    [
        ("invalid_grant", "auth_required"),
        ("invalid_client", "auth_required"),
        ("unauthorized_client", "auth_required"),
        ("invalid_scope", "upstream_error"),
    ],
)
async def test_oauth_token_400_classifies_only_known_credentials_errors(
    oauth_error: str, expected_code: str
):
    """Classify only allowlisted OAuth 400 codes and never expose their response body."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": oauth_error, "error_description": "private-secret-detail"},
        )

    credentials = {
        "access_token": "expired",
        "refresh_token": "refresh-token",
        "client_id": "codex-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == expected_code
    assert "private-secret-detail" not in str(error.value)


@pytest.mark.asyncio
async def test_non_oauth_400_behavior_is_unchanged():
    """Keep ordinary provider 400 responses as upstream errors."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant", "secret": "private"})

    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await request_json(client, "GET", "https://provider.example/usage")
    assert error.value.code == "upstream_error"
    assert "private" not in str(error.value)


@pytest.mark.asyncio
async def test_oauth_refresh_network_and_server_failures_keep_retryable_codes():
    """Preserve network and transient server errors from token refresh safely."""
    for expected_code, response in (
        ("network_error", None),
        ("upstream_error", httpx.Response(503, text="secret server detail")),
    ):

        def handler(
            request: httpx.Request, response: httpx.Response | None = response
        ) -> httpx.Response:
            if response is None:
                raise httpx.ConnectError("refresh-token-secret")
            return response

        credentials = {
            "access_token": "expired",
            "refresh_token": "refresh-secret",
            "client_id": "codex-client",
            "expires_at": "2000-01-01T00:00:00Z",
        }
        async with mock_client(handler) as client:
            with pytest.raises(AdapterError) as error:
                await CodexAdapter().fetch(credentials, "oauth", client)
        assert error.value.code == expected_code
        assert "secret" not in str(error.value)


@pytest.mark.asyncio
async def test_refreshed_credentials_survive_claude_non_object_usage_response():
    """Attach a completed Claude token rotation when the usage payload is malformed."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == CLAUDE_REFRESH_URL:
            return httpx.Response(
                200,
                json={"access_token": "new-claude", "refresh_token": "new-claude-refresh"},
            )
        return httpx.Response(200, json=["malformed"])

    credentials = {
        "access_token": "expired",
        "refresh_token": "old-claude-refresh",
        "client_id": "claude-client",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await ClaudeAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "invalid_response"
    assert error.value.rotated_credentials["refresh_token"] == "new-claude-refresh"


@pytest.mark.asyncio
async def test_empty_usage_metrics_are_invalid_and_preserve_rotated_tokens():
    """Reject empty Codex, Claude, and Antigravity data while retaining rotations."""
    cases = (
        (CodexAdapter(), OPENAI_TOKEN_URL, CODEX_USAGE_URL, {"rate_limit": {}}, "oauth"),
        (ClaudeAdapter(), CLAUDE_REFRESH_URL, CLAUDE_OAUTH_USAGE_URL, {}, "oauth"),
    )
    for adapter, token_url, usage_url, payload, auth_type in cases:

        def handler(
            request: httpx.Request,
            token_url: str = token_url,
            usage_url: str = usage_url,
            payload: dict = payload,
        ) -> httpx.Response:
            if request.url == token_url:
                return httpx.Response(
                    200, json={"access_token": "new-token", "refresh_token": "new-refresh"}
                )
            assert request.url == usage_url
            return httpx.Response(200, json=payload)

        credentials = {
            "access_token": "expired",
            "refresh_token": "old-refresh",
            "client_id": "provider-client",
            "expires_at": "2000-01-01T00:00:00Z",
        }
        async with mock_client(handler) as client:
            with pytest.raises(AdapterError) as error:
                await adapter.fetch(credentials, auth_type, client)
        assert error.value.code == "invalid_response"
        assert error.value.rotated_credentials["refresh_token"] == "new-refresh"

    def antigravity_handler(request: httpx.Request) -> httpx.Response:
        if request.url == GOOGLE_TOKEN_URL:
            return httpx.Response(
                200, json={"access_token": "new-google", "refresh_token": "new-google-refresh"}
            )
        if request.url.path.endswith(":loadCodeAssist"):
            return httpx.Response(200, json={})
        return httpx.Response(200, json={"models": {}})

    async with mock_client(antigravity_handler) as client:
        with pytest.raises(AdapterError) as error:
            await AntigravityAdapter().fetch(
                {
                    "access_token": "expired",
                    "refresh_token": "old-google-refresh",
                    "client_id": "google-client",
                    "client_secret": "google-secret",
                    "expires_at": "2000-01-01T00:00:00Z",
                },
                "oauth",
                client,
            )
    assert error.value.code == "invalid_response"
    assert error.value.rotated_credentials["refresh_token"] == "new-google-refresh"


@pytest.mark.asyncio
async def test_antigravity_second_rotation_is_not_overwritten_by_load_rotation():
    """Keep the newest token rotation when the second Google RPC fails after refresh."""
    refresh_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal refresh_count
        if request.url == GOOGLE_TOKEN_URL:
            refresh_count += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"access-{refresh_count}",
                    "refresh_token": f"refresh-{refresh_count}",
                    "expires_in": 3600,
                },
            )
        if request.url.path.endswith(":loadCodeAssist"):
            return httpx.Response(200, json={})
        if request.headers["Authorization"] == "Bearer access-1":
            return httpx.Response(401, text="expired access-1")
        return httpx.Response(429, headers={"Retry-After": "20"}, text="private details")

    credentials = {
        "access_token": "expired",
        "refresh_token": "refresh-0",
        "client_id": "google-client",
        "client_secret": "google-secret",
        "expires_at": "2000-01-01T00:00:00Z",
    }
    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await AntigravityAdapter().fetch(credentials, "oauth", client)
    assert error.value.code == "rate_limited"
    assert refresh_count == 2
    assert error.value.rotated_credentials["refresh_token"] == "refresh-2"


@pytest.mark.asyncio
async def test_missing_required_payload_fields_returns_safe_invalid_response():
    """Reject malformed responses without including provider payload content."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == CODEX_USAGE_URL:
            return httpx.Response(200, json={"rate_limit": "malformed-secret"})
        pytest.fail("unexpected endpoint")

    async with mock_client(handler) as client:
        with pytest.raises(AdapterError) as error:
            await CodexAdapter().fetch({"access_token": "token"}, "oauth", client)
    assert error.value.code == "invalid_response"
    assert "malformed-secret" not in str(error.value)
