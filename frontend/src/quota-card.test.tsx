import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountCard, AccountMetrics, MetricView, metricReading } from "./App";
import type { Account, Metric } from "./types";

const quota: Metric = {
  id: "weekly",
  label: "周额度",
  kind: "quota",
  unit: "%",
  window: "week",
};

describe("quota cards", () => {
  /** Show observed collection health and real plans without adapter validation badges. */
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
          plan: null,
          fetched_at: "2026-10-26T15:00:00Z",
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
    for (const card of cards) {
      expect(card).toContain("采集正常");
      expect(card).not.toMatch(/尚未实测|接入已实测|订阅计划/);
    }
    expect(cards[0]).toContain("GLM Coding Plan");
    expect(cards[1]).toContain("总余额");
    expect(cards[1]).not.toContain('class="plan-line"');
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
