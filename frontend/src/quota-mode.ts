import type { Metric } from "./types";

/** Select which side of a reported quota the cards should emphasize. */
export type QuotaDisplayMode = "used" | "remaining";

/** Return a finite reported number, treating missing and malformed values as unknown. */
function finite(value?: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/** Return a finite nonnegative quota limit, including a valid zero limit. */
function validLimit(metric: Metric): number | null {
  const limit = finite(metric.limit);
  return limit != null && limit >= 0 ? limit : null;
}

/** Derive the used percentage only when the provider supplied enough information. */
export function usedQuotaPercent(metric: Metric): number | null {
  if (metric.kind !== "quota") return null;
  const reportedPercent = finite(metric.used_percent);
  if (reportedPercent != null) return reportedPercent;
  const unit = metric.unit?.trim();
  const used = finite(metric.used);
  const remaining = finite(metric.remaining);
  if (unit === "%" && used != null) return used;
  if (unit === "%" && remaining != null) return 100 - remaining;

  const limit = validLimit(metric);
  if (limit == null || limit === 0) return null;
  if (used != null) return (used / limit) * 100;
  if (remaining != null) return ((limit - remaining) / limit) * 100;
  return null;
}

/** Calculate the displayed used or remaining reading without changing its source metric. */
export function quotaReading(
  metric: Metric,
  mode: QuotaDisplayMode,
): { value: number | null; unit: string; label: string } {
  const unit = metric.unit ?? "";
  const label = mode === "used" ? "已用量" : "剩余量";
  if (metric.kind !== "quota") return { value: null, unit, label };

  const direct = finite(mode === "used" ? metric.used : metric.remaining);
  if (direct != null) return { value: direct, unit, label };

  const limit = validLimit(metric);
  const other = finite(mode === "used" ? metric.remaining : metric.used);
  if (limit != null && other != null) {
    const value = Math.max(limit - other, 0);
    return { value, unit, label };
  }

  const percent = usedQuotaPercent(metric);
  if (percent == null) return { value: null, unit, label };
  const value = mode === "used" ? percent : Math.max(100 - percent, 0);
  return { value, unit: "%", label };
}

/** Calculate the unbounded progress percentage for the selected side of a quota. */
export function quotaProgress(
  metric: Metric,
  mode: QuotaDisplayMode,
): number | null {
  if (metric.kind !== "quota") return null;
  const limit = validLimit(metric);
  if (mode === "remaining") {
    const remaining = finite(metric.remaining);
    if (metric.unit?.trim() === "%" && remaining != null) return remaining;
    if (remaining != null && limit != null && limit > 0)
      return (remaining / limit) * 100;
    if (remaining == null) {
      const reading = quotaReading(metric, "remaining");
      if (reading.value != null && reading.unit === "%") return reading.value;
      if (reading.value != null && limit != null && limit > 0)
        return (reading.value / limit) * 100;
    }
    const usedPercent = usedQuotaPercent(metric);
    return usedPercent == null ? null : Math.max(100 - usedPercent, 0);
  }

  const reportedPercent = finite(metric.used_percent);
  if (reportedPercent != null) return reportedPercent;
  const used = finite(metric.used);
  if (metric.unit?.trim() === "%" && used != null) return used;
  if (used != null && limit != null && limit > 0) return (used / limit) * 100;
  if (used == null) return usedQuotaPercent(metric);
  return null;
}
