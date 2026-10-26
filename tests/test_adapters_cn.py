"""中国区渠道适配器的无账号 HTTP 契约测试。"""

import httpx
import pytest

from plan_quotas.adapters.base import AdapterError
from plan_quotas.adapters.china import (
    DEEPSEEK_URL,
    GLM_URL,
    MINIMAX_URL,
    DeepSeekAdapter,
    GLMAdapter,
    MiniMaxAdapter,
)


@pytest.mark.asyncio
async def test_minimax_parses_remaining_percent_and_skips_non_coding_models() -> None:
    """MiniMax metrics retain provider percentages and relative reset durations."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == MINIMAX_URL
        assert request.headers["Authorization"] == "Bearer sample-key"
        return httpx.Response(
            200,
            json={
                "base_resp": {"status_code": 0},
                "current_subscribe_title": "Coding Plan",
                "model_remains": [
                    {
                        "model_name": "general",
                        "current_interval_remaining_percent": 75,
                        "remains_time": 3_600_000,
                        "current_weekly_remaining_percent": 0,
                    },
                    {"model_name": "video", "current_interval_remaining_percent": 10},
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, rotated = await MiniMaxAdapter().fetch({"api_key": "sample-key"}, "api_key", client)

    assert rotated is None
    assert result.plan == "Coding Plan"
    assert len(result.metrics) == 2
    assert result.metrics[0].remaining == 75
    assert result.metrics[0].used_percent == 25
    assert result.metrics[0].window == "5h"
    assert result.metrics[0].resets_at is not None
    assert result.metrics[1].remaining == 0
    assert result.metrics[1].used_percent == 100


@pytest.mark.asyncio
async def test_minimax_accepts_cookie_auth_without_echoing_it() -> None:
    """MiniMax cookie authentication is sent only to its fixed provider URL."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == MINIMAX_URL
        assert request.headers["Cookie"] == "session=sample"
        return httpx.Response(
            200,
            json={
                "model_remains": [
                    {"current_interval_remaining_percent": 50},
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await MiniMaxAdapter().fetch({"cookie": "session=sample"}, "cookie", client)

    assert result.metrics[0].used_percent == 50


@pytest.mark.asyncio
async def test_minimax_business_error_is_safe_auth_error() -> None:
    """MiniMax HTTP 200 business errors do not expose upstream messages."""

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"base_resp": {"status_code": 1004, "status_msg": "private upstream detail"}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError) as caught:
            await MiniMaxAdapter().fetch({"api_key": "sample"}, "api_key", client)

    assert caught.value.code == "auth_required"
    assert "private upstream detail" not in str(caught.value)


@pytest.mark.asyncio
async def test_glm_preserves_over_limit_percentage_and_separate_windows() -> None:
    """GLM limit values and overage percentages are preserved as returned."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == GLM_URL
        assert request.headers["Authorization"] == "Bearer glm-key"
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "limits": [
                        {
                            "type": "TOKENS_LIMIT",
                            "unit": 3,
                            "number": 5,
                            "usage": 100,
                            "currentValue": 123,
                            "percentage": 123,
                            "nextResetTime": 1790000000000,
                        },
                        {"type": "TOKENS_LIMIT", "unit": 6, "number": 1},
                        {"type": "TIME_LIMIT", "usage": 1000, "remaining": 900},
                    ]
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await GLMAdapter().fetch({"api_key": "glm-key"}, "api_key", client)

    assert [metric.window for metric in result.metrics] == ["5h", "week", "monthly"]
    assert result.metrics[0].used == 123
    assert result.metrics[0].used_percent == 123
    assert result.metrics[0].resets_at is not None
    assert result.metrics[1].used is None
    assert result.metrics[2].used == 100
    assert result.metrics[2].remaining == 900


@pytest.mark.asyncio
async def test_deepseek_keeps_currency_balances_separate() -> None:
    """DeepSeek total, granted and topped-up balances remain separate by currency."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == DEEPSEEK_URL
        assert request.headers["Authorization"] == "Bearer ds-key"
        return httpx.Response(
            200,
            json={
                "is_available": True,
                "balance_infos": [
                    {
                        "currency": "CNY",
                        "total_balance": "110.00",
                        "granted_balance": "10.00",
                        "topped_up_balance": "100.00",
                    },
                    {
                        "currency": "USD",
                        "total_balance": "3.50",
                        "granted_balance": "0",
                        "topped_up_balance": "3.50",
                    },
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result, _ = await DeepSeekAdapter().fetch({"api_key": "ds-key"}, "api_key", client)

    assert len(result.metrics) == 6
    assert result.metrics[0].currency == "CNY"
    assert result.metrics[0].remaining == 110
    assert result.metrics[1].remaining == 10
    assert result.metrics[3].currency == "USD"
    assert result.metrics[3].remaining == 3.5


@pytest.mark.asyncio
async def test_deepseek_missing_optional_amounts_stay_unknown() -> None:
    """Missing DeepSeek balance components are omitted instead of converted to zero."""

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"balance_infos": [{"currency": "CNY"}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AdapterError) as caught:
            await DeepSeekAdapter().fetch({"api_key": "ds-key"}, "api_key", client)

    assert caught.value.code == "invalid_response"
