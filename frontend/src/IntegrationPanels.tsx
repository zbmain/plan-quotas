import { useState } from "react";
import { Braces, ChevronDown, FileJson } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { MCPToolGuide } from "./MCPToolGuide";

/** Build a portable template containing placeholders only, with public mode omitting credentials. */
export function mcpTemplate(origin: string, required: boolean): string {
  return JSON.stringify(
    {
      mcpServers: {
        "plan-quotas": {
          url: `${origin}/mcp`,
          ...(required ? { headers: { apikey: "YOUR_API_KEY" } } : {}),
        },
      },
    },
    null,
    2,
  );
}

/** Present independent API and MCP panels using only the successfully loaded saved access mode. */
export function IntegrationPanels({
  required,
  onNotice,
  origin = location.origin,
}: {
  required: boolean | null;
  onNotice: (message: string) => void;
  origin?: string;
}) {
  const [open, setOpen] = useState(false);
  const curl = `curl${required ? " -H 'apikey: YOUR_API_KEY'" : ""} '${origin}/info'`;
  return (
    <>
      <section
        className="admin-panel settings-panel"
        aria-labelledby="api-heading"
      >
        <div className="panel-title">
          <div>
            <h2 id="api-heading">API 接入</h2>
            <p>通过 /info 获取账号、套餐与工具额度</p>
          </div>
          <Braces size={18} className="panel-icon" />
        </div>
        <div className="mcp-endpoint">
          <span>接口地址</span>
          <code>{origin}/info</code>
          <CopyButton
            text={`${origin}/info`}
            label="复制 API 接口地址"
            successMessage="API 接口地址已复制"
            onNotice={onNotice}
          />
        </div>
        {required === null ? (
          <p className="info-access-hint">读取访问设置后显示请求示例。</p>
        ) : (
          <>
            <div className="integration-code">
              <div className="integration-code-heading">
                <span>请求示例 · cURL</span>
                <CopyButton
                  text={curl}
                  label="复制 API 请求示例"
                  successMessage="请求示例已复制"
                  onNotice={onNotice}
                />
              </div>
              <pre tabIndex={0} aria-label="API 请求示例">
                <code>{curl}</code>
              </pre>
            </div>
            <p className="info-access-hint">
              {required ? (
                <>
                  当前需要密钥。使用 <code>apikey</code> 请求头，也支持{" "}
                  <code>?apikey=YOUR_API_KEY</code>。
                </>
              ) : (
                "当前免密，无需传入 apikey。"
              )}
            </p>
          </>
        )}
      </section>
      <section
        className="admin-panel settings-panel"
        aria-labelledby="mcp-heading"
      >
        <div className="panel-title">
          <div>
            <h2 id="mcp-heading">MCP 接入</h2>
            <p>连接 AI 客户端，查询额度与调用联网搜索</p>
          </div>
          <FileJson size={18} className="panel-icon" />
        </div>
        <div className="mcp-endpoint">
          <span>服务地址</span>
          <code>{origin}/mcp</code>
          <CopyButton
            text={`${origin}/mcp`}
            label="复制 MCP 服务地址"
            successMessage="MCP 服务地址已复制"
            onNotice={onNotice}
          />
        </div>
        <div className="mcp-example-toggle">
          <button
            type="button"
            className="button secondary btn btn--secondary small"
            aria-expanded={open}
            aria-controls="mcp-config-example"
            disabled={required === null}
            onClick={() => setOpen((value) => !value)}
          >
            配置示例
            <ChevronDown size={14} className={open ? "is-open" : ""} />
          </button>
          <span>mcp.json · Streamable HTTP</span>
        </div>
        {open && required !== null && (
          <div className="integration-code" id="mcp-config-example">
            <div className="integration-code-heading">
              <span>mcp.json</span>
              <CopyButton
                text={mcpTemplate(origin, required)}
                label="复制 MCP 客户端配置"
                successMessage="客户端配置已复制"
                onNotice={onNotice}
              />
            </div>
            <pre tabIndex={0} aria-label="mcp.json 配置模板">
              <code>{mcpTemplate(origin, required)}</code>
            </pre>
          </div>
        )}
        <p className="info-access-hint">
          联网搜索会消耗所选账号额度；免密模式下访问者也可调用。
        </p>
        <MCPToolGuide onNotice={onNotice} />
      </section>
    </>
  );
}
