"""Kimi, Volcengine and Alibaba Cloud Bailian usage adapters."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, unquote

import httpx

from plan_quotas.adapters.base import (
    AdapterError,
    BaseAdapter,
    number,
    request_json,
    require,
    timestamp,
)
from plan_quotas.models import Metric, UsageResult

KIMI_USAGE_URL = "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages"
KIMI_SUBSCRIPTION_URL = (
    "https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription"
)
KIMI_API_KEY_USAGE_URL = "https://api.kimi.com/coding/v1/usages"
ALIYUN_CONSOLE_URL = "https://bailian.console.aliyun.com"
ALIYUN_GATEWAY_URL = (
    "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway"
    "&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&_v=undefined"
)
ALIYUN_API = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2"
VOLCENGINE_HOST = "open.volcengineapi.com"
VOLCENGINE_REGION = "cn-beijing"
VOLCENGINE_SERVICE = "ark"
VOLCENGINE_ACTION = "GetCodingPlanUsage"
VOLCENGINE_VERSION = "2024-01-01"


def _as_dict(value: Any) -> dict[str, Any]:
    """Return a mapping or signal that an upstream response is malformed."""
    if not isinstance(value, dict):
        raise AdapterError("invalid_response")
    return value


def _jwt_claims(token: str) -> dict[str, Any]:
    """Decode public JWT claims for Kimi's required request correlation headers."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        claims = json.loads(decoded)
        return claims if isinstance(claims, dict) else {}
    except (IndexError, ValueError, UnicodeError, json.JSONDecodeError):
        return {}


def _cookie_value(cookie: str, names: tuple[str, ...]) -> str | None:
    """Read a named cookie value without reflecting it in errors or results."""
    for item in cookie.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key in names and value:
            return value
    return None


def _quota_metric(
    metric_id: str,
    label: str,
    detail: dict[str, Any],
    *,
    window: str | None = None,
) -> Metric:
    """Map a provider quota detail while preserving unknown values as unknown."""
    used = number(detail.get("used"))
    limit = number(detail.get("limit"))
    remaining = number(detail.get("remaining"))
    if remaining is None and used is not None and limit is not None:
        remaining = max(limit - used, 0)
    percent = used / limit * 100 if used is not None and limit and limit > 0 else None
    return Metric(
        id=metric_id,
        label=label,
        unit="quota",
        used=used,
        limit=limit,
        remaining=remaining,
        used_percent=percent,
        window=window,
        resets_at=timestamp(detail.get("resetTime") or detail.get("reset_time")),
    )


def _kimi_token(credentials: dict[str, str], auth_type: str) -> str:
    """Resolve an API key, JWT, or Kimi session token from the declared auth type."""
    if auth_type == "api_key":
        return require(credentials, "api_key")
    if auth_type == "jwt":
        return require(credentials, "jwt")
    if auth_type == "cookie":
        cookie = require(credentials, "cookie")
        return _cookie_value(cookie, ("kimi-auth", "kimi-auth-prod")) or cookie
    raise AdapterError("invalid_credentials")


