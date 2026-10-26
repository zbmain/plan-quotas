import { describe, expect, it } from "vitest";
import {
  buildAccountPayload,
  formatHistoryTime,
  historyMetricValue,
  historyRows,
  historySeriesLabel,
  metricValue,
  progressOf,
  rawProgressOf,
  resetCountdown,
} from "./App";
import type { History, Metric } from "./types";

describe("metric display logic", () => {
  it("keeps unknown readings distinct from zero", () => {
    const quota: Metric = {
      id: "daily",
      label: "每日额度",
      kind: "quota",
      unit: "%",
    };
    expect(metricValue(null, quota)).toBe("暂无数据");
    expect(metricValue(0, quota)).toBe("0%");
    expect(progressOf(quota)).toBeNull();
  });

  it("derives quota progress from used and total values and clamps overages", () => {
    const quota: Metric = {
      id: "week",
      label: "周额度",
      kind: "quota",
      used: 12,
      limit: 20,
    };
    expect(progressOf(quota)).toBe(60);
    expect(progressOf({ ...quota, used: 25 })).toBe(100);
    expect(rawProgressOf({ ...quota, used: 25 })).toBe(125);
    expect(progressOf({ ...quota, used_percent: -4 })).toBe(0);
    expect(rawProgressOf({ ...quota, used_percent: 120 })).toBe(120);
  });

  it("formats a balance with its reported currency", () => {
    const balance: Metric = {
      id: "wallet",
      label: "余额",
      kind: "balance",
      currency: "CNY",
    };
    expect(metricValue(3.5, balance)).toBe("¥3.5");
    expect(progressOf(balance)).toBeNull();
  });

  it("labels the plotted quota reading as remaining or used", () => {
    const remainingQuota: Metric = {
      id: "week",
      label: "周额度",
      kind: "quota",
      used: 12,
      remaining: 8,
      limit: 20,
    };
    expect(historyMetricValue(remainingQuota)).toBe(8);
    expect(historySeriesLabel(remainingQuota)).toBe("周额度 · 剩余");
    expect(historyMetricValue({ ...remainingQuota, remaining: null })).toBe(12);
    expect(historySeriesLabel({ ...remainingQuota, remaining: null })).toBe(
      "周额度 · 已用",
    );
  });

  it("keeps missing buckets and inserts a break before a reset sample", () => {
    const quota: Metric = {
      id: "week",
      label: "周额度",
      kind: "quota",
      remaining: 8,
      limit: 20,
    };
    const history: History = {
      account_id: "test-account",
      range: "24h",
      points: [
        {
          timestamp: "2026-10-24T12:00:00Z",
          metrics: [quota],
          gap: false,
          reset: false,
        },
        {
          timestamp: "2026-10-24T12:05:00Z",
          metrics: [],
          gap: true,
          reset: false,
        },
        {
          timestamp: "2026-10-24T12:10:00Z",
          metrics: [{ ...quota, remaining: 20 }],
          gap: false,
          reset: true,
        },
      ],
    };
    const rows = historyRows(history, "week");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ value: null, gap: true });
    expect(rows[2]).toMatchObject({ value: null, resetBreak: true });
    expect(rows[3]).toMatchObject({ value: 20, reset: true });
    expect(
      historyRows(history, "missing").every((row) => row.value === null),
    ).toBe(true);
  });

  it("formats dates in Shanghai time and reports reset countdowns", () => {
    expect(formatHistoryTime("2026-10-24T16:00:00Z", "24h")).toBe("00:00");
    expect(formatHistoryTime("2026-10-24T16:00:00Z", "7d")).toBe("10/25 00时");
    expect(
      resetCountdown(
        "2026-10-25T01:00:00Z",
        Date.parse("2026-10-25T00:00:00Z"),
      ),
    ).toBe("1 小时 0 分钟后");
  });
});

describe("account request payloads", () => {
  const draft = {
    provider: "minimax",
    alias: "个人账号",
    auth_type: "api_key",
    credentials: { api_key: " secret ", empty: "  " },
  };

  it("omits provider from update payload and preserves stored credentials when blank", () => {
    const payload = buildAccountPayload(draft, true, 4);
    expect(payload).toEqual({
      alias: "个人账号",
      auth_type: "api_key",
      credentials: { api_key: " secret " },
    });
    expect("provider" in payload).toBe(false);
    expect("enabled" in payload).toBe(false);
  });

  it("includes provider and initial account settings when creating", () => {
    expect(buildAccountPayload(draft, false, 4)).toEqual({
      provider: "minimax",
      alias: "个人账号",
      auth_type: "api_key",
      credentials: { api_key: " secret " },
      enabled: true,
      order: 4,
    });
  });
});
