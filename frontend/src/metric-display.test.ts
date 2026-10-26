import { describe, expect, it } from "vitest";
import {
  metricDisplayLabel,
  metricGroup,
  metricUnitLabel,
  metricWindowLabel,
  kimiDisplayMetric,
} from "./metric-display";
import type { Metric } from "./types";

describe("Chinese quota labels", () => {
  it("uses the same short and long cycle names for MiniMax and legacy snapshots", () => {
    const short: Metric = {
      id: "interval-0",
      label: "短周期",
      kind: "quota",
      unit: "%",
      window: "5h",
    };
    const long: Metric = {
      id: "weekly-0",
      label: "周额度",
      kind: "quota",
      unit: "%",
      window: "week",
    };
    expect(metricDisplayLabel(short)).toBe("短周期");
    expect(metricWindowLabel(short.window)).toBe("5h");
    expect(metricDisplayLabel(long)).toBe("长周期");
    expect(metricWindowLabel(long.window)).toBe("week");
    expect(metricDisplayLabel({ ...long, label: "长周期" })).toBe("长周期");
  });

  it("normalizes representative quota labels from the ten supported channels", () => {
    const cases: Array<[Metric, string, string]> = [
      [
        { id: "glm-0", label: "GLM Coding Plan", kind: "quota", window: "5h" },
        "短周期",
        "5h",
      ],
      [
        {
          id: "coding",
          label: "Coding Plan",
          kind: "quota",
          window: "套餐周期",
        },
        "套餐额度",
        "套餐周期",
      ],
      [
        { id: "session", label: "5 小时", kind: "quota", window: "5 小时" },
        "短周期",
        "5h",
      ],
      [
        { id: "monthly", label: "账单月", kind: "quota", window: "monthly" },
        "账单月",
        "month",
      ],
      [
        { id: "balance", label: "总余额", kind: "balance", currency: "CNY" },
        "总余额",
        "",
      ],
      [
        {
          id: "primary_window",
          label: "主要额度",
          kind: "quota",
          window: "主要额度",
        },
        "主要额度",
        "主要额度",
      ],
      [
        { id: "five_hour", label: "5 小时", kind: "quota", window: "5 小时" },
        "短周期",
        "5h",
      ],
      [
        {
          id: "plan_apiPercentUsed",
          label: "Other Models",
          kind: "quota",
          window: "账单周期",
        },
        "其他模型额度",
        "账单周期",
      ],
      [
        {
          id: "gpt-4",
          label: "GPT-4 使用量",
          kind: "quota",
          unit: "次",
          window: "账单周期",
        },
        "GPT-4 使用量",
        "账单周期",
      ],
      [
        {
          id: "gemini-pro",
          label: "Gemini Pro",
          kind: "quota",
          window: "模型额度",
        },
        "Gemini Pro",
        "模型额度",
      ],
    ];

    for (const [metric, expectedLabel, expectedWindow] of cases) {
      expect(metricDisplayLabel(metric)).toBe(expectedLabel);
      expect(metricWindowLabel(metric.window)).toBe(expectedWindow);
    }
  });

  it("preserves model-specific weekly quotas and translates duration units", () => {
    expect(
      metricDisplayLabel({
        id: "seven_day_sonnet",
        label: "Sonnet 7 天",
        kind: "quota",
      }),
    ).toBe("Sonnet 长周期");
    expect(metricWindowLabel("Sonnet 7 天")).toBe("week");
    expect(
      metricDisplayLabel({ id: "weekly", label: "7 天", kind: "quota" }),
    ).toBe("长周期");
    expect(metricWindowLabel("15 minutes")).toBe("15 分钟");
    expect(metricWindowLabel("5hours")).toBe("5h");
    expect(metricWindowLabel("300分钟")).toBe("5h");
    expect(metricWindowLabel("300m")).toBe("5h");
    expect(
      metricDisplayLabel({
        id: "glm-4",
        label: "GLM Coding Plan",
        kind: "quota",
        window: "300m",
      }),
    ).toBe("短周期");
  });

  it("uses GLM's reported window to distinguish otherwise identical quota labels", () => {
    const limits: Metric[] = [
      { id: "glm-0", label: "GLM Coding Plan", kind: "quota", window: "5h" },
      { id: "glm-1", label: "GLM Coding Plan", kind: "quota", window: "week" },
      {
        id: "glm-2",
        label: "GLM Coding Plan",
        kind: "quota",
        window: "monthly",
      },
      {
        id: "glm-3",
        label: "GLM Coding Plan",
        kind: "quota",
        window: "session",
      },
    ];
    expect(limits.map(metricDisplayLabel)).toEqual([
      "短周期",
      "长周期",
      "月度额度",
      "套餐额度",
    ]);
    expect(limits.map((metric) => metricWindowLabel(metric.window))).toEqual([
      "5h",
      "week",
      "month",
      "会话",
    ]);
    expect(
      metricDisplayLabel({
        id: "session",
        label: "session quota",
        kind: "quota",
        window: "session",
      }),
    ).toBe("会话额度");
  });

  it("normalizes Kimi's minute-based weekly window without renaming balance metrics", () => {
    const metric: Metric = {
      id: "limit_1",
      label: "速率限制",
      kind: "quota",
      unit: "quota",
      window: "10080 MINUTE",
    };
    expect(metricDisplayLabel(metric)).toBe("长周期");
    expect(metricWindowLabel(metric.window)).toBe("week");
    expect(
      metricDisplayLabel({ ...metric, kind: "balance", label: "账户余额" }),
    ).toBe("账户余额");
  });

  it("maps Kimi's five-hour request window and subscription window independently", () => {
    const metrics: Metric[] = [
      {
        id: "coding",
        label: "Coding Plan",
        kind: "quota",
        unit: "quota",
        used: 2,
        limit: 100,
        remaining: 98,
        used_percent: 2,
        window: "套餐周期",
      },
      {
        id: "limit_0",
        label: "速率限制",
        kind: "quota",
        unit: "quota",
        used: 12,
        limit: 100,
        remaining: 88,
        used_percent: 12,
        window: "300 TIME_UNIT_MINUTE",
      },
    ];

    const [weekly, fiveHour] = metrics.map((metric) =>
      kimiDisplayMetric(metric, "kimi"),
    );
    expect(fiveHour.label).toBe("短周期");
    expect(fiveHour.window).toBe("5h");
    expect(metricDisplayLabel(fiveHour)).toBe("短周期");
    expect(metricWindowLabel(fiveHour.window)).toBe("5h");
    expect(fiveHour.unit).toBe("%");
    expect(fiveHour.used).toBe(12);
    expect(fiveHour.used_percent).toBe(12);
    expect(fiveHour.remaining).toBeNull();
    expect(weekly.label).toBe("长周期");
    expect(weekly.window).toBe("7d");
    expect(metricDisplayLabel(weekly)).toBe("长周期");
    expect(metricWindowLabel(weekly.window)).toBe("week");
    expect(weekly.used).toBe(2);
    expect(metricDisplayLabel({ ...fiveHour, label: "5 小时用量" })).toBe(
      "短周期",
    );
    expect(metricDisplayLabel({ ...weekly, label: "7 天用量" })).toBe("长周期");
    expect(metrics[0].window).toBe("套餐周期");
    expect(metrics[1].window).toBe("300 TIME_UNIT_MINUTE");
    expect(kimiDisplayMetric(metrics[0], "glm")).toBe(metrics[0]);
  });

  it("uses only measured or safely derived Kimi percentages and preserves zero and unknown", () => {
    const metric: Metric = {
      id: "limit_0",
      label: "速率限制",
      kind: "quota",
      unit: "quota",
      window: "300 TIME_UNIT_MINUTE",
    };
    expect(
      kimiDisplayMetric(
        { ...metric, used: 0, limit: 100, remaining: 100 },
        "kimi",
      ).used,
    ).toBe(0);
    expect(
      kimiDisplayMetric({ ...metric, used: 7, limit: 100 }, "kimi")
        .used_percent,
    ).toBeCloseTo(7);
    expect(
      kimiDisplayMetric({ ...metric, used: 20, limit: 0 }, "kimi").used_percent,
    ).toBeNull();
    expect(kimiDisplayMetric(metric, "kimi").used).toBeNull();
    const unconfirmedSession = { ...metric, window: "session" };
    expect(kimiDisplayMetric(unconfirmedSession, "kimi")).toBe(
      unconfirmedSession,
    );
  });

  it("labels MCP and tool invocation counts in Chinese without merging tools", () => {
    const metrics: Metric[] = [
      {
        id: "glm-mcp-total",
        label: "MCP 调用次数",
        kind: "quota",
        unit: "次",
        window: "monthly",
      },
      {
        id: "glm-mcp-search-prime",
        label: "联网搜索调用次数",
        kind: "quota",
        unit: "次",
        window: "monthly",
      },
      {
        id: "glm-mcp-web-reader",
        label: "网页阅读调用次数",
        kind: "quota",
        unit: "次",
        window: "monthly",
      },
    ];
    expect(metrics.map(metricDisplayLabel)).toEqual([
      "MCP 调用次数",
      "联网搜索调用次数",
      "网页阅读调用次数",
    ]);
    expect(metrics.map(metricGroup)).toEqual(["tool", "tool", "tool"]);
    expect(metrics.map((metric) => metricUnitLabel(metric.unit))).toEqual([
      "次",
      "次",
      "次",
    ]);
  });

  it("does not invent a period, unit, or zero value for unknown data", () => {
    expect(metricWindowLabel(null)).toBe("");
    expect(metricWindowLabel("future_provider_window")).toBe("自定义周期");
    expect(metricWindowLabel("quota-3")).toBe("其他周期");
    expect(
      metricDisplayLabel({
        id: "glm-9",
        label: "GLM Coding Plan",
        kind: "quota",
        window: "future",
      }),
    ).toBe("套餐额度");
    expect(metricUnitLabel(null)).toBe("");
    expect(metricUnitLabel("mystery_unit")).toBe("单位未知");
  });

  it("preserves currency codes and maps API units to Chinese display units", () => {
    expect(metricUnitLabel("requests")).toBe("次");
    expect(metricUnitLabel("tokens")).toBe("令牌");
    expect(metricUnitLabel("quota")).toBe("额度");
    expect(metricUnitLabel("USD")).toBe("USD");
    expect(metricUnitLabel("CNY")).toBe("CNY");
  });

  it("translates common cadence aliases without classifying generic requests as tools", () => {
    expect(metricWindowLabel("7d")).toBe("week");
    expect(metricWindowLabel("7 天")).toBe("week");
    expect(metricWindowLabel("1w")).toBe("week");
    expect(metricWindowLabel("18000s")).toBe("5h");
    expect(metricWindowLabel("monthly")).toBe("month");
    expect(metricWindowLabel("每月")).toBe("month");
    expect(metricWindowLabel("1mo")).toBe("month");
    expect(metricWindowLabel("1 month")).toBe("month");
    expect(metricWindowLabel("30d")).toBe("30 天");
    expect(metricWindowLabel("2mo")).toBe("2 个月");
    expect(
      metricDisplayLabel({
        id: "monthly",
        label: "Coding Plan",
        kind: "quota",
        window: "1mo",
      }),
    ).toBe("月度额度");
    expect(metricWindowLabel("1d")).toBe("1 天");
    expect(metricWindowLabel("1h")).toBe("1 小时");
    expect(metricWindowLabel("30m")).toBe("30 分钟");
    expect(metricWindowLabel("60s")).toBe("60 秒");
    expect(metricWindowLabel("daily")).toBe("每日");
    expect(metricWindowLabel("yearly")).toBe("每年");
    expect(metricWindowLabel("billing_cycle")).toBe("账单周期");
    expect(metricWindowLabel("payg")).toBe("按量付费");
    expect(
      metricGroup({
        id: "requests",
        label: "请求额度",
        unit: "requests",
        kind: "quota",
      }),
    ).toBe("periodic");
    expect(
      metricGroup({
        id: "glm_time_limit",
        label: "调用额度",
        unit: "次",
        kind: "quota",
      }),
    ).toBe("tool");
    expect(
      metricGroup({
        id: "glm_mcp-search-prime",
        label: "联网搜索调用次数",
        kind: "quota",
      }),
    ).toBe("tool");
  });
});
