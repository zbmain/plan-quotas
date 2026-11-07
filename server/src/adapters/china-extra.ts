import { createHash, createHmac } from "node:crypto";
import type { Credentials, StoredMetric } from "@plan-quotas/shared";
import {
  AdapterError,
  object,
  number,
  requireCredential,
  requestJSON,
  metric,
  usage,
  now,
  timestamp,
  cookieValue,
  jwtClaims,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";

/** Preserve independent count-based quota windows, leaving unavailable counters unknown. */
function quota(
  id: string,
  label: string,
  detail: Record<string, any>,
  window: string | null,
): StoredMetric {
  const used = number(detail.used),
    limit = number(detail.limit);
  let remaining = number(detail.remaining);
  if (remaining === null && used !== null && limit !== null)
    remaining = Math.max(limit - used, 0);
  return metric({
    id,
    label,
    unit: "quota",
    used,
    limit,
    remaining,
    used_percent:
      used !== null && limit !== null && limit > 0
        ? (used / limit) * 100
        : null,
    window,
    resets_at: timestamp(detail.resetTime || detail.reset_time),
  });
}
/** Normalize the exact protobuf time-unit enum supplied by Kimi. */
function kimiWindow(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  const duration = number(value.duration),
    raw = value.timeUnit;
  if (duration === null || duration <= 0 || typeof raw !== "string")
    return null;
  const multiplier = (
    { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800 } as Record<
      string,
      number
    >
  )[raw.toUpperCase().replace(/^TIME_UNIT_/, "")];
  if (!multiplier) return `${duration} ${raw}`;
  const seconds = number(duration * multiplier);
  if (seconds === null) return null;
  for (const [divisor, suffix] of [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const)
    if (seconds % divisor === 0) return `${seconds / divisor}${suffix}`;
  return `${seconds}s`;
}
/** Retain Kimi metric IDs while ordering five-hour usage before its seven-day allowance. */
function kimiMetrics(detail: Record<string, any>, limits: any): StoredMetric[] {
  const metrics = [quota("coding", "7 天用量", detail, "7d")];
  if (Array.isArray(limits))
    for (const [index, row] of limits.entries()) {
      if (
        !row?.detail ||
        typeof row.detail !== "object" ||
        Array.isArray(row.detail)
      )
        continue;
      const window = kimiWindow(row.window);
      metrics.push(
        quota(
          `limit_${index}`,
          window === "5h"
            ? "5 小时用量"
            : window === "7d"
              ? "7 天用量"
              : "调用额度",
          row.detail,
          window,
        ),
      );
    }
  return metrics.sort(
    (a, b) =>
      (a.window === "5h" ? 0 : a.window === "7d" ? 1 : 2) -
      (b.window === "5h" ? 0 : b.window === "7d" ? 1 : 2),
  );
}
export class KimiAdapter implements Adapter {
  /** Query the Coding API for keys and the official billing service for browser sessions. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (!["api_key", "jwt", "cookie"].includes(authType))
      throw new AdapterError("invalid_credentials");
    const input = requireCredential(
      credentials,
      authType === "api_key"
        ? "api_key"
        : authType === "jwt"
          ? "jwt"
          : "cookie",
    );
    const token =
      authType === "cookie"
        ? cookieValue(input, ["kimi-auth", "kimi-auth-prod"]) || input
        : input;
    if (authType === "api_key") {
      const data = object(
        await requestJSON(
          client,
          "GET",
          "https://api.kimi.com/coding/v1/usages",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
          },
        ),
      );
      return [
        usage(
          {
            source: "kimi_coding_api",
            metrics: kimiMetrics(object(data.usage), data.limits),
          },
          now(),
        ),
        null,
      ];
    }
    const claims = jwtClaims(token);
    const headers = {
      Authorization: `Bearer ${token}`,
      Cookie: `kimi-auth=${token}`,
      "Content-Type": "application/json",
      Origin: "https://www.kimi.com",
      Referer: "https://www.kimi.com/code/console",
      "x-msh-platform": "web",
      "x-language": "en-US",
      "x-msh-device-id": String(claims.device_id ?? ""),
      "x-msh-session-id": String(claims.ssid ?? ""),
      "x-traffic-id": String(claims.sub ?? ""),
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    };
    const data = object(
      await requestJSON(
        client,
        "POST",
        "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages",
        { headers, json: { scope: ["FEATURE_CODING"] } },
      ),
    );
    if (!Array.isArray(data.usages)) throw new AdapterError("invalid_response");
    const selected = data.usages.find(
      (item: any) => item?.scope === "FEATURE_CODING",
    );
    const metrics =
      selected?.detail && typeof selected.detail === "object"
        ? kimiMetrics(selected.detail, selected.limits)
        : [];
    let plan: string | null = null;
    try {
      const subscription = object(
        await requestJSON(
          client,
          "POST",
          "https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription",
          { headers, json: {} },
        ),
      );
      for (const choice of [
        subscription.subscription,
        subscription.purchaseSubscription,
      ])
        if (typeof choice?.goods?.title === "string") {
          plan = choice.goods.title;
          break;
        }
    } catch (error) {
      if (
        error instanceof AdapterError &&
        ["auth_required", "rate_limited"].includes(error.code)
      )
        throw error;
    }
    return [usage({ plan, source: "kimi_billing", metrics }, now()), null];
  }
}
/** Percent-encode a Volcengine signed parameter using RFC 3986 rather than form encoding. */
function quote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
/** Derive Volcengine's canonical request signature against its fixed Ark service. */
export function volcHeaders(
  access: string,
  secret: string,
  instant = now(),
): Record<string, string> {
  const xDate = instant.slice(0, 19).replace(/[-:]/g, "") + "Z",
    date = xDate.slice(0, 8);
  const hash = createHash("sha256").update("{}").digest("hex");
  const values: Record<string, string> = {
    "content-type": "application/json",
    host: "open.volcengineapi.com",
    "x-content-sha256": hash,
    "x-date": xDate,
  };
  const names = Object.keys(values).sort(),
    signed = names.join(";");
  const query = "Action=GetCodingPlanUsage&Version=2024-01-01";
  const canonical = [
    "POST",
    "/",
    query,
    names.map((key) => `${key}:${values[key]}\n`).join(""),
    signed,
    hash,
  ].join("\n");
  const scope = `${date}/cn-beijing/ark/request`;
  const toSign = [
    "HMAC-SHA256",
    xDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let key: Buffer = Buffer.from(secret);
  for (const part of [date, "cn-beijing", "ark", "request"])
    key = createHmac("sha256", key).update(part).digest();
  return {
    Host: values.host,
    "X-Date": xDate,
    "X-Content-Sha256": hash,
    "Content-Type": "application/json",
    Authorization: `HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`,
  };
}
export class VolcengineAdapter implements Adapter {
  /** Sign the exact Ark endpoint and expose only recognized quota levels. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "aksk") throw new AdapterError("invalid_credentials");
    const headers = volcHeaders(
      requireCredential(credentials, "access_key"),
      requireCredential(credentials, "secret_key"),
    );
    const root = object(
      await requestJSON(
        client,
        "POST",
        "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01",
        { headers, content: "{}" },
      ),
    );
    const result = object(root.Result);
    if (!Array.isArray(result.QuotaUsage))
      throw new AdapterError("invalid_response");
    const labels: Record<string, string> = {
      session: "5 小时",
      weekly: "每周",
      monthly: "每月",
    };
    const metrics = [];
    for (const row of result.QuotaUsage) {
      if (!row || !labels[row.Level]) continue;
      const percent = number(row.Percent),
        reset = number(row.ResetTimestamp);
      metrics.push(
        metric({
          id: row.Level,
          label: labels[row.Level],
          unit: "%",
          used: percent,
          limit: percent !== null ? 100 : null,
          remaining: percent !== null ? 100 - percent : null,
          used_percent: percent,
          window: labels[row.Level],
          resets_at: reset !== null && reset > 0 ? timestamp(reset) : null,
        }),
      );
    }
    if (!metrics.length) throw new AdapterError("invalid_response");
    return [
      usage({ plan: "Coding Plan", source: "volcengine_ark", metrics }, now()),
      null,
    ];
  }
}
const ALIYUN_API =
  "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";
/** Build Bailian's documented browser query without importing unrelated account cookies. */
function aliyunParams(cookie: string, region: string): Record<string, any> {
  return {
    Api: ALIYUN_API,
    V: "1.0",
    Data: {
      queryCodingPlanInstanceInfoRequest: {
        commodityCode: "sfm_codingplan_public_cn",
        onlyLatestOne: true,
      },
      cornerstoneParam: {
        feTraceId: "plan-quotas",
        feURL: `https://bailian.console.aliyun.com/${region}/?tab=coding-plan#/efm/detail`,
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        domain: "bailian.console.aliyun.com",
        consoleSite: "BAILIAN_ALIYUN",
        userNickName: "",
        userPrincipalName: "",
        xsp_lang: "zh-CN",
        "X-Anonymous-Id": cookieValue(cookie, ["cna"]) || "",
      },
    },
  };
}
export class AliyunAdapter implements Adapter {
  /** Resolve a Bailian session token and normalize each actual billing window independently. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "cookie") throw new AdapterError("invalid_credentials");
    const cookie = requireCredential(credentials, "cookie")
      .replace(/^cookie:/, "")
      .trim()
      .replace(/^"|"$/g, "");
    if (!cookie.includes("=") || /[\r\n]/.test(cookie))
      throw new AdapterError("invalid_credentials");
    const region = cookieValue(cookie, ["currentRegionId"]) || "cn-beijing",
      referer = `https://bailian.console.aliyun.com/${region}/?tab=coding-plan`;
    let token =
      credentials.sec_token?.trim() ||
      cookieValue(cookie, ["sec_token", "secToken"]);
    if (!token) {
      let response: Response;
      try {
        response = await client(referer, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: cookie,
          },
          signal: AbortSignal.timeout(15000),
          redirect: "manual",
        });
      } catch {
        throw new AdapterError("network_error");
      }
      if ([401, 403].includes(response.status))
        throw new AdapterError("auth_required");
      if (!response.ok) throw new AdapterError("upstream_error");
      const html = await response.text();
      for (const pattern of [
        /[?&]sec_token=([A-Za-z0-9_%.-]+)/i,
        /["']sec_token["']\s*:\s*["']([^"']+)/i,
        /secToken["']?\s*[:=]\s*["']([^"']+)/i,
      ]) {
        const match = pattern.exec(html);
        if (match) {
          try {
            token = decodeURIComponent(match[1]);
          } catch {
            token = match[1];
          }
          break;
        }
      }
      if (!token) throw new AdapterError("auth_required");
    }
    const url = `https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${quote(ALIYUN_API)}&_v=undefined`;
    const data = object(
      await requestJSON(client, "POST", url, {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://bailian.console.aliyun.com",
          Referer: referer,
          Cookie: cookie,
        },
        data: {
          params: JSON.stringify(aliyunParams(cookie, region)),
          region,
          sec_token: token,
        },
      }),
    );
    const envelope = data.data,
      v2 = envelope?.DataV2,
      nested = v2?.data,
      instances = nested?.data?.codingPlanInstanceInfos;
    if (
      data.code !== "200" ||
      envelope?.success !== true ||
      !Array.isArray(v2?.ret) ||
      !v2.ret.some(
        (row: any) => typeof row === "string" && row.startsWith("SUCCESS"),
      ) ||
      !nested ||
      nested.failed === true
    )
      throw new AdapterError("upstream_error");
    if (!Array.isArray(instances) || !instances.length)
      throw new AdapterError("invalid_response");
    const instance = object(instances[0]),
      values = object(instance.codingPlanQuotaInfo),
      metrics = [];
    for (const [id, label, usedKey, limitKey, resetKey] of [
      [
        "five_hour",
        "5 小时",
        "per5HourUsedQuota",
        "per5HourTotalQuota",
        "per5HourQuotaNextRefreshTime",
      ],
      [
        "weekly",
        "7 天",
        "perWeekUsedQuota",
        "perWeekTotalQuota",
        "perWeekQuotaNextRefreshTime",
      ],
      [
        "monthly",
        "账单月",
        "perBillMonthUsedQuota",
        "perBillMonthTotalQuota",
        "perBillMonthQuotaNextRefreshTime",
      ],
    ]) {
      const used = number(values[usedKey]),
        limit = number(values[limitKey]);
      if (used === null && limit === null) continue;
      metrics.push(
        quota(
          id,
          label,
          {
            used,
            limit,
            remaining:
              used !== null && limit !== null
                ? Math.max(limit - used, 0)
                : null,
            resetTime: values[resetKey],
          },
          label,
        ),
      );
    }
    return [
      usage(
        {
          plan:
            typeof instance.instanceName === "string"
              ? instance.instanceName
              : "Coding Plan",
          source: "aliyun_bailian_console",
          metrics,
        },
        now(),
      ),
      null,
    ];
  }
}
