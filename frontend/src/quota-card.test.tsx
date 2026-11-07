import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccountCard,
  AccountMetrics,
  historyRows,
  MetricView,
  metricReading,
} from "./App";
import type { Account, History, Metric } from "./types";

const quota: Metric = {
  id: "weekly",
  label: "周额度",
  kind: "quota",
  unit: "%",
  window: "week",
};

describe("quota cards", () => {
  it.each([
    ["minimax", "5h"],
    ["glm", "300m"],
    ["kimi", "300 TIME_UNIT_MINUTE"],
    ["opendesign", "18000s"],
    ["codex", "5h"],
    ["claude", "5 小时"],
    ["opencode", "5h"],
  ])(
    "defaults %s history to its short cycle even when other metrics come first",
    (provider, window) => {
      const metrics: Metric[] = [
        { ...quota, used: 40 },
        {
          id: "mcp-pool",
          label: "MCP 调用次数",
          kind: "quota",
          unit: "次",
          window: "5h",
          used: 4,
        },
        {
          id: "short",
          label: "套餐额度",
          kind: "quota",
          unit: "%",
          window,
          used: 12,
        },
      ];
      const html = renderToStaticMarkup(
        <AccountCard
          account={{
            id: "history-account",
            provider,
            alias: "测试账号",
            enabled: true,
            data: { metrics },
          }}
          index={0}
          displayMode="used"
          expanded
          onExpand={() => undefined}
          history={{
            account_id: "history-account",
            range: "24h",
            points: [
              {
                timestamp: "2026-11-07T00:00:00Z",
                gap: false,
                reset: false,
                metrics,
              },
            ],
          }}
          range="24h"
          onRange={() => undefined}
        />,
      );
      expect(html).toContain(
        '<option value="short" selected="">短周期</option>',
      );
      expect(html).not.toContain('<option value="weekly" selected="">');
      expect(html).not.toContain('<option value="mcp-pool" selected="">');
      expect(html).toContain('<button class="active">24 小时</button>');
    },
  );

  it("keeps actual balance history available when a channel has no short cycle", () => {
    const metrics: Metric[] = [
      {
        id: "balance",
        label: "总余额",
        kind: "balance",
        currency: "CNY",
        remaining: 12,
      },
      {
        id: "gift",
        label: "赠送余额",
        kind: "balance",
        currency: "CNY",
        remaining: 0,
      },
    ];
    const html = renderToStaticMarkup(
      <AccountCard
        account={{
          id: "balance-account",
          provider: "deepseek",
          alias: "余额账号",
          enabled: true,
          data: { metrics },
        }}
        index={0}
        displayMode="used"
        expanded
        onExpand={() => undefined}
        history={{
          account_id: "balance-account",
          range: "24h",
          points: [
            {
              timestamp: "2026-11-07T00:00:00Z",
              gap: false,
              reset: false,
              metrics,
            },
          ],
        }}
        range="24h"
        onRange={() => undefined}
      />,
    );
    expect(html).toContain(
      '<option value="balance" selected="">总余额</option>',
    );
    expect(html).toContain('<button class="active">24 小时</button>');
    expect(html).not.toContain("短周期");
  });

  it("keeps small OpenDesign percentages in percentage units in both display modes", () => {
    const metric: Metric = {
      id: "od-small-use",
      label: "短周期",
      kind: "quota",
      unit: "%",
      window: "5h",
      used: 0.625,
      limit: 100,
      remaining: 99.375,
      used_percent: 0.625,
    };
    expect(metricReading(metric, "used").value).toBe("0.63%");
    expect(metricReading(metric, "remaining").value).toBe("99.38%");
  });

  it("renders OpenDesign plan windows in both modes and keeps a zero USD wallet separate", () => {
    const metrics: Metric[] = [
      {
        id: "od-short",
        label: "短周期",
        window: "5h",
        used: 25,
        remaining: 75,
      },
      {
        id: "od-week",
        label: "长周期",
        window: "week",
        used: 2,
        remaining: 98,
      },
    ].map((metric) => ({
      ...metric,
      kind: "quota" as const,
      unit: "%",
      limit: 100,
      used_percent: metric.used,
      resets_at: null,
    }));
    const wallet: Metric = {
      id: "opendesign-wallet",
      label: "钱包余额",
      kind: "balance",
      unit: "USD",
      currency: "USD",
      remaining: 0,
    };
    for (const mode of ["used", "remaining"] as const) {
      const html = renderToStaticMarkup(
        <AccountCard
          account={{
            id: "opendesign-sample",
            provider: "opendesign",
            alias: "设计账号",
            enabled: true,
            status: "ok",
            data: { plan: "OpenDesign Go", metrics: [...metrics, wallet] },
          }}
          index={0}
          displayMode={mode}
          expanded={false}
          onExpand={() => undefined}
          range="24h"
          onRange={() => undefined}
        />,
      );
      for (const text of [
        "OpenDesign",
        "设计账号",
        'data-provider="opendesign"',
        "短周期",
        ">5h<",
        "长周期",
        ">week<",
        "钱包余额",
      ]) {
        expect(html).toContain(text);
      }
      expect(html).toMatch(/<img[^>]+src="[^"]*opendesign[^"]*"/);
      expect(html).not.toContain(">OD<");
      expect(html).toContain(
        `aria-valuetext="${mode === "used" ? "已用 25%" : "剩余 75%"}"`,
      );
      expect(html).not.toContain("额度用尽");
      expect(html).not.toContain("联网搜索");
      expect(html).not.toContain("MCP 调用");
      expect(html).not.toContain("Tokens");
      expect(html).toContain('title="OpenDesign Go">OpenDesign Go</span>');
    }
    expect(metricReading(wallet, "used")).toEqual(
      metricReading(wallet, "remaining"),
    );
    const weeklyOnly = renderToStaticMarkup(
      <AccountMetrics metrics={[metrics[1], wallet]} provider="opendesign" />,
    );
    expect(weeklyOnly).toContain(">week<");
    expect(weeklyOnly).not.toContain("5h");
  });

  it("keeps OpenDesign unknown percentages and fixed 30-day periods distinct from month", () => {
    const metric: Metric = {
      id: "od-other",
      label: "周期额度",
      kind: "quota",
      unit: "%",
      window: "30d",
      used: null,
      remaining: null,
      used_percent: null,
      resets_at: null,
    };
    for (const mode of ["used", "remaining"] as const) {
      const html = renderToStaticMarkup(
        <AccountMetrics
          metrics={[metric]}
          provider="opendesign"
          displayMode={mode}
        />,
      );
      expect(html).toContain("暂无数据");
      expect(html).toContain("30 天");
      expect(html).not.toContain("month");
      expect(html).not.toContain('class="metric-value">0%');
    }
  });

  it("shows only the GLM aggregate MCP pool in both modes", () => {
    const metrics: Metric[] = [
      {
        id: "glm-0",
        label: "MCP 调用次数",
        kind: "quota",
        unit: "次",
        used: 40,
        limit: 100,
        remaining: 60,
      },
      {
        id: "glm-mcp-search-prime",
        label: "联网搜索调用次数",
        kind: "quota",
        unit: "次",
        used: 4,
        quota_scope: "shared",
        tool: "web_search",
        availability: "available",
      },
      {
        id: "glm-mcp-web-reader",
        label: "网页阅读调用次数",
        kind: "quota",
        unit: "次",
        used: 7,
      },
    ];
    for (const displayMode of ["used", "remaining"] as const) {
      const html = renderToStaticMarkup(
        <AccountMetrics
          metrics={metrics}
          provider="glm"
          displayMode={displayMode}
        />,
      );
      expect(html).toContain("MCP 调用次数");
      expect(html).toContain(displayMode === "used" ? "40 次" : "60 次");
      expect(html).not.toContain("联网搜索");
      expect(html).not.toContain("网页读取");
      expect(html).not.toContain("调用明细");
    }
    const otherProvider = renderToStaticMarkup(
      <AccountMetrics metrics={metrics.slice(1, 2)} provider="minimax" />,
    );
    expect(otherProvider).toContain("联网搜索调用次数");
    expect(otherProvider).toContain("4 次");
  });

  it("hides GLM legacy detail metrics in history choices and plotted rows", () => {
    const history: History = {
      account_id: "glm-account",
      range: "24h",
      points: [
        {
          timestamp: "2026-10-31T12:00:00Z",
          gap: false,
          reset: false,
          metrics: [
            {
              id: "glm-0",
              label: "MCP 调用次数",
              kind: "quota",
              used: 40,
              unit: "次",
            },
            {
              id: "glm-mcp-search-prime",
              label: "联网搜索调用次数",
              kind: "quota",
              used: 4,
              unit: "次",
            },
          ],
        },
      ],
    };
    expect(
      history.points[0].metrics.filter((metric) => metric.id === "glm-0"),
    ).toHaveLength(1);
    expect(
      historyRows(history, "glm-mcp-search-prime", "glm")[0].value,
    ).toBeNull();
    expect(
      historyRows(history, "glm-mcp-search-prime", "minimax")[0].value,
    ).toBe(4);
    const html = renderToStaticMarkup(
      <AccountCard
        account={{
          id: "glm-account",
          provider: "glm",
          alias: "用户自定义别名",
          enabled: true,
          status: "ok",
          data: { metrics: history.points[0].metrics },
        }}
        index={0}
        displayMode="used"
        expanded
        onExpand={() => undefined}
        history={history}
        range="24h"
        onRange={() => undefined}
      />,
    );
    expect(html).toContain("用户自定义别名");
    expect(html).not.toContain("联网搜索调用次数");
    expect(html).not.toContain("选择历史指标");
  });
  it("shows one MiniMax shared search row with no invented remainder or progress in either mode", () => {
    const metrics: Metric[] = ["5h", "week"].map((window) => ({
      id: `minimax-web-search-${window}`,
      label: "联网搜索",
      kind: "quota",
      unit: "次",
      window,
      quota_scope: "shared",
      tool: "web_search",
      shared_quota_ids: [`${window}-quota`],
      availability: "unavailable",
      note: "共享套餐额度，独立用量暂无数据",
    }));
    for (const displayMode of ["used", "remaining"] as const) {
      const html = renderToStaticMarkup(
        <AccountMetrics
          metrics={metrics}
          provider="minimax"
          displayMode={displayMode}
        />,
      );
      expect(html.match(/共享套餐额度，独立用量暂无数据/g)).toHaveLength(1);
      expect(html).toContain("5h / week");
      expect(html).not.toContain("自定义周期");
      expect(html).not.toContain('role="progressbar"');
      expect(html).not.toContain("剩余 0 次");
    }
  });

  it("shows all OpenCode windows and switches quotas without changing wallet balance", () => {
    const metrics: Metric[] = [
      { id: "opencode-rolling", label: "短周期", window: "5h", used: 0.5 },
      { id: "opencode-weekly", label: "长周期", window: "week", used: 25 },
      { id: "opencode-monthly", label: "月度额度", window: "month", used: 90 },
    ].map((metric) => ({
      ...metric,
      kind: "quota" as const,
      unit: "%",
      limit: 100,
      remaining: 100 - metric.used,
      used_percent: metric.used,
    }));
    const balance: Metric = {
      id: "opencode-balance",
      label: "账户余额",
      kind: "balance",
      unit: "USD",
      currency: "USD",
      remaining: 27.5,
    };
    metrics.push(balance);
    const used = renderToStaticMarkup(
      <AccountMetrics metrics={metrics} provider="opencode" />,
    );
    const remaining = renderToStaticMarkup(
      <AccountMetrics
        metrics={metrics}
        provider="opencode"
        displayMode="remaining"
      />,
    );
    for (const label of ["短周期", "长周期", "月度额度", "账户余额"]) {
      expect(used).toContain(label);
    }
    for (const window of ["5h", "week", "month"]) {
      expect(used).toContain(`>${window}<`);
    }
    expect(used).toContain('class="metric-value">0.5%');
    expect(remaining).toContain('class="metric-value">99.5%');
    expect(used).toContain('aria-valuetext="已用 0.5%"');
    expect(remaining).toContain('aria-valuetext="剩余 99.5%"');
    expect(metricReading(balance, "used")).toEqual(
      metricReading(balance, "remaining"),
    );
  });

  /** Show provided plan names beside aliases and leave missing plan metadata empty. */
  it("keeps provider validation records out of public account cards", () => {
    const accounts: Account[] = [
      {
        id: "glm-account",
        provider: "glm",
        alias: "智谱账号",
        enabled: true,
        status: "ok",
        verification: "not_tested",
        data: {
          plan: "GLM Coding Plan",
          fetched_at: "2026-10-26T15:00:00Z",
          metrics: [{ ...quota, used: 25 }],
        },
      },
      {
        id: "deepseek-account",
        provider: "deepseek",
        alias: "DeepSeek 余额",
        enabled: true,
        status: "ok",
        verification: "not_tested",
        data: {
          plan: null,
          fetched_at: "2026-10-26T15:00:00Z",
          metrics: [
            {
              id: "balance",
              label: "总余额",
              kind: "balance",
              remaining: 12.5,
              currency: "CNY",
            },
          ],
        },
      },
      {
        id: "minimax-account",
        provider: "minimax",
        alias: "MiniMax 账号",
        enabled: true,
        status: "ok",
        verification: "verified",
        data: {
          plan: "MiniMax Coding Plan",
          fetched_at: "2026-10-26T15:00:00Z",
          metrics: [{ ...quota, used: 25 }],
        },
      },
      {
        id: "opendesign-account",
        provider: "opendesign",
        alias: "OpenDesign Go",
        enabled: true,
        status: "ok",
        data: {
          plan: "OpenDesign Go",
          metrics: [{ ...quota, used: 25 }],
        },
      },
    ];
    const cards = accounts.map((account, index) =>
      renderToStaticMarkup(
        <AccountCard
          account={account}
          index={index}
          displayMode="used"
          expanded={false}
          onExpand={() => undefined}
          range="24h"
          onRange={() => undefined}
        />,
      ),
    );
    for (const [index, card] of cards.entries()) {
      expect(card).toContain("采集正常");
      expect(card).not.toMatch(/尚未实测|接入已实测|订阅计划/);
      expect(card).not.toContain('class="plan-line"');
      expect(card.indexOf(`title="${accounts[index].alias}"`)).toBeLessThan(
        card.indexOf('class="provider-name"'),
      );
    }
    expect(cards[0]).toContain(
      'title="GLM Coding Plan">GLM Coding Plan</span>',
    );
    expect(cards[1]).toContain("总余额");
    expect(cards[1]).not.toContain('class="account-plan"');
    expect(cards[2]).toContain("MiniMax Coding Plan");
    expect(cards[3].match(/>OpenDesign Go<\/span>/g)).toHaveLength(2);
  });

  it("renders legacy windows with unified cycle badges without changing stored values", () => {
    const html = renderToStaticMarkup(
      <MetricView metric={{ ...quota, remaining: 75, used: 25, limit: 100 }} />,
    );
    expect(html).toContain("长周期");
    expect(html).toContain(">week<");
    expect(html).toContain("75%");
    expect(quota.window).toBe("week");
  });

  it("shows Kimi's real five-hour and seven-day used percentages in that order", () => {
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
    const html = renderToStaticMarkup(
      <AccountMetrics metrics={metrics} provider="kimi" />,
    );
    expect(html.indexOf("短周期")).toBeLessThan(html.indexOf("长周期"));
    expect(html).toContain(">5h<");
    expect(html).toContain(">week<");
    expect(html).not.toContain("5 小时用量");
    expect(html).not.toContain("7 天用量");
    expect(html).toContain("12%");
    expect(html).toContain("2%");
    expect(html).toContain('class="metric-value">12%');
    expect(html).toContain('class="metric-value">2%');
    const remaining = renderToStaticMarkup(
      <AccountMetrics
        metrics={metrics}
        provider="kimi"
        displayMode="remaining"
      />,
    );
    expect(remaining).toContain('class="metric-value">88%');
    expect(remaining).toContain('class="metric-value">98%');
    expect(remaining).toContain('aria-valuetext="剩余 88%"');
    expect(html).not.toContain("12 次");
  });

  it("defaults every provider to used and switches the primary reading and progress together", () => {
    const miniMaxMetric: Metric = {
      id: "weekly",
      label: "长周期",
      kind: "quota",
      unit: "%",
      used: 25,
      limit: 100,
      remaining: 75,
      used_percent: 25,
      window: "week",
    };
    const html = renderToStaticMarkup(<MetricView metric={miniMaxMetric} />);
    expect(metricReading(miniMaxMetric)).toEqual({
      label: "已用量",
      value: "25%",
    });
    expect(html).toContain('class="metric-value">25%');
    expect(html).toContain('aria-valuetext="已用 25%"');
    const remaining = renderToStaticMarkup(
      <MetricView metric={miniMaxMetric} displayMode="remaining" />,
    );
    expect(remaining).toContain('class="metric-value">75%');
    expect(remaining).toContain('aria-valuetext="剩余 75%"');
    expect(remaining).toContain('style="width:75%"');
  });

  it("distinguishes unknown quota from exhausted quota and does not invent counts", () => {
    expect(metricReading(quota).value).toBe("暂无数据");
    expect(metricReading({ ...quota, remaining: 0 }).value).toBe("100%");
    expect(metricReading({ ...quota, remaining: 0 }, "remaining").value).toBe(
      "0%",
    );
    expect(
      metricReading({ ...quota, unit: "tokens", used_percent: 37 }),
    ).toEqual({ label: "已用量", value: "37%" });
    const html = renderToStaticMarkup(<MetricView metric={quota} />);
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain("暂无数据");
    expect(html).not.toContain("0%");
  });

  it("displays MCP totals and per-tool observations without assigning each tool a limit", () => {
    const metrics: Metric[] = [
      {
        id: "glm-2",
        label: "MCP 调用次数",
        kind: "quota",
        unit: "次",
        used: 20,
        limit: 100,
        remaining: 80,
        window: "monthly",
      },
      {
        id: "glm-mcp-search-prime",
        label: "联网搜索调用次数",
        kind: "quota",
        unit: "次",
        used: 0,
        window: "monthly",
      },
    ];
    const html = renderToStaticMarkup(<AccountMetrics metrics={metrics} />);
    expect(html).toContain('aria-label="工具调用额度"');
    expect(html).toContain(">month<");
    expect(html).toContain("80 次");
    expect(html).toContain("0 次");
    expect(html.match(/总额 100 次/g)).toHaveLength(1);
    expect(html).toContain("渠道未提供单项上限");
    expect(html).toContain('class="metric-value">20 次');
    const remaining = renderToStaticMarkup(
      <AccountMetrics metrics={metrics} displayMode="remaining" />,
    );
    expect(remaining).toContain('class="metric-value">80 次');
    expect(remaining).toContain('aria-valuetext="剩余 80%"');
    expect(remaining).toContain("无法计算各工具的剩余次数");
    expect(remaining).toContain("<dd>暂无数据</dd>");
    expect(
      renderToStaticMarkup(<AccountMetrics metrics={[quota]} />),
    ).not.toContain("工具调用额度");
  });

  it("keeps overage values while capping only the visual progress", () => {
    const html = renderToStaticMarkup(
      <MetricView metric={{ ...quota, used_percent: 125 }} />,
    );
    expect(html).toContain("125%");
    expect(html).toContain("已超额度");
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuetext="已用 125%"');
    const remaining = renderToStaticMarkup(
      <MetricView
        metric={{ ...quota, used_percent: 125 }}
        displayMode="remaining"
      />,
    );
    expect(remaining).toContain('class="metric-value">0%');
    expect(remaining).toContain('aria-valuenow="0"');
    expect(remaining).toContain('class="progress-fill high"');
    expect(remaining).toContain("已超额度");
  });

  it("retains each currency and avoids repeating the reset word for overdue windows", () => {
    expect(
      metricReading({
        ...quota,
        kind: "balance",
        currency: "USD",
        remaining: 3.5,
      }).value,
    ).toBe("$3.5");
    expect(
      metricReading(
        { ...quota, kind: "balance", currency: "USD", remaining: 3.5 },
        "remaining",
      ).value,
    ).toBe("$3.5");
    const html = renderToStaticMarkup(
      <MetricView metric={{ ...quota, resets_at: "2020-01-01T00:00:00Z" }} />,
    );
    expect(html).toContain("即将重置");
    expect(html).not.toContain("即将重置重置");
  });
});
