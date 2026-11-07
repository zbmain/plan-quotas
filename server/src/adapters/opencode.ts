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
  addMillis,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";
const windows = [
  ["rolling", "fiveHour", "短周期", "5h"],
  ["weekly", "week", "长周期", "week"],
  ["monthly", "month", "月度额度", "month"],
];

/** Reject malformed or negative counts while keeping a missing quota unknown. */
function count(value: any): number | null {
  if (value == null) return null;
  const result = typeof value === "boolean" ? null : number(value);
  if (result === null || result < 0) throw new AdapterError("invalid_response");
  return result;
}
/** Prefer explicit upstream timestamps and derive only from an actual resetInSec field. */
function reset(row: any, clock: string): string | null {
  const value = row.resetsAt || row.resetAt,
    absolute = typeof value === "boolean" ? null : timestamp(value);
  if (absolute) return absolute;
  const seconds = count(row.resetInSec);
  if (seconds === null) return null;
  try {
    return addMillis(clock, seconds * 1000);
  } catch {
    return null;
  }
}
/** Keep sub-one-percent values in percentage units and retain overages. */
function quota(
  id: string,
  label: string,
  window: string,
  used: number | null,
  resets_at: string | null,
): StoredMetric {
  used = count(used);
  return metric({
    id: `opencode-${id}`,
    label,
    unit: "%",
    used,
    limit: used !== null ? 100 : null,
    remaining: used !== null ? Math.max(0, 100 - used) : null,
    used_percent: used,
    window,
    resets_at,
  });
}
export class OpenCodeAdapter implements Adapter {
  /** Query Go keys independently from explicitly scoped Console sessions and optional wallet data. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authType === "api_key") {
      headers.Authorization = `Bearer ${requireCredential(credentials, "api_key")}`;
      const root = object(
          await requestJSON(
            client,
            "GET",
            "https://opencode.ai/inference/go/v1/usage",
            { headers, forbidden_code: "subscription_unavailable" },
          ),
        ),
        data = object(root.usage),
        clock = now(),
        metrics = [];
      for (const [key, , label, window] of windows) {
        if (data[key] == null) continue;
        const row = object(data[key]);
        metrics.push(
          quota(key, label, window, count(row.percent), reset(row, clock)),
        );
      }
      if (!metrics.length) throw new AdapterError("invalid_response");
      return [
        usage(
          {
            plan: "OpenCode Go",
            source: "opencode_go_api",
            metrics,
            fetched_at: clock,
          },
          clock,
        ),
        null,
      ];
    }
    if (authType !== "cookie") throw new AdapterError("invalid_credentials");
    const workspace = requireCredential(credentials, "workspace_id");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace))
      throw new AdapterError("invalid_credentials");
    headers.Cookie = requireCredential(credentials, "cookie");
    headers["x-org-id"] = workspace;
    const payload = await requestJSON(
      client,
      "GET",
      "https://opencode.ai/console/api/go/status",
      { headers, forbidden_code: "subscription_unavailable" },
    );
    const clock = now(),
      metrics: StoredMetric[] = [];
    if (payload !== null) {
      const root = object(payload);
      if (!("access" in root)) throw new AdapterError("invalid_response");
      if (root.access !== null) {
        const access = object(root.access),
          meters = object(access.meters);
        for (const [key, consoleKey, label, window] of windows) {
          if (meters[consoleKey] == null) continue;
          const row = object(meters[consoleKey]),
            used = count(row.usedMicroCents),
            limit = count(row.limitMicroCents);
          let resets = reset(row, clock);
          if (key === "monthly" && row.resetsAt == null)
            resets = reset({ resetsAt: access.endsAt }, clock);
          metrics.push(
            quota(
              key,
              label,
              window,
              used !== null && limit !== null && limit > 0
                ? (used / limit) * 100
                : null,
              resets,
            ),
          );
        }
        if (!metrics.length) throw new AdapterError("invalid_response");
      }
    }
    const subscribed = metrics.length > 0;
    try {
      const data = object(
        await requestJSON(
          client,
          "GET",
          "https://opencode.ai/console/api/billing/status",
          { headers },
        ),
      );
      if (typeof data.mode !== "string")
        throw new AdapterError("invalid_response");
      if (data.billingMode === "prepaid" && data.mode === "pay-as-you-go") {
        if (
          typeof data.balanceMicroCents !== "string" ||
          !/^-?\d+$/.test(data.balanceMicroCents)
        )
          throw new AdapterError("invalid_response");
        const balance = number(data.balanceMicroCents);
        if (balance === null) throw new AdapterError("invalid_response");
        metrics.push(
          metric({
            id: "opencode-balance",
            label: "账户余额",
            kind: "balance",
            unit: "USD",
            currency: "USD",
            remaining: balance / 100000000,
          }),
        );
      }
    } catch (error) {
      if (!subscribed) throw error;
    }
    if (!metrics.length) throw new AdapterError("subscription_unavailable");
    return [
      usage(
        {
          plan: subscribed ? "OpenCode Go" : null,
          source: "opencode_console",
          metrics,
          fetched_at: clock,
        },
        clock,
      ),
      null,
    ];
  }
}
