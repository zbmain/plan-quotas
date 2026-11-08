import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationPanels, mcpTemplate } from "./IntegrationPanels";

describe("API and MCP connection examples", () => {
  it("uses the canonical x-api-key field with a placeholder and readable JSON", () => {
    const text = mcpTemplate("https://quota.example", true);
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        "plan-quotas": {
          url: "https://quota.example/mcp",
          headers: { "x-api-key": "YOUR_API_KEY" },
        },
      },
    });
    expect(text).toContain("\n  ");
    expect(text).not.toContain("password");
  });
  it("omits credentials in public mode", () => {
    expect(
      JSON.parse(mcpTemplate("https://quota.example", false)).mcpServers[
        "plan-quotas"
      ],
    ).not.toHaveProperty("headers");
  });
  it("keeps the MCP configuration collapsed and never assumes public mode while settings load", () => {
    const markup = renderToStaticMarkup(
      <IntegrationPanels
        required={null}
        origin="https://quota.example"
        onNotice={() => {}}
      />,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="mcp.json 配置模板"');
    expect(markup).not.toContain("YOUR_API_KEY");
    expect(markup).toContain("读取访问设置后显示请求示例");
    expect(markup).not.toContain("当前免密");
  });
  it("shows a header-based API example without leaking a real key", () => {
    const markup = renderToStaticMarkup(
      <IntegrationPanels
        required
        origin="https://quota.example"
        onNotice={() => {}}
      />,
    );
    expect(markup).toContain("x-api-key: YOUR_API_KEY");
    expect(markup).toContain("?x-api-key=YOUR_API_KEY");
    expect(markup).not.toContain("password");
  });
});
