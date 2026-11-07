import type { Account, Metric } from "./types";
import { kimiDisplayMetric, metricGroup } from "./metric-display";
import { quotaReading, usedQuotaPercent } from "./quota-mode";

/** Require fresh, successful data and positive remaining allowance in every reported model window. */
export function accountIsAvailable(
  account: Account,
  metrics?: Metric[],
): boolean {
  if (!account.enabled || account.status !== "ok" || account.stale)
    return false;
  const reported = metrics ?? account.data?.metrics ?? [];
  const windows = reported
    .map((metric) => kimiDisplayMetric(metric, account.provider))
    .filter((metric) => metricGroup(metric) === "periodic");
  if (account.provider !== "deepseek") {
    return (
      windows.length > 0 &&
      windows.every((metric) => {
        if (metric.limit === 0 || (usedQuotaPercent(metric) ?? 0) >= 100)
          return false;
        const remaining = quotaReading(metric, "remaining").value;
        return remaining != null && remaining > 0;
      })
    );
  }
  // Total balances take precedence over their gift/top-up breakdown; costs are not balances.
  const balances = reported.filter((metric) => metric.kind === "balance");
  const totals = balances.filter(
    (metric) =>
      metric.id.endsWith("-total_balance") || metric.label === "总余额",
  );
  return (totals.length ? totals : balances).some(
    (metric) =>
      metric.remaining != null &&
      Number.isFinite(metric.remaining) &&
      metric.remaining > 0,
  );
}
