"""Mocked contract tests for Kimi, Volcengine, and Bailian provider adapters."""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest

from plan_quotas.adapters.base import AdapterError
from plan_quotas.adapters.china_extra import (
    ALIYUN_GATEWAY_URL,
    KIMI_API_KEY_USAGE_URL,
    KIMI_SUBSCRIPTION_URL,
    KIMI_USAGE_URL,
    VOLCENGINE_ACTION,
    VOLCENGINE_HOST,
    AliyunAdapter,
    KimiAdapter,
    VolcengineAdapter,
)


def mock_client(handler):
    """Create an async HTTP client that cannot contact external services."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_kimi_jwt_maps_coding_period_and_rate_limit_windows():
    """Keep Kimi coding quota windows and omit unrelated account fields."""
    token = (
        "header.eyJkZXZpY2VfaWQiOiJkZXZpY2UiLCJzc2lkIjoic2Vzc2lvbiIs"
        "InN1YiI6InRyYWZmaWMifQ.signature"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == KIMI_USAGE_URL:
            assert request.headers["Authorization"] == f"Bearer {token}"
            assert request.headers["x-msh-device-id"] == "device"
            assert json.loads(request.content) == {"scope": ["FEATURE_CODING"]}
            return httpx.Response(
                200,
                json={
                    "email": "private@example.invalid",
                    "usages": [
                        {
                            "scope": "FEATURE_CODING",
                            "detail": {
                                "used": 20,
                                "limit": 100,
                                "remaining": 80,
                                "resetTime": "2030-01-01T00:00:00Z",
                            },
                            "limits": [
                                {
                                    "window": {"duration": 300, "timeUnit": "MINUTE"},
                                    "detail": {"used": "5", "limit": "20", "remaining": "15"},
                                },
                                {
                                    "window": {"duration": 10080, "timeUnit": "MINUTE"},
                                    "detail": {"used": 10, "limit": 100, "remaining": 90},
                                },
                            ],
                        }
                    ],
                },
            )
        if request.url == KIMI_SUBSCRIPTION_URL:
            return httpx.Response(200, json={"subscription": {"goods": {"title": "Kimi Code"}}})
        pytest.fail(f"Unexpected endpoint: {request.url}")

    async with mock_client(handler) as client:
        result, rotated = await KimiAdapter().fetch({"jwt": token}, "jwt", client)
    assert rotated is None
    assert result.plan == "Kimi Code"
    assert [metric.id for metric in result.metrics] == ["limit_0", "coding", "limit_1"]
    assert [metric.used_percent for metric in result.metrics] == [25, 20, 10]
    assert [metric.window for metric in result.metrics] == ["5h", "7d", "7d"]
    assert "private@example.invalid" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_kimi_cookie_extracts_session_and_unknown_quota_values_stay_unknown():
    """Accept a Kimi cookie and avoid turning missing quota values into zero."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == KIMI_USAGE_URL:
            assert request.headers["Authorization"] == "Bearer session-secret"
            return httpx.Response(
                200,
                json={
                    "usages": [{"scope": "FEATURE_CODING", "detail": {"used": None, "limit": None}}]
                },
            )
        if request.url == KIMI_SUBSCRIPTION_URL:
            return httpx.Response(200, json={})
        pytest.fail(f"Unexpected endpoint: {request.url}")

    async with mock_client(handler) as client:
        result, _ = await KimiAdapter().fetch(
            {"cookie": "kimi-auth=session-secret; other=value"}, "cookie", client
        )
    assert len(result.metrics) == 1
    assert result.metrics[0].used is None
    assert result.metrics[0].limit is None
    assert "session-secret" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_kimi_coding_api_key_exposes_quota_and_limits():
    """Use the Kimi Coding endpoint and expose its top-level and window quotas."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == KIMI_API_KEY_USAGE_URL
        assert request.headers["Authorization"] == "Bearer api-key-secret"
        return httpx.Response(
            200,
            json={
                "usage": {
                    "limit": 1000,
                    "used": 125,
                    "remaining": 875,
                    "resetTime": "2030-01-01T00:00:00Z",
                },
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "MINUTE"},
                        "detail": {"limit": 100, "used": 25, "remaining": 75},
                    },
                    {
                        "window": {"duration": 10080, "timeUnit": "MINUTE"},
                        "detail": {"limit": 500, "used": 125, "remaining": 375},
                    },
                ],
                "email": "private@example.invalid",
            },
        )

    async with mock_client(handler) as client:
        result, _ = await KimiAdapter().fetch({"api_key": "api-key-secret"}, "api_key", client)
    assert [metric.id for metric in result.metrics] == ["limit_0", "coding", "limit_1"]
    assert [metric.used for metric in result.metrics] == [25, 125, 125]
    assert [metric.used_percent for metric in result.metrics] == [25, 12.5, 25]
    assert "private@example.invalid" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_type", ["api_key", "jwt", "cookie"])
@pytest.mark.parametrize(
    ("duration", "time_unit"),
    [("300", "TIME_UNIT_MINUTE"), (5, "TIME_UNIT_HOUR"), (18000, "TIME_UNIT_SECOND")],
)
async def test_kimi_real_counter_shape_keeps_five_hour_and_weekly_usage_separate(
    auth_type, duration, time_unit
):
    """Regress the observed 12% / 2% account and keep each window's own reset boundary."""
    weekly = {"limit": "100", "used": "2", "remaining": "98", "resetTime": "2030-11-02T03:26:41Z"}
    limits = [
        {
            "window": {"duration": duration, "timeUnit": time_unit},
            "detail": {
                "limit": "100",
                "used": "12",
                "remaining": "88",
                "resetTime": "2030-10-26T14:26:41Z",
            },
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        """Serve equivalent API-key and browser-session envelopes without real credentials."""
        if request.url == KIMI_API_KEY_USAGE_URL:
            return httpx.Response(200, json={"usage": weekly, "limits": limits})
        if request.url == KIMI_USAGE_URL:
            return httpx.Response(
                200,
                json={"usages": [{"scope": "FEATURE_CODING", "detail": weekly, "limits": limits}]},
            )
        if request.url == KIMI_SUBSCRIPTION_URL:
            return httpx.Response(200, json={})
        pytest.fail(f"Unexpected endpoint: {request.url}")

    async with mock_client(handler) as client:
        result, _ = await KimiAdapter().fetch({auth_type: "test-only-secret"}, auth_type, client)
    short, long = result.metrics
    assert (short.id, short.label, short.window, short.used_percent) == (
        "limit_0",
        "5 小时用量",
        "5h",
        12,
    )
    assert (long.id, long.label, long.window, long.used_percent) == ("coding", "7 天用量", "7d", 2)
    assert short.resets_at.isoformat() == "2030-10-26T14:26:41+00:00"
    assert long.resets_at.isoformat() == "2030-11-02T03:26:41+00:00"
    assert "test-only-secret" not in result.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "window", [None, {}, {"duration": 0, "timeUnit": "TIME_UNIT_MINUTE"}, {"duration": 300}]
)
async def test_kimi_unknown_window_does_not_turn_into_five_hours(window):
    """A missing or unusable window must not acquire a guessed duration or false percentage."""

    def handler(request: httpx.Request) -> httpx.Response:
        """Return incomplete upstream quota details while preserving the observed zero."""
        return httpx.Response(
            200, json={"usage": {"used": 0}, "limits": [{"window": window, "detail": {"used": 0}}]}
        )

    async with mock_client(handler) as client:
        result, _ = await KimiAdapter().fetch({"api_key": "test-only-secret"}, "api_key", client)
    unknown = next(metric for metric in result.metrics if metric.id == "limit_0")
    assert unknown.window is None
    assert unknown.used == 0
    assert unknown.used_percent is None
    assert unknown.remaining is None
    assert unknown.label == "调用额度"


@pytest.mark.asyncio
async def test_volcengine_signed_request_maps_only_documented_percent_windows():
    """Send the Ark GetCodingPlanUsage signed request and map quota percentages."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == VOLCENGINE_HOST
        assert request.url.params["Action"] == VOLCENGINE_ACTION
        assert request.url.params["Version"] == "2024-01-01"
        assert request.method == "POST"
        assert request.headers["Host"] == VOLCENGINE_HOST
        assert request.headers["X-Content-Sha256"]
        assert request.headers["Authorization"].startswith("HMAC-SHA256 Credential=test-ak/")
        assert request.content == b"{}"
        return httpx.Response(
            200,
            json={
                "Result": {
                    "Status": "Running",
                    "UpdateTimestamp": 1_800_000_000,
                    "QuotaUsage": [
                        {"Level": "session", "Percent": 25.5, "ResetTimestamp": 1_800_000_300},
                        {"Level": "weekly", "Percent": 10, "ResetTimestamp": 1_800_100_000},
                        {"Level": "monthly", "Percent": 0, "ResetTimestamp": 0},
                    ],
                    "AccountID": "private-account",
                }
            },
        )

    async with mock_client(handler) as client:
        result, _ = await VolcengineAdapter().fetch(
            {"access_key": "test-ak", "secret_key": "test-sk"}, "aksk", client
        )
    assert [metric.id for metric in result.metrics] == ["session", "weekly", "monthly"]
    assert [metric.used_percent for metric in result.metrics] == [25.5, 10, 0]
    assert [metric.remaining for metric in result.metrics] == [74.5, 90, 100]
    assert result.metrics[2].resets_at is None
    assert "private-account" not in json.dumps(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_volcengine_rejects_unrecognized_response_without_guessing_metrics():
    """Fail closed when the Ark API no longer returns its documented quota windows."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"Result": {"Status": "Running", "Total": 100}})

    async with mock_client(handler) as client:
        with pytest.raises(AdapterError, match="invalid_response"):
            await VolcengineAdapter().fetch(
                {"access_key": "test-ak", "secret_key": "test-sk"}, "aksk", client
            )


@pytest.mark.asyncio
async def test_aliyun_cookie_uses_supplied_sec_token_and_keeps_multiple_windows():
    """Query the Bailian gateway with the supplied session token and quota windows."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == ALIYUN_GATEWAY_URL
        assert (
            request.headers["Cookie"]
            == "loginTicket=session-secret; currentRegionId=cn-shanghai; cna=anon"
        )
        form = parse_qs(request.content.decode())
        assert form["region"] == ["cn-shanghai"]
        assert form["sec_token"] == ["csrf-secret"]
        params = json.loads(form["params"][0])
        assert params["Api"].endswith("queryCodingPlanInstanceInfoV2")
        return httpx.Response(
            200,
            json={
                "code": "200",
                "data": {
                    "success": True,
                    "DataV2": {
                        "ret": ["SUCCESS::OK"],
                        "data": {
                            "failed": False,
                            "data": {
                                "userId": "private-user",
                                "codingPlanInstanceInfos": [
                                    {
                                        "instanceName": "Coding Plan Pro",
                                        "instanceId": "private-instance",
                                        "codingPlanQuotaInfo": {
                                            "per5HourUsedQuota": 50,
                                            "per5HourTotalQuota": 200,
                                            "per5HourQuotaNextRefreshTime": 1_900_000_000_000,
                                            "perWeekUsedQuota": 100,
                                            "perWeekTotalQuota": 1000,
                                            "perWeekQuotaNextRefreshTime": 1_900_000_000_000,
                                            "perBillMonthUsedQuota": None,
                                            "perBillMonthTotalQuota": None,
                                        },
                                    }
                                ],
                            },
                        },
                    },
                },
            },
        )

    async with mock_client(handler) as client:
        result, rotated = await AliyunAdapter().fetch(
            {
                "cookie": "loginTicket=session-secret; currentRegionId=cn-shanghai; cna=anon",
                "sec_token": "csrf-secret",
            },
            "cookie",
            client,
        )
    assert rotated is None
    assert result.plan == "Coding Plan Pro"
    assert [metric.id for metric in result.metrics] == ["five_hour", "weekly"]
    assert [metric.used_percent for metric in result.metrics] == [25, 10]
    encoded = json.dumps(result.model_dump(mode="json"))
    assert "session-secret" not in encoded
    assert "csrf-secret" not in encoded
    assert "private-user" not in encoded
    assert "private-instance" not in encoded


@pytest.mark.asyncio
async def test_aliyun_extracts_sec_token_from_fixed_console_html():
    """Obtain a CSRF token from the official page when it is absent in the cookie."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host == "bailian.console.aliyun.com":
            assert request.headers["Cookie"] == "loginTicket=session-secret"
            return httpx.Response(
                200,
                text='<html><script>window.config={"sec_token":"extracted-token"}</script></html>',
            )
        assert request.url == ALIYUN_GATEWAY_URL
        assert parse_qs(request.content.decode())["sec_token"] == ["extracted-token"]
        return httpx.Response(
            200,
            json={
                "code": "200",
                "data": {
                    "success": True,
                    "DataV2": {
                        "ret": ["SUCCESS::OK"],
                        "data": {
                            "failed": False,
                            "data": {"codingPlanInstanceInfos": [{"codingPlanQuotaInfo": {}}]},
                        },
                    },
                },
            },
        )

    async with mock_client(handler) as client:
        result, _ = await AliyunAdapter().fetch(
            {"cookie": "loginTicket=session-secret"}, "cookie", client
        )
    assert calls == ["bailian.console.aliyun.com", "bailian-cs.console.aliyun.com"]
    assert result.metrics == []
