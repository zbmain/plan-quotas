import { expect, it } from "vitest";
import { MCP_TOOLS } from "@plan-quotas/shared";
import { prepareArguments, MCPInputError } from "../src/mcp.js";

const readTools = [
  "list_accounts",
  "get_token_quota",
  "get_tool_quota",
  "get_history",
];
it("publishes only one channel selector for every query and query/channel for search", () => {
  for (const tool of MCP_TOOLS) {
    expect(tool.title).toMatch(/[\u4e00-\u9fff]/);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      tool.name === "web_search" ? ["query", "channel"] : ["channel"],
    );
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required ?? []).toEqual(
      tool.name === "web_search" ? ["query"] : [],
    );
    for (const [key, raw] of Object.entries(tool.inputSchema.properties)) {
      const field = raw as any;
      expect(field.title).toBeTruthy();
      expect(field.description).toBeTruthy();
      expect(field.examples.length).toBeGreaterThan(0);
      expect(field).not.toHaveProperty("anyOf");
      if (key !== "query")
        expect(field.default).toBe(tool.name === "web_search" ? "auto" : "all");
    }
  }
});
for (const name of readTools) {
  it(`queries all channel accounts by default for ${name}`, () => {
    expect(prepareArguments(name, {})).toEqual({ provider: null });
    expect(prepareArguments(name, { channel: "all" })).toEqual({
      provider: null,
    });
    expect(prepareArguments(name, { channel: "glm" })).toEqual({
      provider: "glm",
    });
  });
  it(`rejects every removed selector even when it contains a formerly valid default for ${name}`, () => {
    const removed = {
      accounts: [],
      account: "工作账号",
      account_id: "11111111-1111-4111-8111-111111111111",
      account_ids: [],
      status: "all",
      period: "all",
      window: "week",
      tool: "all",
      time_range: "24h",
      range: "24h",
      provider: "glm",
      quota_period: "5h",
      tool_name: "mcp",
    };
    for (const [field, value] of Object.entries(removed))
      expect(() =>
        prepareArguments(name, { channel: "glm", [field]: value }),
      ).toThrow("参数已更新");
  });
}
for (const [input, expected] of [
  [{ query: " 搜索 " }, { provider: null, query: "搜索" }],
  [
    { query: "q", channel: "auto" },
    { provider: null, query: "q" },
  ],
  [
    { query: "q", channel: "glm" },
    { provider: "glm", query: "q" },
  ],
  [
    { query: "q", channel: "minimax" },
    { provider: "minimax", query: "q" },
  ],
] as [Record<string, unknown>, unknown][])
  it(`normalizes search without choosing an account ${JSON.stringify(input)}`, () => {
    const before = structuredClone(input);
    expect(prepareArguments("web_search", input)).toEqual(expected);
    expect(input).toEqual(before);
  });
it("rejects account and result-count overrides before a search can be billed", () => {
  for (const field of [
    "account",
    "accounts",
    "account_id",
    "account_ids",
    "provider",
    "max_results",
    "period",
    "params",
  ]) {
    expect(() =>
      prepareArguments("web_search", {
        query: "q",
        [field]: field === "max_results" ? 10 : "must-not-echo",
      }),
    ).toThrow("参数已更新");
  }
});
for (const [name, input] of [
  ["list_accounts", { channel: null }],
  ["get_token_quota", { channel: "unknown" }],
  ["get_tool_quota", { channel: [] }],
  ["get_history", { channel: "auto" }],
  ["web_search", {}],
  ["web_search", { query: null }],
  ["web_search", { query: " " }],
  ["web_search", { query: "x".repeat(4001) }],
  ["web_search", { query: "q", channel: "all" }],
  ["web_search", { query: "q", channel: "kimi" }],
  ["web_search", { query: "q", channel: true }],
] as [string, Record<string, unknown>][])
  it(`returns safe Chinese feedback for ${name}/${Object.keys(input).join(",")}`, () => {
    try {
      prepareArguments(name, input);
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(MCPInputError);
      expect((error as Error).message).toMatch(/[\u4e00-\u9fff]/);
      expect((error as Error).message).not.toContain("must-not-echo");
    }
  });