class KimiAdapter(BaseAdapter):
    """Collect Kimi coding quotas from its API-key or browser-session endpoint."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Fetch Kimi metrics using a fixed official endpoint for each credential kind."""
        token = _kimi_token(credentials, auth_type)
        if auth_type == "api_key":
            # Kimi Coding API keys use the /coding/v1/usages route; Moonshot's
            # general balance API does not describe Coding Plan subscription quota.
            data = _as_dict(
                await request_json(
                    client,
                    "GET",
                    KIMI_API_KEY_USAGE_URL,
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                )
            )
            usage = data.get("usage")
            if not isinstance(usage, dict):
                raise AdapterError("invalid_response")
            metrics: list[Metric] = []
            metrics.append(_quota_metric("coding", "Coding Plan", usage, window="套餐周期"))
            limits = data.get("limits")
            if isinstance(limits, list):
                for index, limit in enumerate(limits):
                    if not isinstance(limit, dict) or not isinstance(limit.get("detail"), dict):
                        continue
                    window_data = limit.get("window")
                    if isinstance(window_data, dict):
                        duration = window_data.get("duration")
                        unit = window_data.get("timeUnit")
                    else:
                        duration, unit = None, None
                    window = f"{duration} {unit}" if duration and unit else "速率窗口"
                    metrics.append(
                        _quota_metric(
                            f"limit_{index}",
                            "速率限制",
                            limit["detail"],
                            window=window,
                        )
                    )
            return UsageResult(metrics=metrics, source="kimi_coding_api"), None

        claims = _jwt_claims(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Cookie": f"kimi-auth={token}",
            "Content-Type": "application/json",
            "Origin": "https://www.kimi.com",
            "Referer": "https://www.kimi.com/code/console",
            "x-msh-platform": "web",
            "x-language": "en-US",
            "x-msh-device-id": str(claims.get("device_id", "")),
            "x-msh-session-id": str(claims.get("ssid", "")),
            "x-traffic-id": str(claims.get("sub", "")),
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/120 Safari/537.36"
            ),
        }
        data = _as_dict(
            await request_json(
                client, "POST", KIMI_USAGE_URL, headers=headers, json={"scope": ["FEATURE_CODING"]}
            )
        )
        usages = data.get("usages")
        if not isinstance(usages, list):
            raise AdapterError("invalid_response")
        selected = next(
            (
                item
                for item in usages
                if isinstance(item, dict) and item.get("scope") == "FEATURE_CODING"
            ),
            None,
        )
        metrics: list[Metric] = []
        if isinstance(selected, dict) and isinstance(selected.get("detail"), dict):
            metrics.append(
                _quota_metric("coding", "Coding Plan", selected["detail"], window="套餐周期")
            )
            limits = selected.get("limits")
            if isinstance(limits, list):
                for index, limit in enumerate(limits):
                    if not isinstance(limit, dict) or not isinstance(limit.get("detail"), dict):
                        continue
                    scope = limit.get("scope")
                    duration = (
                        (limit.get("window") or {}).get("duration")
                        if isinstance(limit.get("window"), dict)
                        else None
                    )
                    unit = (
                        (limit.get("window") or {}).get("timeUnit")
                        if isinstance(limit.get("window"), dict)
                        else None
                    )
                    window = f"{duration} {unit}" if duration and unit else "速率窗口"
                    label = "速率限制" if not isinstance(scope, str) else f"速率限制 {scope}"
                    metrics.append(
                        _quota_metric(f"limit_{index}", label, limit["detail"], window=window)
                    )
        plan = None
        try:
            subscription = _as_dict(
                await request_json(client, "POST", KIMI_SUBSCRIPTION_URL, headers=headers, json={})
            )
            choices = (subscription.get("subscription"), subscription.get("purchaseSubscription"))
            for choice in choices:
                if isinstance(choice, dict) and isinstance(choice.get("goods"), dict):
                    title = choice["goods"].get("title")
                    if isinstance(title, str):
                        plan = title
                        break
        except AdapterError as error:
            if error.code in {"auth_required", "rate_limited"}:
                raise
        return UsageResult(plan=plan, metrics=metrics, source="kimi_billing"), None


def _volc_hmac(key: bytes, value: str) -> bytes:
    """Apply one Volcengine HMAC-SHA256 key derivation step."""
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).digest()


def _volc_query(params: dict[str, str]) -> str:
    """Create the canonical sorted query string required by Volcengine signing."""
    return "&".join(
        f"{quote(key, safe='-_.~')}={quote(value, safe='-_.~')}"
        for key, value in sorted(params.items())
    )


def _volc_headers(
    access_key: str, secret_key: str, body: bytes, now: datetime | None = None
) -> dict[str, str]:
    """Sign a fixed Volcengine Ark OpenAPI request using its documented HMAC chain."""
    instant = (now or datetime.now(UTC)).astimezone(UTC)
    x_date = instant.strftime("%Y%m%dT%H%M%SZ")
    short_date = x_date[:8]
    body_hash = hashlib.sha256(body).hexdigest()
    signed = {
        "content-type": "application/json",
        "host": VOLCENGINE_HOST,
        "x-content-sha256": body_hash,
        "x-date": x_date,
    }
    signed_names = ";".join(sorted(signed))
    canonical_headers = "".join(f"{key}:{signed[key]}\n" for key in sorted(signed))
    params = {"Action": VOLCENGINE_ACTION, "Version": VOLCENGINE_VERSION}
    canonical_request = "\n".join(
        ("POST", "/", _volc_query(params), canonical_headers, signed_names, body_hash)
    )
    scope = f"{short_date}/{VOLCENGINE_REGION}/{VOLCENGINE_SERVICE}/request"
    to_sign = "\n".join(
        ("HMAC-SHA256", x_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest())
    )
    date_key = _volc_hmac(secret_key.encode(), short_date)
    region_key = _volc_hmac(date_key, VOLCENGINE_REGION)
    service_key = _volc_hmac(region_key, VOLCENGINE_SERVICE)
    signing_key = _volc_hmac(service_key, "request")
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    signed["Authorization"] = (
        f"HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_names}, Signature={signature}"
    )
    return {
        "Host": VOLCENGINE_HOST,
        "X-Date": x_date,
        "X-Content-Sha256": body_hash,
        "Content-Type": "application/json",
        "Authorization": signed["Authorization"],
    }


