import { describe, expect, it } from "vitest";
import { accountIsAvailable } from "./account-availability";
import type { Account, Metric } from "./types";

const account: Account = {
  id: "sample",
  provider: "minimax",
  alias: "测试",
  enabled: true,
  status: "ok",
};
const short: Metric = {
  id: "short",
  label: "短周期",
  kind: "quota",
  unit: "%",
  window: "5h",
  used_percent: 99,
};
const weekly: Metric = {
  ...short,
  id: "weekly",
  label: "长周期",
  window: "week",
  used_percent: 0,
};

describe("account availability", () => {
  it("requires a positive remainder in every actual model window, with no low-quota threshold", () => {
    expect(accountIsAvailable(account, [short, weekly])).toBe(true);
    expect(
      accountIsAvailable(account, [{ ...short, used_percent: 100 }, weekly]),
    ).toBe(false);
    expect(
      accountIsAvailable(account, [short, { ...weekly, used_percent: 120 }]),
    ).toBe(false);
    expect(accountIsAvailable(account, [{ ...weekly, used_percent: 25 }])).toBe(
      true,
    );
  });
  it("handles request counters, direct remaining values, zero limits and unknown quota", () => {
    const counter: Metric = {
      ...short,
      unit: "次",
      used_percent: null,
      used: 2,
      limit: 10,
    };
    expect(accountIsAvailable(account, [counter])).toBe(true);
    expect(accountIsAvailable(account, [{ ...counter, remaining: 0 }])).toBe(
      false,
    );
    expect(accountIsAvailable(account, [{ ...counter, limit: 0 }])).toBe(false);
    expect(
      accountIsAvailable(account, [{ ...counter, used: null, limit: null }]),
    ).toBe(false);
    expect(
      accountIsAvailable(account, [
        { ...counter, remaining: 1, used: null, limit: null },
      ]),
    ).toBe(true);
  });
  it("does not use tool pools or wallet balances to block or rescue a plan", () => {
    const tool: Metric = {
      id: "mcp",
      label: "MCP 调用次数",
      kind: "quota",
      unit: "次",
      remaining: 0,
    };
    const wallet: Metric = {
      id: "wallet",
      label: "钱包余额",
      kind: "balance",
      remaining: 0,
    };
    expect(accountIsAvailable(account, [short, weekly, tool, wallet])).toBe(
      true,
    );
    expect(
      accountIsAvailable(account, [tool, { ...wallet, remaining: 100 }]),
    ).toBe(false);
    expect(
      accountIsAvailable(account, [
        { ...short, used_percent: 100 },
        { ...wallet, remaining: 100 },
      ]),
    ).toBe(false);
  });
  it("normalizes legacy Kimi quota counters before checking both windows", () => {
    const kimi = { ...account, provider: "kimi" };
    const metric: Metric = {
      id: "limit_0",
      label: "速率限制",
      kind: "quota",
      unit: "quota",
      window: "300 TIME_UNIT_MINUTE",
      used: 0,
      limit: 100,
    };
    expect(
      accountIsAvailable(kimi, [metric, { ...weekly, used_percent: 46 }]),
    ).toBe(true);
    expect(accountIsAvailable(kimi, [{ ...metric, used: 100 }, weekly])).toBe(
      false,
    );
  });
  it("uses DeepSeek total balance without requiring every breakdown or currency to be positive", () => {
    const deepseek = { ...account, provider: "deepseek" };
    const total: Metric = {
      id: "balance-0-total_balance",
      label: "总余额",
      kind: "balance",
      currency: "CNY",
      remaining: 0.01,
    };
    const gift = {
      ...total,
      id: "balance-0-granted_balance",
      label: "赠送余额",
      remaining: 0,
    };
    expect(accountIsAvailable(deepseek, [total, gift])).toBe(true);
    expect(
      accountIsAvailable(deepseek, [
        { ...total, remaining: 0 },
        { ...gift, remaining: 10 },
      ]),
    ).toBe(false);
    for (const remaining of [0, -1, null, NaN])
      expect(accountIsAvailable(deepseek, [{ ...total, remaining }])).toBe(
        false,
      );
    expect(
      accountIsAvailable(deepseek, [
        { ...total, remaining: 0 },
        {
          ...total,
          id: "balance-1-total_balance",
          currency: "USD",
          remaining: 1,
        },
      ]),
    ).toBe(true);
  });
  it("does not classify paused, stale, failed, or uncollected accounts as available", () => {
    for (const state of [
      { enabled: false },
      { stale: true },
      { status: "auth_required" },
      { status: "error" },
      { status: "pending" },
    ])
      expect(
        accountIsAvailable({ ...account, ...state }, [short, weekly]),
      ).toBe(false);
    expect(accountIsAvailable(account)).toBe(false);
  });
});
