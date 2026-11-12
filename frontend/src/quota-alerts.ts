import type { Account, Dashboard, Metric } from "./types";
import {
  filterProviderMetrics,
  isLongWindow,
  isShortWindow,
  kimiDisplayMetric,
  metricDisplayLabel,
  metricGroup,
} from "./metric-display";
import { quotaProgress, quotaSeverity, warningRemaining } from "./quota-mode";

export type AlertReading = {
  key: string;
  observedAt: number;
  resetAt: number | null;
  remaining: number;
  alias: string;
  label: string;
};

export type AlertRecord = {
  key: string;
  observedAt: number;
  resetAt: number | null;
  severity: number;
};

/** Keep supplier array indices from swapping the saved history of different windows. */
function alertKey(
  account: Account,
  source: Metric,
  cycle: string,
  occurrences: Map<string, number>,
): string {
  const indexed =
    (account.provider === "kimi" && /^limit_\d+$/.test(source.id)) ||
    (account.provider === "glm" && /^glm-\d+$/.test(source.id));
  if (!indexed) return JSON.stringify([account.id, source.id, cycle]);
  const group = JSON.stringify([
    account.id,
    account.provider,
    cycle,
    source.label,
  ]);
  // Indistinguishable limits use their position only within this particular window.
  const occurrence = occurrences.get(group) ?? 0;
  occurrences.set(group, occurrence + 1);
  return `${group}#${occurrence}`;
}

/** Extract fresh short- and long-cycle model quotas from the same data shown on cards. */
export function quotaAlertReadings(dashboard: Dashboard): AlertReading[] {
  const readings: AlertReading[] = [];
  for (const account of dashboard.accounts) {
    if (!account.enabled || account.status !== "ok" || account.stale) continue;
    const row = dashboard.list?.find((item) => item.id === account.id);
    const observedAt = Date.parse(
      account.last_success_at ?? row?.updated_at ?? "",
    );
    if (!Number.isFinite(observedAt)) continue;
    const metrics = row
      ? row.token
      : filterProviderMetrics(account.data?.metrics ?? [], account.provider);
    const occurrences = new Map<string, number>();
    for (const source of metrics) {
      const metric = kimiDisplayMetric(source, account.provider);
      if (
        metricGroup(metric) !== "periodic" ||
        metric.tool ||
        metric.quota_scope === "shared" ||
        metric.quota_scope === "shared_pool"
      )
        continue;
      let label = metricDisplayLabel(metric);
      const explicitCycle = isShortWindow(metric.window)
        ? "短周期"
        : isLongWindow(metric.window)
          ? "长周期"
          : null;
      if (explicitCycle) {
        const base = label.replace(/(?:^|\s)(?:短周期|长周期)$/, "").trim();
        label = base ? `${base} ${explicitCycle}` : explicitCycle;
      } else if (!/(?:^|\s)(?:短周期|长周期)$/.test(label)) {
        continue;
      }
      const cycle = label.endsWith("短周期") ? "short" : "long";
      const key = alertKey(account, source, cycle, occurrences);
      const remaining = quotaProgress(metric, "remaining");
      if (remaining == null || !Number.isFinite(remaining)) continue;
      const parsedReset = Date.parse(metric.resets_at ?? "");
      readings.push({
        key,
        observedAt,
        resetAt: Number.isFinite(parsedReset) ? parsedReset : null,
        remaining: Math.max(0, remaining),
        alias: account.alias,
        label,
      });
    }
  }
  return readings;
}

/** Format the actual percentage without making a positive value appear exhausted. */
function formatRemaining(remaining: number): string {
  if (remaining > 0 && remaining < 0.01) return "<0.01%";
  for (let digits = 2; digits <= 12; digits++) {
    const rounded = Number(remaining.toFixed(digits));
    if (
      quotaSeverity(rounded) === quotaSeverity(remaining) &&
      (![0, 10, 20].includes(rounded) || rounded === remaining)
    )
      return `${rounded}%`;
  }
  return `${remaining}%`;
}

/** Emit each severity once per observed cycle, preserving the last known reset boundary. */
export function evaluateQuotaAlert(
  reading: AlertReading,
  previous?: AlertRecord,
): { record: AlertRecord; message: string | null } {
  if (previous && reading.observedAt <= previous.observedAt)
    return { record: previous, message: null };

  const crossedReset =
    previous?.resetAt != null &&
    previous.observedAt < previous.resetAt &&
    reading.observedAt >= previous.resetAt;
  const recoveredWithoutReset =
    previous?.resetAt == null && reading.remaining > warningRemaining;
  const previousSeverity =
    crossedReset || recoveredWithoutReset ? 0 : (previous?.severity ?? 0);
  const severity = quotaSeverity(reading.remaining);
  const shouldNotify = severity > previousSeverity;
  const nextReset =
    reading.resetAt != null && reading.resetAt > reading.observedAt
      ? reading.resetAt
      : null;
  const record: AlertRecord = {
    key: reading.key,
    observedAt: reading.observedAt,
    resetAt: crossedReset ? nextReset : (previous?.resetAt ?? nextReset),
    severity: Math.max(previousSeverity, severity),
  };
  const titles = ["", "警告", "严重", "危急"];
  const separator =
    reading.label === "短周期" || reading.label === "长周期" ? "" : " ";
  return {
    record,
    message: shouldNotify
      ? `${titles[severity]}：${reading.alias}${separator}${reading.label}额度仅剩：${formatRemaining(reading.remaining)}`
      : null,
  };
}