def _extract_volc_metrics(data: dict[str, Any]) -> tuple[str | None, list[Metric]]:
    """Map the Ark response's documented session, weekly, and monthly percentages."""
    result = data.get("Result")
    if not isinstance(result, dict):
        raise AdapterError("invalid_response")
    root = result
    plan = None
    metrics: list[Metric] = []
    quota_usage = root.get("QuotaUsage")
    if not isinstance(quota_usage, list):
        raise AdapterError("invalid_response")
    labels = {
        "session": ("session", "5 小时"),
        "weekly": ("weekly", "每周"),
        "monthly": ("monthly", "每月"),
    }
    for entry in quota_usage:
        if not isinstance(entry, dict):
            continue
        level = entry.get("Level")
        if level not in labels:
            continue
        metric_id, label = labels[level]
        percent = number(entry.get("Percent"))
        reset_value = number(entry.get("ResetTimestamp"))
        metrics.append(
            Metric(
                id=metric_id,
                label=label,
                unit="%",
                used=percent,
                limit=100 if percent is not None else None,
                remaining=100 - percent if percent is not None else None,
                used_percent=percent,
                window=label,
                resets_at=timestamp(reset_value)
                if reset_value is not None and reset_value > 0
                else None,
            )
        )
    if not metrics:
        raise AdapterError("invalid_response")
    return plan if isinstance(plan, str) else None, metrics


class VolcengineAdapter(BaseAdapter):
    """Fetch Coding Plan usage through signed, fixed-host Volcengine Ark OpenAPI."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Sign and send the GetCodingPlanUsage request, then expose quota fields only."""
        if auth_type != "aksk":
            raise AdapterError("invalid_credentials")
        access_key = require(credentials, "access_key")
        secret_key = require(credentials, "secret_key")
        params = {"Action": VOLCENGINE_ACTION, "Version": VOLCENGINE_VERSION}
        body = b"{}"
        data = _as_dict(
            await request_json(
                client,
                "POST",
                f"https://{VOLCENGINE_HOST}/?{_volc_query(params)}",
                headers=_volc_headers(access_key, secret_key, body),
                content=body,
            )
        )
        plan, metrics = _extract_volc_metrics(data)
        return UsageResult(
            plan=plan or "Coding Plan", metrics=metrics, source="volcengine_ark"
        ), None


def _aliyun_cookie(credentials: dict[str, str], auth_type: str) -> tuple[str, str | None]:
    """Validate the Bailian cookie and resolve sec_token supplied separately or inline."""
    if auth_type != "cookie":
        raise AdapterError("invalid_credentials")
    cookie = require(credentials, "cookie").removeprefix("cookie:").strip().strip('"')
    if "=" not in cookie or "\n" in cookie or "\r" in cookie:
        raise AdapterError("invalid_credentials")
    return cookie, credentials.get("sec_token", "").strip() or _cookie_value(
        cookie, ("sec_token", "secToken")
    )


def _aliyun_params(cookie: str, region: str) -> dict[str, Any]:
    """Build the fixed Bailian console query with anonymous browser correlation data."""
    return {
        "Api": ALIYUN_API,
        "V": "1.0",
        "Data": {
            "queryCodingPlanInstanceInfoRequest": {
                "commodityCode": "sfm_codingplan_public_cn",
                "onlyLatestOne": True,
            },
            "cornerstoneParam": {
                "feTraceId": "plan-quotas",
                "feURL": f"https://bailian.console.aliyun.com/{region}/?tab=coding-plan#/efm/detail",
                "protocol": "V2",
                "console": "ONE_CONSOLE",
                "productCode": "p_efm",
                "domain": "bailian.console.aliyun.com",
                "consoleSite": "BAILIAN_ALIYUN",
                "userNickName": "",
                "userPrincipalName": "",
                "xsp_lang": "zh-CN",
                "X-Anonymous-Id": _cookie_value(cookie, ("cna",)) or "",
            },
        },
    }


