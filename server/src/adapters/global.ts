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
  millis,
  rotatedError,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";

/** Refresh only with provider-required imported fields; never infer an OAuth client secret. */
async function refresh(
  credentials: Credentials,
  client: Fetcher,
  url: string,
  secret: boolean,
  json = false,
): Promise<Credentials> {
  const token = credentials.refresh_token?.trim(),
    id = credentials.client_id?.trim(),
    clientSecret = credentials.client_secret?.trim();
  if (!token || !id || (secret && !clientSecret))
    throw new AdapterError("auth_required");
  const payload: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: id,
  };
  if (secret) payload.client_secret = clientSecret;
  const data = object(
    await requestJSON(client, "POST", url, {
      headers: { Accept: "application/json" },
      json: json ? payload : undefined,
      data: json ? undefined : payload,
      oauth_token: true,
    }),
  );
  if (data.error === "invalid_grant") throw new AdapterError("auth_required");
  if (typeof data.access_token !== "string" || !data.access_token)
    throw new AdapterError("invalid_response");
  const rotated: Credentials = {
    ...credentials,
    access_token: data.access_token,
  };
  if (typeof data.refresh_token === "string" && data.refresh_token)
    rotated.refresh_token = data.refresh_token;
  const seconds = number(data.expires_in);
  if (seconds !== null && seconds > 0)
    rotated.expires_at = String(Date.now() / 1000 + seconds);
  else delete rotated.expires_at;
  return rotated;
}
/** Refresh once before expiry or after an unauthorized usage request, retaining any rotated key. */
async function authorized(
  client: Fetcher,
  url: string,
  credentials: Credentials,
  tokenURL: string,
  secret: boolean,
  headers: Record<string, string> = {},
  body?: any,
  jsonRefresh = false,
): Promise<[any, Credentials | null]> {
  let rotated: Credentials | null = null,
    current = credentials;
  const expiry = timestamp(credentials.expires_at);
  if (expiry !== null && millis(expiry) <= Date.now() + 30000) {
    current = await refresh(credentials, client, tokenURL, secret, jsonRefresh);
    rotated = current;
  }
  const requestHeaders = {
    Authorization: `Bearer ${requireCredential(current, "access_token")}`,
    ...headers,
  };
  try {
    return [
      await requestJSON(client, body !== undefined ? "POST" : "GET", url, {
        headers: requestHeaders,
        json: body,
      }),
      rotated,
    ];
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    if (error.code !== "auth_required" || rotated) {
      if (rotated) error.rotated_credentials = rotated;
      throw error;
    }
    current = await refresh(credentials, client, tokenURL, secret, jsonRefresh);
    rotated = current;
    requestHeaders.Authorization = `Bearer ${requireCredential(current, "access_token")}`;
    try {
      return [
        await requestJSON(client, body !== undefined ? "POST" : "GET", url, {
          headers: requestHeaders,
          json: body,
        }),
        rotated,
      ];
    } catch (next) {
      if (next instanceof AdapterError) next.rotated_credentials = rotated;
      throw next;
    }
  }
}
/** Normalize Codex's reported duration without guessing a billing week for other windows. */
function codexWindow(
  row: Record<string, any>,
  id: string,
  label: string,
): StoredMetric {
  const used = number(row.used_percent),
    seconds = number(row.limit_window_seconds);
  let window = label;
  if (seconds === 18000) window = "5h";
  else if (seconds === 604800) window = "week";
  else if (seconds !== null && seconds > 0) {
    window = `${seconds}s`;
    for (const [divisor, suffix] of [
      [604800, "w"],
      [86400, "d"],
      [3600, "h"],
      [60, "m"],
      [1, "s"],
    ] as const)
      if (Number.isInteger(seconds / divisor)) {
        window = `${seconds / divisor}${suffix}`;
        break;
      }
  }
  return metric({
    id,
    label,
    unit: "%",
    used,
    limit: used !== null ? 100 : null,
    remaining: used !== null ? 100 - used : null,
    used_percent: used,
    window,
    resets_at: timestamp(row.reset_at),
  });
}
export class CodexAdapter implements Adapter {
  /** Read WHAM usage with the imported account context and optional OAuth refresh. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "oauth") throw new AdapterError("invalid_credentials");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (credentials.account_id?.trim())
      headers["ChatGPT-Account-Id"] = credentials.account_id.trim();
    const [data, rotated] = await authorized(
      client,
      "https://chatgpt.com/backend-api/wham/usage",
      credentials,
      "https://auth.openai.com/oauth/token",
      false,
      headers,
    );
    if (
      !data ||
      typeof data !== "object" ||
      !data.rate_limit ||
      typeof data.rate_limit !== "object" ||
      Array.isArray(data.rate_limit)
    )
      throw rotatedError("invalid_response", rotated);
    const metrics = [];
    for (const [key, label] of [
      ["primary_window", "主要额度"],
      ["secondary_window", "次要额度"],
    ]) {
      const row = data.rate_limit[key];
      if (
        row &&
        typeof row === "object" &&
        (number(row.used_percent) !== null || timestamp(row.reset_at) !== null)
      )
        metrics.push(codexWindow(row, key, label));
    }
    if (!metrics.length) throw rotatedError("invalid_response", rotated);
    return [
      usage(
        {
          plan: typeof data.plan_type === "string" ? data.plan_type : null,
          source: "codex_wham",
          metrics,
        },
        now(),
      ),
      rotated,
    ];
  }
}
export class ClaudeAdapter implements Adapter {
  /** Read Claude's supported windows, keeping organization identifiers internal. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    let data: any,
      rotated: Credentials | null = null;
    if (authType === "oauth") {
      [data, rotated] = await authorized(
        client,
        "https://api.anthropic.com/api/oauth/usage",
        credentials,
        "https://console.anthropic.com/v1/oauth/token",
        false,
        { Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
        undefined,
        true,
      );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw rotatedError("invalid_response", rotated);
    } else if (authType === "cookie") {
      const headers = {
        Cookie: requireCredential(credentials, "cookie"),
        Accept: "application/json",
      };
      const organizations = await requestJSON(
        client,
        "GET",
        "https://claude.ai/api/organizations",
        { headers },
      );
      const id = Array.isArray(organizations)
        ? organizations.find((row) => row && typeof row.uuid === "string")?.uuid
        : null;
      if (!id) throw new AdapterError("invalid_response");
      data = object(
        await requestJSON(
          client,
          "GET",
          `https://claude.ai/api/organizations/${encodeURIComponent(id)}/usage`,
          { headers },
        ),
      );
    } else throw new AdapterError("invalid_credentials");
    const metrics = [];
    for (const [id, label] of [
      ["five_hour", "5 小时"],
      ["seven_day", "7 天"],
      ["seven_day_sonnet", "Sonnet 7 天"],
      ["seven_day_opus", "Opus 7 天"],
    ]) {
      const row = data[id];
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const used = number(row.utilization),
        reset = timestamp(row.resets_at);
      if (used === null && reset === null) continue;
      metrics.push(
        metric({
          id,
          label,
          unit: "%",
          used_percent: used,
          used,
          limit: used !== null ? 100 : null,
          remaining: used !== null ? 100 - used : null,
          window: label,
          resets_at: reset,
        }),
      );
    }
    if (!metrics.length) throw rotatedError("invalid_response", rotated);
    return [
      usage(
        {
          plan: typeof data.plan === "string" ? data.plan : null,
          source: "claude_usage",
          metrics,
        },
        now(),
      ),
      rotated,
    ];
  }
}
export class CursorAdapter implements Adapter {
  /** Keep Cursor plan percentages, included spend, and on-demand charges distinct. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "cookie") throw new AdapterError("invalid_credentials");
    const data = object(
      await requestJSON(
        client,
        "GET",
        "https://www.cursor.com/api/usage-summary",
        {
          headers: {
            Cookie: requireCredential(credentials, "cookie"),
            Accept: "application/json",
          },
        },
      ),
    );
    const metrics: StoredMetric[] = [],
      plan = data.individualUsage?.plan,
      cycle = timestamp(data.billingCycleEnd);
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      for (const [key, label] of [
        ["autoPercentUsed", "Cursor Models"],
        ["apiPercentUsed", "Other Models"],
        ["totalPercentUsed", "套餐总用量"],
      ]) {
        let used = number(plan[key]);
        if (used === null) continue;
        used = Math.max(0, Math.min(100, used));
        metrics.push(
          metric({
            id: `plan_${key}`,
            label,
            unit: "%",
            used,
            limit: 100,
            remaining: 100 - used,
            used_percent: used,
            window: "账单周期",
            resets_at: cycle,
          }),
        );
      }
      const used = number(plan.used),
        limit = number(plan.limit),
        remaining = number(plan.remaining);
      if ([used, limit, remaining].some((value) => value !== null))
        metrics.push(
          metric({
            id: "included_spend",
            label: "套餐内消费",
            kind: "cost",
            unit: "USD",
            currency: "USD",
            used: used !== null ? used / 100 : null,
            limit: limit !== null ? limit / 100 : null,
            remaining: remaining !== null ? remaining / 100 : null,
            window: "账单周期",
            resets_at: cycle,
          }),
        );
    }
    const demand =
      data.individualUsage?.onDemand &&
      typeof data.individualUsage.onDemand === "object"
        ? data.individualUsage.onDemand
        : data.teamUsage?.onDemand;
    if (demand && typeof demand === "object") {
      const used = number(demand.used),
        limit = number(demand.limit);
      if (used !== null || limit !== null)
        metrics.push(
          metric({
            id: "on_demand",
            label: "按量消费",
            kind: "cost",
            unit: "USD",
            currency: "USD",
            used: used !== null ? used / 100 : null,
            limit: limit !== null ? limit / 100 : null,
            remaining:
              used !== null && limit !== null
                ? Math.max(0, limit / 100 - used / 100)
                : null,
            window: "账单周期",
            resets_at: cycle,
          }),
        );
    }
    for (const [key, label] of [
      ["gpt-4", "GPT-4 使用量"],
      ["gpt-3.5-turbo", "GPT-3.5 使用量"],
    ]) {
      const bucket = data.usage?.[key];
      if (!bucket || typeof bucket !== "object") continue;
      const used = number(bucket.numRequests),
        limit = number(bucket.maxRequestUsage);
      metrics.push(
        metric({
          id: key,
          label,
          unit: "次",
          used,
          limit,
          remaining:
            used !== null && limit !== null ? Math.max(0, limit - used) : null,
          window: "账单周期",
        }),
      );
    }
    if (!metrics.length) throw new AdapterError("invalid_response");
    const title = data.membershipType || data.plan;
    return [
      usage(
        {
          plan: typeof title === "string" ? title : null,
          source: "cursor_usage_summary",
          metrics,
        },
        now(),
      ),
      null,
    ];
  }
}
export class AntigravityAdapter implements Adapter {
  /** Query existing Cloud Code Assist projects only; never onboard or create a project. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "oauth") throw new AdapterError("invalid_credentials");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let project = credentials.project_id?.trim() || "";
    const body: Record<string, any> = { metadata: { ideType: "ANTIGRAVITY" } };
    if (project) body.cloudaicompanionProject = project;
    const [load, rotated] = await authorized(
      client,
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      credentials,
      "https://oauth2.googleapis.com/token",
      true,
      headers,
      body,
    );
    if (!load || typeof load !== "object" || Array.isArray(load))
      throw rotatedError("invalid_response", rotated);
    const resolved =
      typeof load.cloudaicompanionProject === "object"
        ? load.cloudaicompanionProject?.id
        : load.cloudaicompanionProject;
    if (typeof resolved === "string" && resolved) project = resolved;
    let data: any,
      next: Credentials | null = null;
    try {
      [data, next] = await authorized(
        client,
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        rotated || credentials,
        "https://oauth2.googleapis.com/token",
        true,
        headers,
        project ? { project } : {},
      );
    } catch (error) {
      if (
        error instanceof AdapterError &&
        rotated &&
        !error.rotated_credentials
      )
        error.rotated_credentials = rotated;
      throw error;
    }
    const rotation = next || rotated;
    if (
      !data ||
      typeof data !== "object" ||
      !data.models ||
      typeof data.models !== "object" ||
      Array.isArray(data.models)
    )
      throw rotatedError("invalid_response", rotation);
    const metrics = [];
    for (const [id, row] of Object.entries(data.models) as [string, any][]) {
      if (!row || row.isInternal === true || !row.quotaInfo) continue;
      const fraction = number(row.quotaInfo.remainingFraction);
      if (fraction === null) continue;
      const remaining = Math.max(0, Math.min(100, fraction * 100)),
        label =
          [row.displayName, row.model, id]
            .find((value) => typeof value === "string" && value.trim())
            ?.trim()
            .slice(0, 120) || "模型";
      metrics.push(
        metric({
          id,
          label,
          unit: "%",
          remaining,
          used: 100 - remaining,
          limit: 100,
          used_percent: 100 - remaining,
          resets_at: timestamp(row.quotaInfo.resetTime),
          window: "模型额度",
        }),
      );
    }
    if (!metrics.length) throw rotatedError("invalid_response", rotation);
    const tier = load.paidTier || load.currentTier,
      title = typeof tier === "object" ? tier?.name || tier?.id : tier;
    return [
      usage(
        {
          plan: typeof title === "string" ? title : null,
          source: "antigravity_models",
          metrics,
        },
        now(),
      ),
      rotation,
    ];
  }
}
