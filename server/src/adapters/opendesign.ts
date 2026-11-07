import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Credentials, UsageResult } from "@plan-quotas/shared";
import {
  AdapterError,
  object,
  requireCredential,
  requestJSON,
  metric,
  usage,
  now,
  timestamp,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";
const Precise = Decimal.clone({ precision: 64 });
const tiers: Record<string, string> = {
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
};

/** Parse only bounded decimal strings, avoiding any Number conversion before division. */
function decimal(value: any, signed = false): Decimal | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !(signed ? /^-?[0-9]+(?:\.[0-9]+)?$/ : /^[0-9]+(?:\.[0-9]+)?$/).test(value)
  )
    throw new AdapterError("invalid_response");
  return new Precise(value);
}
/** Reduce a credit ratio to a finite percent; a zero denominator remains unknown. */
function percent(value: Decimal | null, limit: Decimal | null): number | null {
  if (value === null || limit === null || limit.lte(0)) return null;
  const result = value.div(limit).mul(100).toNumber();
  if (!Number.isFinite(result)) throw new AdapterError("invalid_response");
  return result;
}
/** Validate the exact personal workspace and never publish its private member identifier. */
export function openDesignUsage(payload: any, workspace: string): UsageResult {
  const root = object(payload),
    plan = object(root.codingPlan);
  if (
    root.schemaVersion !== 1 ||
    root.workspaceId !== workspace ||
    root.modelId != null ||
    typeof root.workspaceMemberId !== "string" ||
    !root.workspaceMemberId.trim() ||
    plan.workspaceId !== workspace ||
    typeof plan.eligible !== "boolean" ||
    (plan.tier != null && typeof plan.tier !== "string")
  )
    throw new AdapterError("invalid_response");
  if (
    !tiers[plan.tier] ||
    plan.eligible !== true ||
    root.workspaceType === "team" ||
    plan.workspaceType === "team"
  )
    throw new AdapterError("subscription_unavailable");
  if (
    !Array.isArray(plan.windows) ||
    !plan.windows.length ||
    plan.windows.length > 100
  )
    throw new AdapterError("invalid_response");
  const metrics = plan.windows.map((value: any) => {
    const window = object(value),
      duration = window.durationSeconds,
      policy = window.policyId;
    if (
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      typeof policy !== "string" ||
      !policy.trim() ||
      policy.length > 512 ||
      !["activity_triggered", "anchored_recurring"].includes(window.resetMode)
    )
      throw new AdapterError("invalid_response");
    const used = decimal(window.usedCredits),
      remaining = decimal(window.remainingCredits),
      limit = decimal(window.limitCredits);
    if (limit !== null && remaining !== null && remaining.gt(limit))
      throw new AdapterError("invalid_response");
    let usedPercent = percent(used, limit),
      remainingPercent = percent(remaining, limit);
    if (usedPercent === null && remainingPercent !== null)
      usedPercent = Math.max(0, 100 - remainingPercent);
    if (remainingPercent === null && usedPercent !== null)
      remainingPercent = Math.max(0, 100 - usedPercent);
    let cadence = `${duration}s`,
      label = "周期额度";
    if (duration === 18000) {
      label = "短周期";
      cadence = "5h";
    } else if (duration === 604800) {
      label = "长周期";
      cadence = "week";
    } else
      for (const [divisor, suffix] of [
        [86400, "d"],
        [3600, "h"],
        [60, "m"],
      ] as const)
        if (duration % divisor === 0) {
          cadence = `${duration / divisor}${suffix}`;
          break;
        }
    let reset: string | null = null;
    if (window.resetsAt != null) {
      if (
        typeof window.resetsAt !== "string" ||
        !/(Z|[+-]\d\d:\d\d)$/.test(window.resetsAt) ||
        (reset = timestamp(window.resetsAt)) === null
      )
        throw new AdapterError("invalid_response");
    }
    return metric({
      id: `opendesign-${duration}-${createHash("sha256").update(policy).digest("hex").slice(0, 16)}`,
      label,
      unit: "%",
      used: usedPercent,
      limit: limit !== null && limit.gt(0) ? 100 : null,
      remaining: remainingPercent,
      used_percent: usedPercent,
      window: cadence,
      resets_at: reset,
    });
  });
  if (new Set(metrics.map((row: any) => row.id)).size !== metrics.length)
    throw new AdapterError("invalid_response");
  metrics.sort(
    (a: any, b: any) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]),
  );
  const balance = decimal(root.balanceUsd, true);
  if (balance !== null) {
    const amount = balance.toNumber();
    if (!Number.isFinite(amount)) throw new AdapterError("invalid_response");
    metrics.push(
      metric({
        id: "opendesign-wallet",
        label: "钱包余额",
        kind: "balance",
        unit: "USD",
        currency: "USD",
        remaining: amount,
      }),
    );
  }
  return usage(
    {
      plan: `OpenDesign ${tiers[plan.tier]}`,
      source: "opendesign_billing",
      metrics,
    },
    now(),
  );
}
export class OpenDesignAdapter implements Adapter {
  /** Use one imported credential and an explicit personal workspace on the fixed billing host. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (!["control_key", "cookie"].includes(authType))
      throw new AdapterError("invalid_credentials");
    const credential = requireCredential(
        credentials,
        authType === "control_key" ? "control_key" : "cookie",
      ),
      workspace = requireCredential(credentials, "workspace_id");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace) || /[\r\n]/.test(credential))
      throw new AdapterError("invalid_credentials");
    const headers: Record<string, string> = { Accept: "application/json" };
    headers[authType === "cookie" ? "Cookie" : "Authorization"] =
      authType === "cookie" ? credential : `Bearer ${credential}`;
    return [
      openDesignUsage(
        await requestJSON(
          client,
          "GET",
          `https://amr-api.open-design.ai/api/v1/workspaces/${workspace}/billing/funding-check`,
          { headers, forbidden_code: "subscription_unavailable" },
        ),
        workspace,
      ),
      null,
    ];
  }
}
