import { ChevronDown } from "lucide-react";
import { CopyButton } from "./CopyButton";

const tools = [
  {
    name: "list_accounts",
    title: "查看账号列表",
    fields: "channel 渠道（可省略，默认 all）",
    help: "只接受渠道。按后台顺序返回该渠道全部账号及状态，传 {} 查询全部渠道。",
    example: {},
  },
  {
    name: "get_token_quota",
    title: "查看套餐额度",
    fields: "channel 渠道（可省略，默认 all）",
    help: "只接受渠道。返回该渠道全部账号、全部周期的套餐额度和余额；传 {} 查询全部渠道。",
    example: { channel: "glm" },
  },
  {
    name: "get_tool_quota",
    title: "查看工具额度",
    fields: "channel 渠道（可省略，默认 all）",
    help: "只接受渠道。返回该渠道全部账号的全部工具额度；GLM 只提供共享 MCP 总池。",
    example: { channel: "glm" },
  },
  {
    name: "get_history",
    title: "查看用量历史",
    fields: "channel 渠道（可省略，默认 all）",
    help: "只接受渠道。返回该渠道全部账号最近 24 小时的历史，不能选择账号或时间范围。",
    example: { channel: "glm" },
  },
  {
    name: "web_search",
    title: "联网搜索",
    fields: "query 搜索内容（必填）· channel 搜索渠道（默认 auto）",
    help: "只接受搜索内容和渠道。auto 按全部账号的后台顺序尝试；glm、minimax 仅在对应渠道中尝试，异常或不可用时切换下一账号。最多返回 10 条，会消耗套餐额度。",
    example: { query: "Python asyncio 官方文档" },
  },
];

/** Explain all five MCP forms with copyable flat JSON examples and readable field labels. */
export function MCPToolGuide({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  return (
    <details className="mcp-tool-guide">
      <summary>
        工具参数与填写示例 <ChevronDown size={14} />
      </summary>
      <p className="info-access-hint">
        在客户端选择对应工具，再粘贴参数对象即可。四个查询工具都支持传 {"{}"}{" "}
        查询全部渠道，且只接受 channel。搜索只需 query 和可选
        channel，账号由后台顺序自动决定。 更新后请重新连接 MCP，或刷新工具列表。
      </p>
      {tools.map((tool) => (
        <article className="mcp-guide-item" key={tool.name}>
          <div className="mcp-guide-heading">
            <strong>{tool.title}</strong>
            <code>{tool.name}</code>
          </div>
          <p className="mcp-guide-fields">{tool.fields}</p>
          <p className="info-access-hint">{tool.help}</p>
          <div className="mcp-endpoint">
            <code>{JSON.stringify(tool.example)}</code>
            <CopyButton
              text={JSON.stringify(tool.example, null, 2)}
              label={`复制${tool.title}参数`}
              successMessage={`${tool.title}参数已复制`}
              onNotice={onNotice}
            />
          </div>
        </article>
      ))}
    </details>
  );
}
