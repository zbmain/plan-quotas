import { describe, expect, it } from "vitest";
import type { Account, Dashboard, Metric } from "./types";
import {
  evaluateQuotaAlert,
  quotaAlertReadings,
  type AlertReading,
} from "./quota-alerts";

const observed = Date.parse("2026-11-11T10:00:00Z");
const reset = observed + 60_000;
const short: Metric = {
  id: "short",
  label: "Coding Plan",
  kind: "quota",
  unit: "%",
  window: "5h",
  remaining: 20,
  resets_at: new Date(reset).toISOString(),
};
const account: Account = {
  id: "account-1",
  alias: "研发账号",
  provider: "opendesign",
  enabled: true,
  status: "ok",
  stale: false,
  last_success_at: new Date(observed).toISOString(),
  data: { metrics: [short] },
};

/** Build a minimal public dashboard with independently configurable accounts. */
function dashboard(accounts: Account[]): Dashboard {
  return {
    accounts,
    summary: {
      total: accounts.length,
      healthy: accounts.length,
      low: 0,
      errors: 0,
    },
    interval_minutes: 1,
  };
}

const reading: AlertReading = {
  key: "account-1/short",
  observedAt: observed,
  resetAt: reset,
  remaining: 20,
  alias: "研发账号",
  label: "短周期",
};

describe("quotaAlertReadings", () => {
  it("selects fresh subscription cycles and excludes balances, costs, tools and unknown percentages", () => {
    const metrics: Metric[] = [
      short,
      {
        ...short,
        id: "long",
        label: "Sonnet 7 天",
        window: "week",
        remaining: 5,
      },
      { ...short, id: "wallet", kind: "balance", label: "钱包余额" },
      { ...short, id: "cost", kind: "cost" },
      { ...short, id: "mcp", label: "MCP 调用次数" },
      { ...short, id: "month", window: "month" },
      { ...short, id: "unknown", remaining: null },
    ];
    const results = quotaAlertReadings(
      dashboard([{ ...account, data: { metrics } }]),
    );
    expect(results).toEqual([
      {
        key: JSON.stringify([account.id, "short", "short"]),
        observedAt: observed,
        resetAt: reset,
        remaining: 20,
        alias: "研发账号",
        label: "短周期",
      },
      {
        key: JSON.stringify([account.id, "long", "long"]),
        observedAt: observed,
        resetAt: reset,
        remaining: 5,
        alias: "研发账号",
        label: "Sonnet 长周期",
      },
    ]);
    expect(
      quotaAlertReadings(
        dashboard([
          { ...account, status: "error" },
          { ...account, stale: true },
          { ...account, enabled: false },
          { ...account, last_success_at: null },
        ]),
      ),
    ).toEqual([]);
  });

  it("uses the card projection, including Kimi legacy windows and multiple accounts", () => {
    const kimi: Account = {
      ...account,
      id: "kimi",
      provider: "kimi",
      alias: "Kimi",
      data: { metrics: [] },
    };
    const input = dashboard([kimi, account]);
    input.list = [
      {
        id: "kimi",
        provider: "kimi",
        alias: "Kimi",
        enabled: true,
        token: [
          {
            id: "coding",
            label: "7 天用量",
            kind: "quota",
            window: "套餐周期",
            used: 9,
            limit: 10,
          },
        ],
        tools: [],
        balances: [],
      },
    ];
    const results = quotaAlertReadings(input);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      remaining: 10,
      label: "长周期",
      alias: "Kimi",
    });
    expect(results[0].key).not.toBe(results[1].key);
  });

  it("recognizes a model-only label by its window and excludes shared or tool metrics", () => {
    const metrics: Metric[] = [
      { ...short, id: "sonnet", label: "Sonnet", window: "week" },
      { ...short, id: "tool", tool: "web_search" },
      { ...short, id: "shared", quota_scope: "shared" },
      { ...short, id: "misleading", label: "长周期备份", window: null },
    ];
    const input = dashboard([{ ...account, data: { metrics } }]);
    expect(quotaAlertReadings(input)).toMatchObject([
      { label: "Sonnet 长周期", remaining: 20 },
    ]);
    input.list = [
      {
        id: account.id,
        provider: account.provider,
        alias: account.alias,
        enabled: true,
        token: [metrics[0]],
        tools: [short],
        balances: [],
      },
    ];
    expect(quotaAlertReadings(input)).toMatchObject([
      { label: "Sonnet 长周期" },
    ]);
  });

  it.each([
    ["kimi", "limit_0", "limit_1"],
    ["glm", "glm-0", "glm-1"],
  ])(
    "keeps %s cycle alerts independent when upstream indexes move",
    (provider, firstId, secondId) => {
      const firstMetrics: Metric[] = [
        {
          ...short,
          id: firstId,
          label: "套餐额度",
          remaining: 20,
          used_percent: 80,
        },
        {
          ...short,
          id: secondId,
          label: "套餐额度",
          window: "week",
          remaining: 9,
          used_percent: 91,
        },
      ];
      const initial = quotaAlertReadings(
        dashboard([{ ...account, provider, data: { metrics: firstMetrics } }]),
      );
      const nextMetrics = [
        { ...firstMetrics[1], id: firstId },
        { ...firstMetrics[0], id: secondId },
      ];
      const next = quotaAlertReadings(
        dashboard([
          {
            ...account,
            provider,
            last_success_at: new Date(observed + 1).toISOString(),
            data: { metrics: nextMetrics },
          },
        ]),
      );
      expect(next[1].key).toBe(initial[0].key);
      expect(next[0].key).toBe(initial[1].key);
      const saved = evaluateQuotaAlert(initial[0]);
      expect(evaluateQuotaAlert(next[1], saved.record).message).toBeNull();
      expect(evaluateQuotaAlert(next[0]).message).toContain("严重");
      const duplicates = quotaAlertReadings(
        dashboard([
          {
            ...account,
            provider,
            data: {
              metrics: [firstMetrics[0], { ...firstMetrics[0], id: secondId }],
            },
          },
        ]),
      );
      expect(duplicates[0].key).not.toBe(duplicates[1].key);
    },
  );
});

