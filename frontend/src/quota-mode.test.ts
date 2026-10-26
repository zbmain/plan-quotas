import { describe, expect, it } from "vitest";
import type { Metric } from "./types";
import { quotaProgress, quotaReading, usedQuotaPercent } from "./quota-mode";

const countQuota: Metric = {
  id: "tool-calls",
  label: "MCP 调用次数",
  kind: "quota",
  unit: "次",
  used: 4,
  limit: 4000,
  remaining: 3996,
};

describe("quota display modes", () => {
  it("shows reported count values in the selected direction and recalculates progress", () => {
    expect(quotaReading(countQuota, "used")).toEqual({
      value: 4,
      unit: "次",
      label: "已用量",
    });
    expect(quotaProgress(countQuota, "used")).toBeCloseTo(0.1);
    expect(quotaReading(countQuota, "remaining")).toEqual({
      value: 3996,
      unit: "次",
      label: "剩余量",
    });
    expect(quotaProgress(countQuota, "remaining")).toBeCloseTo(99.9);
  });

  it("derives the complementary count when one side and its total are reported", () => {
    expect(
      quotaReading({ ...countQuota, remaining: null }, "remaining"),
    ).toMatchObject({
      value: 3996,
      unit: "次",
    });
    expect(quotaReading({ ...countQuota, used: null }, "used")).toMatchObject({
      value: 4,
      unit: "次",
    });
  });

  it("preserves real zero and treats unavailable values as unknown", () => {
    const exhausted = { ...countQuota, used: 4000, remaining: 0 };
    expect(quotaReading(exhausted, "used").value).toBe(4000);
    expect(quotaReading(exhausted, "remaining").value).toBe(0);
    expect(quotaProgress(exhausted, "remaining")).toBe(0);

    const unknown = { ...countQuota, used: null, remaining: null, limit: null };
    expect(quotaReading(unknown, "used").value).toBeNull();
    expect(quotaReading(unknown, "remaining").value).toBeNull();
    expect(quotaProgress(unknown, "used")).toBeNull();
    expect(quotaProgress(unknown, "remaining")).toBeNull();

    const usedOnly = { ...countQuota, remaining: null, limit: null };
    expect(quotaReading(usedOnly, "remaining").value).toBeNull();
    expect(quotaProgress(usedOnly, "remaining")).toBeNull();
  });

  it("does not divide by an absent or zero total", () => {
    const zeroLimit = { ...countQuota, used: 0, remaining: 0, limit: 0 };
    expect(quotaReading(zeroLimit, "used").value).toBe(0);
    expect(quotaReading(zeroLimit, "remaining").value).toBe(0);
    expect(quotaProgress(zeroLimit, "used")).toBeNull();
    expect(quotaProgress(zeroLimit, "remaining")).toBeNull();
    expect(usedQuotaPercent(zeroLimit)).toBeNull();
  });

  it("shows only percentages when a quota has no count values", () => {
    const percentOnly: Metric = {
      id: "glm",
      label: "使用比例",
      kind: "quota",
      unit: "tokens",
      used_percent: 12,
    };
    expect(quotaReading(percentOnly, "used")).toEqual({
      value: 12,
      unit: "%",
      label: "已用量",
    });
    expect(quotaReading(percentOnly, "remaining").value).toBe(88);
    expect(quotaProgress(percentOnly, "used")).toBe(12);
    expect(quotaProgress(percentOnly, "remaining")).toBe(88);
  });

  it("derives the opposite percentage from an explicit percent-unit reading", () => {
    const remainingOnly: Metric = {
      id: "remaining-percent",
      label: "剩余用量",
      kind: "quota",
      unit: "%",
      remaining: 75,
    };
    expect(usedQuotaPercent(remainingOnly)).toBe(25);
    expect(quotaReading(remainingOnly, "used")).toMatchObject({
      value: 25,
      unit: "%",
    });
    expect(quotaProgress(remainingOnly, "remaining")).toBe(75);

    const explicitUsed = { ...remainingOnly, remaining: 80, used_percent: 30 };
    expect(quotaReading(explicitUsed, "remaining").value).toBe(80);
    expect(quotaProgress(explicitUsed, "remaining")).toBe(80);
    expect(quotaProgress({ ...explicitUsed, unit: "次" }, "remaining")).toBe(
      70,
    );
  });

  it("keeps Kimi's percentage-based usage in percentages in both modes", () => {
    const kimi: Metric = {
      id: "limit_0",
      label: "5 小时用量",
      kind: "quota",
      unit: "%",
      used: 12,
      used_percent: 12,
      limit: 100,
      remaining: null,
      window: "5h",
    };
    expect(quotaReading(kimi, "used")).toMatchObject({ value: 12, unit: "%" });
    expect(quotaReading(kimi, "remaining")).toMatchObject({
      value: 88,
      unit: "%",
    });
    expect(quotaProgress(kimi, "remaining")).toBe(88);
  });

  it("preserves overage usage and saturates only a derived remainder", () => {
    const overage = { ...countQuota, used: 5000, remaining: null };
    expect(quotaReading(overage, "used").value).toBe(5000);
    expect(quotaProgress(overage, "used")).toBe(125);
    expect(quotaReading(overage, "remaining").value).toBe(0);
    expect(quotaProgress(overage, "remaining")).toBe(0);

    const reportedDebt = { ...overage, remaining: -100 };
    expect(quotaReading(reportedDebt, "remaining").value).toBe(-100);
    expect(quotaProgress(reportedDebt, "remaining")).toBeCloseTo(-2.5);
  });

  it("never changes a source metric or invents balance usage", () => {
    const before = structuredClone(countQuota);
    quotaReading(countQuota, "remaining");
    quotaProgress(countQuota, "remaining");
    expect(countQuota).toEqual(before);

    const balance: Metric = {
      id: "balance",
      label: "账户余额",
      kind: "balance",
      unit: "CNY",
      remaining: 2,
    };
    expect(quotaReading(balance, "used").value).toBeNull();
    expect(quotaProgress(balance, "remaining")).toBeNull();
    expect(usedQuotaPercent(balance)).toBeNull();
  });
});