async def _aliyun_sec_token(
    client: httpx.AsyncClient, cookie: str, region: str, provided: str | None
) -> tuple[str, str]:
    """Use a supplied sec_token or extract one from the official Bailian console page."""
    referer = f"{ALIYUN_CONSOLE_URL}/{region}/?tab=coding-plan"
    if provided:
        return provided, referer
    try:
        response = await client.get(
            referer,
            headers={"Accept": "text/html,application/xhtml+xml", "Cookie": cookie},
            timeout=15,
            follow_redirects=False,
        )
    except httpx.RequestError:
        raise AdapterError("network_error") from None
    if response.status_code in (401, 403):
        raise AdapterError("auth_required")
    if not response.is_success:
        raise AdapterError("upstream_error")
    html = response.text
    patterns = (
        r"[?&]sec_token=([A-Za-z0-9_%.-]+)",
        r"[\"']sec_token[\"']\s*:\s*[\"']([^\"']+)",
        r"secToken[\"']?\s*[:=]\s*[\"']([^\"']+)",
    )
    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return unquote(match.group(1)), referer
    raise AdapterError("auth_required")


def _aliyun_metrics(instance: dict[str, Any]) -> list[Metric]:
    """Convert the primary Bailian instance quota fields into separate time windows."""
    quota = instance.get("codingPlanQuotaInfo")
    if not isinstance(quota, dict):
        raise AdapterError("invalid_response")
    definitions = (
        (
            "five_hour",
            "5 小时",
            "per5HourUsedQuota",
            "per5HourTotalQuota",
            "per5HourQuotaNextRefreshTime",
        ),
        ("weekly", "7 天", "perWeekUsedQuota", "perWeekTotalQuota", "perWeekQuotaNextRefreshTime"),
        (
            "monthly",
            "账单月",
            "perBillMonthUsedQuota",
            "perBillMonthTotalQuota",
            "perBillMonthQuotaNextRefreshTime",
        ),
    )
    metrics: list[Metric] = []
    for metric_id, label, used_key, limit_key, reset_key in definitions:
        used = number(quota.get(used_key))
        limit = number(quota.get(limit_key))
        if used is None and limit is None:
            continue
        metrics.append(
            _quota_metric(
                metric_id,
                label,
                {
                    "used": used,
                    "limit": limit,
                    "remaining": max(limit - used, 0)
                    if limit is not None and used is not None
                    else None,
                    "resetTime": quota.get(reset_key),
                },
                window=label,
            )
        )
    return metrics


class AliyunAdapter(BaseAdapter):
    """Read Bailian Coding Plan quota from the fixed official console gateway."""

    async def fetch(
        self, credentials: dict[str, str], auth_type: str, client: httpx.AsyncClient
    ) -> tuple[UsageResult, dict[str, str] | None]:
        """Resolve Bailian session security token, query usage, and retain only quota data."""
        cookie, sec_token = _aliyun_cookie(credentials, auth_type)
        region = _cookie_value(cookie, ("currentRegionId",)) or "cn-beijing"
        token, referer = await _aliyun_sec_token(client, cookie, region, sec_token)
        form = {
            "params": json.dumps(
                _aliyun_params(cookie, region), ensure_ascii=False, separators=(",", ":")
            ),
            "region": region,
            "sec_token": token,
        }
        data = _as_dict(
            await request_json(
                client,
                "POST",
                ALIYUN_GATEWAY_URL,
                headers={
                    "Accept": "*/*",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": ALIYUN_CONSOLE_URL,
                    "Referer": referer,
                    "Cookie": cookie,
                },
                data=form,
            )
        )
        envelope = data.get("data")
        if (
            not isinstance(envelope, dict)
            or data.get("code") != "200"
            or envelope.get("success") is not True
        ):
            raise AdapterError("upstream_error")
        data_v2 = envelope.get("DataV2")
        nested = data_v2.get("data") if isinstance(data_v2, dict) else None
        payload = nested.get("data") if isinstance(nested, dict) else None
        instances = payload.get("codingPlanInstanceInfos") if isinstance(payload, dict) else None
        result_codes = data_v2.get("ret") if isinstance(data_v2, dict) else None
        if (
            not isinstance(result_codes, list)
            or not any(
                isinstance(item, str) and item.startswith("SUCCESS") for item in result_codes
            )
            or not isinstance(nested, dict)
            or nested.get("failed") is True
        ):
            raise AdapterError("upstream_error")
        if not isinstance(instances, list) or not instances or not isinstance(instances[0], dict):
            raise AdapterError("invalid_response")
        instance = instances[0]
        metrics = _aliyun_metrics(instance)
        plan = instance.get("instanceName")
        return UsageResult(
            plan=plan if isinstance(plan, str) else "Coding Plan",
            metrics=metrics,
            source="aliyun_bailian_console",
        ), None