describe("evaluateQuotaAlert", () => {
  it("sends the current severity and actual percentage, once per severity per cycle", () => {
    const warning = evaluateQuotaAlert(reading);
    expect(warning.message).toBe("警告：研发账号短周期额度仅剩：20%");
    expect(evaluateQuotaAlert(reading, warning.record).message).toBeNull();
    expect(
      evaluateQuotaAlert(
        { ...reading, observedAt: observed - 1, remaining: 0 },
        warning.record,
      ).message,
    ).toBeNull();
    const serious = evaluateQuotaAlert(
      { ...reading, observedAt: observed + 1, remaining: 8 },
      warning.record,
    );
    expect(serious.message).toBe("严重：研发账号短周期额度仅剩：8%");
    const improved = evaluateQuotaAlert(
      { ...reading, observedAt: observed + 2, remaining: 19 },
      serious.record,
    );
    expect(improved.message).toBeNull();
    expect(
      evaluateQuotaAlert(
        { ...reading, observedAt: observed + 3, remaining: 9 },
        improved.record,
      ).message,
    ).toBeNull();
    const exhausted = evaluateQuotaAlert(
      { ...reading, observedAt: observed + 4, remaining: 0 },
      improved.record,
    );
    expect(exhausted.message).toBe("危急：研发账号短周期额度仅剩：0%");
    expect(
      evaluateQuotaAlert(
        { ...reading, observedAt: observed + 5, remaining: -2 },
        exhausted.record,
      ).message,
    ).toBeNull();
  });

  it("emits only the highest reached severity when several thresholds are crossed together", () => {
    expect(evaluateQuotaAlert({ ...reading, remaining: 0 }).message).toContain(
      "危急",
    );
    expect(evaluateQuotaAlert({ ...reading, remaining: 10 }).message).toContain(
      "严重",
    );
    expect(
      evaluateQuotaAlert({ ...reading, remaining: 20.00001 }).message,
    ).toBeNull();
  });

  it("preserves positive decimals and does not round a value across a threshold", () => {
    expect(
      evaluateQuotaAlert({ ...reading, remaining: 0.00001 }).message,
    ).toContain("<0.01%");
    expect(
      evaluateQuotaAlert({ ...reading, remaining: 10.001 }).message,
    ).toContain("10.001%");
    expect(
      evaluateQuotaAlert({ ...reading, remaining: 19.999 }).message,
    ).toContain("19.999%");
  });

  it("rearms after an observed reset boundary, not when a reported reset time changes", () => {
    const first = evaluateQuotaAlert(reading);
    const changedReset = evaluateQuotaAlert(
      { ...reading, observedAt: observed + 1, resetAt: reset + 60_000 },
      first.record,
    );
    expect(changedReset.message).toBeNull();
    expect(changedReset.record.resetAt).toBe(reset);
    const newCycle = evaluateQuotaAlert(
      { ...reading, observedAt: reset + 1, resetAt: reset + 60_000 },
      changedReset.record,
    );
    expect(newCycle.message).toContain("警告");
    expect(newCycle.record.resetAt).toBe(reset + 60_000);
  });

  it("rearms after recovery above 20% when no reset time is known", () => {
    const first = evaluateQuotaAlert({ ...reading, resetAt: null });
    const recovered = evaluateQuotaAlert(
      { ...reading, resetAt: null, observedAt: observed + 1, remaining: 21 },
      first.record,
    );
    expect(recovered.message).toBeNull();
    expect(
      evaluateQuotaAlert(
        { ...reading, resetAt: null, observedAt: observed + 2 },
        recovered.record,
      ).message,
    ).toContain("警告");
  });
});
