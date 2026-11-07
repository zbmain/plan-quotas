import type { Credentials } from "@plan-quotas/shared";
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
  addMillis,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";

export class MiniMaxAdapter implements Adapter {
  /** Query MiniMax's China subscription windows without substituting local search counts. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    const headers: Record<string, string> = {};
    if (authType === "api_key")
      headers.Authorization = `Bearer ${requireCredential(credentials, "api_key")}`;
    else if (authType === "cookie")
      headers.Cookie = requireCredential(credentials, "cookie");
    else throw new AdapterError("invalid_credentials");
    const root = object(
      await requestJSON(
        client,
        "GET",
        "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
        { headers },
      ),
    );
    if (
      root.base_resp &&
      number(root.base_resp.status_code) !== null &&
      number(root.base_resp.status_code) !== 0
    )
      throw new AdapterError("auth_required");
    if (!Array.isArray(root.model_remains))
      throw new AdapterError("invalid_response");
    const metrics = [];
    for (const [index, row] of root.model_remains.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (
        row.model_name &&
        !["general", "coding", "text"].includes(
          String(row.model_name).toLowerCase(),
        )
      )
        continue;
      for (const [id, remainingKey, resetKey, label, window] of [
        [
          "interval",
          "current_interval_remaining_percent",
          "remains_time",
          "短周期",
          "5h",
        ],
        [
          "weekly",
          "current_weekly_remaining_percent",
          "weekly_remains_time",
          "长周期",
          "week",
        ],
      ]) {
        const remaining = number(row[remainingKey]);
        if (remaining === null) continue;
        const reset = number(row[resetKey]);
        metrics.push(
          metric({
            id: `${id}-${index}`,
            label,
            unit: "%",
            remaining,
            used_percent: 100 - remaining,
            window,
            resets_at:
              reset !== null && reset >= 0 ? addMillis(now(), reset) : null,
          }),
        );
      }
    }
    if (!metrics.length) throw new AdapterError("invalid_response");
    const title = root.current_subscribe_title || root.plan_name;
    return [
      usage(
        {
          plan: title ? String(title).slice(0, 120) : null,
          source: "minimax",
          metrics,
        },
        now(),
      ),
      null,
    ];
  }
}
/** Interpret observed GLM cycle metadata without treating its TOKENS_LIMIT name as token counts. */
function glmWindow(row: Record<string, any>, index: number): string | null {
  const kind = String(row.type ?? "").toUpperCase(),
    unit = number(row.unit),
    count = number(row.number);
  if (kind === "TOKENS_LIMIT" && unit === 3 && count === 5) return "5h";
  if (kind === "TOKENS_LIMIT" && unit === 6 && count === 1) return "week";
  if (kind === "TIME_LIMIT")
    return unit === 5 && count === 1 ? "monthly" : null;
  return `quota-${index + 1}`;
}
export class GLMAdapter implements Adapter {
  /** Collect the official MCP pool and persist raw tool observations for existing history compatibility. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "api_key") throw new AdapterError("invalid_credentials");
    const root = object(
      await requestJSON(
        client,
        "GET",
        "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        {
          headers: {
            Authorization: `Bearer ${requireCredential(credentials, "api_key")}`,
          },
        },
      ),
    );
    const data = object(root.data ?? root);
    if (!Array.isArray(data.limits)) throw new AdapterError("invalid_response");
    const metrics = [];
    for (const [index, row] of data.limits.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const total = number(row.usage);
      let used = number(row.currentValue),
        remaining = number(row.remaining);
      if (used === null && total !== null && remaining !== null)
        used = total - remaining;
      if (remaining === null && total !== null && used !== null)
        remaining = total - used;
      const pool = String(row.type ?? "").toUpperCase() === "TIME_LIMIT",
        calls = pool && number(row.unit) === 5;
      const window = glmWindow(row, index);
      metrics.push(
        metric({
          id: `glm-${index}`,
          label: calls ? "MCP 调用次数" : "GLM Coding Plan",
          unit: pool ? "次" : "tokens",
          used,
          limit: total,
          remaining,
          used_percent: number(row.percentage),
          window,
          resets_at: timestamp(row.nextResetTime),
        }),
      );
      if (calls && Array.isArray(row.usageDetails))
        for (const detail of row.usageDetails) {
          if (!detail || typeof detail !== "object") continue;
          const used = number(detail.usage),
            code = String(detail.modelCode ?? "").toLowerCase();
          const label = (
            {
              "search-prime": "联网搜索",
              "web-reader": "网页阅读",
              zread: "仓库检索",
            } as Record<string, string>
          )[code];
          if (used !== null && label)
            metrics.push(
              metric({
                id: `glm-mcp-${code}`,
                label: `${label}调用次数`,
                unit: "次",
                used,
                window,
              }),
            );
        }
    }
    if (!metrics.length) throw new AdapterError("invalid_response");
    return [
      usage({ plan: "GLM Coding Plan", source: "glm", metrics }, now()),
      null,
    ];
  }
}
export class DeepSeekAdapter implements Adapter {
  /** Preserve DeepSeek's separate balance components and currencies as monetary values. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType !== "api_key") throw new AdapterError("invalid_credentials");
    const root = object(
      await requestJSON(
        client,
        "GET",
        "https://api.deepseek.com/user/balance",
        {
          headers: {
            Authorization: `Bearer ${requireCredential(credentials, "api_key")}`,
          },
        },
      ),
    );
    if (!Array.isArray(root.balance_infos))
      throw new AdapterError("invalid_response");
    const metrics = [];
    for (const [index, row] of root.balance_infos.entries()) {
      if (!row || !["CNY", "USD"].includes(row.currency)) continue;
      for (const [field, label] of [
        ["total_balance", "总余额"],
        ["granted_balance", "赠送余额"],
        ["topped_up_balance", "充值余额"],
      ]) {
        const remaining = number(row[field]);
        if (remaining !== null)
          metrics.push(
            metric({
              id: `balance-${index}-${field}`,
              label,
              kind: "balance",
              unit: row.currency,
              currency: row.currency,
              remaining,
            }),
          );
      }
    }
    if (!metrics.length) throw new AdapterError("invalid_response");
    return [usage({ source: "deepseek", metrics }, now()), null];
  }
}
