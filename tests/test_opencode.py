"""OpenCode contract checks using synthetic values in upstream-documented response shapes."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from plan_quotas.adapters.base import AdapterError
from plan_quotas.adapters.opencode import (
    OPENCODE_BILLING_URL,
    OPENCODE_GO_STATUS_URL,
    OPENCODE_USAGE_URL,
    OpenCodeAdapter,
)
from plan_quotas.catalog import validate_credentials
from plan_quotas.registry import build_adapters

NOW = datetime(2030, 1, 1, tzinfo=UTC)
END = "2030-01-31T00:00:00Z"
COOKIE = {"cookie": "__Host-console_session=sample-cookie", "workspace_id": "wrk_SAMPLE"}


@pytest.fixture
def console_payload():
    """Reproduce the Console meters contract without real workspace or billing information."""
    return {
        "access": {
            "endsAt": END,
            "meters": {
                "fiveHour": {
                    "usedMicroCents": "300000000",
                    "limitMicroCents": "1200000000",
                    "resetsAt": None,
                },
                "week": {
                    "usedMicroCents": "1200000000",
                    "limitMicroCents": "3000000000",
                    "resetsAt": "2030-01-07T00:00:00Z",
                },
                "month": {"usedMicroCents": "600000000", "limitMicroCents": "6000000000"},
            },
        }
    }


@pytest.mark.asyncio
async def test_go_key_reads_percentage_units_and_preserves_overage(monkeypatch):
    """Use the new official route, keep 0.5 as 0.5%, and preserve independent resets."""
    monkeypatch.setattr("plan_quotas.adapters.opencode.utc_now", lambda: NOW)

    def handler(request):
        """Assert that only the Go key is sent to the fixed usage endpoint."""
        assert str(request.url) == OPENCODE_USAGE_URL
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer sample-go-key"
        assert "cookie" not in request.headers and "x-org-id" not in request.headers
        return httpx.Response(
            200,
            json={
                "usage": {
                    "rolling": {"percent": 0.5, "resetsAt": "2030-01-01T04:00:00Z"},
                    "weekly": {"percent": 25, "resetInSec": 86400},
                    "monthly": {"percent": 120},
                },
                "privateAccount": "must-not-be-public",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, rotated = await OpenCodeAdapter().fetch(
            {"api_key": "sample-go-key"}, "api_key", client
        )
    assert rotated is None and result.plan == "OpenCode Go"
    assert result.fetched_at == NOW
    assert [m.used_percent for m in result.metrics] == [0.5, 25, 120]
    assert [m.remaining for m in result.metrics] == [99.5, 75, 0]
    assert [m.window for m in result.metrics] == ["5h", "week", "month"]
    assert [m.resets_at for m in result.metrics] == [
        NOW + timedelta(hours=4),
        NOW + timedelta(days=1),
        None,
    ]
    assert "must-not-be-public" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_console_reads_scoped_meters_and_separate_prepaid_balance(console_payload):
    """Derive percentages from micro-cents, using the billing end only for the monthly meter."""
    paths = []

    def handler(request):
        """Keep the explicit workspace scope on both Console reads without Bearer authentication."""
        paths.append(str(request.url))
        assert request.headers["cookie"] == COOKIE["cookie"]
        assert request.headers["x-org-id"] == COOKIE["workspace_id"]
        assert "authorization" not in request.headers
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, json=console_payload)
        assert str(request.url) == OPENCODE_BILLING_URL
        return httpx.Response(
            200,
            json={
                "billingMode": "prepaid",
                "mode": "pay-as-you-go",
                "balanceMicroCents": "2786781005",
                "availableMicroCents": "999999999999",
                "privateAccount": "must-not-be-public",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await OpenCodeAdapter().fetch(COOKIE, "cookie", client)
    assert paths == [OPENCODE_GO_STATUS_URL, OPENCODE_BILLING_URL]
    assert [m.used_percent for m in result.metrics[:3]] == [25, 40, 10]
    assert result.metrics[0].resets_at is None
    assert result.metrics[1].resets_at == datetime(2030, 1, 7, tzinfo=UTC)
    assert result.metrics[2].resets_at == datetime(2030, 1, 31, tzinfo=UTC)
    assert result.metrics[3].kind == "balance"
    assert result.metrics[3].currency == "USD"
    assert result.metrics[3].remaining == pytest.approx(27.86781005)
    serialized = result.model_dump_json()
    assert all(value not in serialized for value in (*COOKIE.values(), "must-not-be-public"))


@pytest.mark.asyncio
async def test_optional_balance_failure_keeps_valid_go_observations(console_payload):
    """A failed optional billing request cannot erase successfully collected subscription quotas."""

    def handler(request):
        """Return healthy subscription meters and an independently limited billing endpoint."""
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, json=console_payload)
        return httpx.Response(429, headers={"Retry-After": "60"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await OpenCodeAdapter().fetch(COOKIE, "cookie", client)
    assert len(result.metrics) == 3
    assert all(m.kind == "quota" for m in result.metrics)


@pytest.mark.asyncio
@pytest.mark.parametrize("status_payload", [None, {"access": None}])
@pytest.mark.parametrize("balance", ["0", "-100000000"])
async def test_balance_only_accounts_preserve_zero_and_negative_values(status_payload, balance):
    """A supported prepaid account without Go can still expose its signed balance without a plan."""

    def handler(request):
        """Return a valid absence of subscription and a real zero or negative balance shape."""
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, content=json.dumps(status_payload))
        return httpx.Response(
            200,
            json={"billingMode": "prepaid", "mode": "pay-as-you-go", "balanceMicroCents": balance},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await OpenCodeAdapter().fetch(COOKIE, "cookie", client)
    assert result.plan is None
    assert len(result.metrics) == 1
    assert result.metrics[0].remaining == int(balance) / 100_000_000


@pytest.mark.asyncio
@pytest.mark.parametrize("billing_mode", ["credit", "seat", "legacy"])
async def test_non_prepaid_modes_are_not_reported_as_wallet_balance(billing_mode):
    """Exclude invoice or credit billing modes even if a balance-like field is present."""

    def handler(request):
        """Return no Go subscription and a billing mode that has no supported wallet balance."""
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, json={"access": None})
        return httpx.Response(
            200,
            json={"billingMode": billing_mode, "mode": "pay-as-you-go", "balanceMicroCents": "100"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError, match="subscription_unavailable"):
            await OpenCodeAdapter().fetch(COOKIE, "cookie", client)


@pytest.mark.asyncio
async def test_credit_does_not_replace_missing_prepaid_balance():
    """Reject missing balance fields instead of substituting available credits."""

    def handler(request):
        """Return only an available-credit field on an otherwise supported prepaid response."""
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, json={"access": None})
        return httpx.Response(
            200,
            json={"billingMode": "prepaid", "mode": "pay-as-you-go", "availableMicroCents": "100"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError, match="invalid_response"):
            await OpenCodeAdapter().fetch(COOKIE, "cookie", client)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "auth_required"), (403, "subscription_unavailable"), (429, "rate_limited")],
)
async def test_go_auth_entitlement_and_rate_limit_errors_are_distinct(status, code):
    """An unavailable Go entitlement is different from an invalid key or upstream throttling."""

    def handler(request):
        """Return a private upstream error body that must never appear in the safe exception."""
        return httpx.Response(
            status, json={"message": "private-error-body"}, headers={"Retry-After": "17"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError, match=code) as exc:
            await OpenCodeAdapter().fetch({"api_key": "sample"}, "api_key", client)
    assert "private-error-body" not in str(exc.value)
    if status == 429:
        assert exc.value.retry_after == 17


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"usage": {}},
        {"usage": {"rolling": "bad"}},
        {"usage": {"rolling": {"percent": True}}},
    ],
)
async def test_malformed_usage_is_not_a_zero_quota(payload):
    """Fail clearly on changed usage schemas instead of synthesizing a healthy zero observation."""
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=json.dumps(payload)))
    ) as client:
        with pytest.raises(AdapterError, match="invalid_response"):
            await OpenCodeAdapter().fetch({"api_key": "sample"}, "api_key", client)


@pytest.mark.asyncio
async def test_unknown_windows_and_zero_limits_remain_unknown(console_payload):
    """Missing percentages and zero denominators do not become 0% used or 100% remaining."""
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"usage": {"rolling": {"percent": None}}})
        )
    ) as client:
        result, _ = await OpenCodeAdapter().fetch({"api_key": "sample"}, "api_key", client)
    assert result.metrics[0].used_percent is None and result.metrics[0].remaining is None
    console_payload["access"]["meters"]["fiveHour"]["limitMicroCents"] = "0"

    def handler(request):
        """Provide zero quota and an optional unsupported balance mode."""
        if str(request.url) == OPENCODE_GO_STATUS_URL:
            return httpx.Response(200, json=console_payload)
        return httpx.Response(200, json={"mode": "invoiceable", "billingMode": "credit"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await OpenCodeAdapter().fetch(COOKIE, "cookie", client)
    assert result.metrics[0].used_percent is None and result.metrics[0].remaining is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "credentials", [{"cookie": "sample"}, {**COOKIE, "workspace_id": "https://evil.test"}]
)
async def test_cookie_reads_require_an_explicit_safe_workspace(credentials):
    """Never infer an arbitrary workspace or use a user-supplied URL to send credentials."""

    def handler(request):
        """Reject any attempted network access before local credential validation succeeds."""
        raise AssertionError("must not make a request")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError, match="invalid_credentials"):
            await OpenCodeAdapter().fetch(credentials, "cookie", client)


def test_opencode_registration_accepts_only_its_declared_credentials():
    """Register the provider for Web, info and MCP collection without arbitrary endpoint inputs."""
    assert isinstance(build_adapters()["opencode"], OpenCodeAdapter)
    validate_credentials("opencode", "api_key", {"api_key": "sample"})
    validate_credentials("opencode", "cookie", COOKIE)
    with pytest.raises(AdapterError, match="invalid_credentials"):
        validate_credentials(
            "opencode", "api_key", {"api_key": "sample", "base_url": "https://evil.test"}
        )
