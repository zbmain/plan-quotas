import { z } from "zod";
import { Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { FastifyInstance } from "fastify";
import { MCP_TOOLS } from "@plan-quotas/shared";
import { QuotaService } from "./service.js";
import { SearchService, SearchError } from "./search.js";

export class MCPInputError extends Error {
  /** Keep only actionable Chinese feedback and the invalid public field name. */
  constructor(
    message: string,
    public field = "",
  ) {
    super(message);
  }
}
/** Build strict channel-enumeration and search-text validation from the published schema. */
function fieldSchema(field: any, name: string): z.ZodType {
  let value: z.ZodType;
  if (field.enum) value = z.enum(field.enum as [string, ...string[]]);
  else {
    let text = z.string();
    if (name === "query") text = text.trim();
    value = text.min(field.minLength ?? 0).max(field.maxLength ?? Infinity);
  }
  return "default" in field ? value.default(field.default) : value;
}
const schemas: Record<string, z.ZodObject<any>> = Object.fromEntries(
  MCP_TOOLS.map((tool) => [
    tool.name,
    z.strictObject(
      Object.fromEntries(
        Object.entries(tool.inputSchema.properties).map(([key, value]) => [
          key,
          fieldSchema(value, key),
        ]),
      ),
    ),
  ]),
);
/** Strictly validate the published fields before routing a quota query or billable search. */
export function prepareArguments(
  name: string,
  input: Record<string, any>,
): any {
  const tool = MCP_TOOLS.find((item) => item.name === name);
  if (!tool) throw new MCPInputError("工具不存在，请刷新工具列表后重新选择。");
  const properties = tool.inputSchema.properties as Record<string, any>,
    fields = Object.keys(properties);
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new MCPInputError(
      `参数已更新，此工具可填写：${fields.join("、")}。请刷新工具列表。`,
    );
  const parsed = schemas[name].safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0],
      field = String(issue.path[0] ?? ""),
      meta = properties[field] ?? {},
      title = meta.title ?? "参数";
    let message: string;
    if (input[field] === undefined) message = `请填写${title}。`;
    else if (meta.enum) message = `${title}请选择：${meta.enum.join("、")}。`;
    else if (field === "query")
      message = "请填写 1～4000 字符的搜索内容，不能只有空白。";
    else
      message = `${title}请填写有效文本，例如 ${meta.examples?.[0] ?? "glm"}。`;
    throw new MCPInputError(message, field);
  }
  const values = parsed.data as any,
    provider = ["all", "auto"].includes(values.channel) ? null : values.channel;
  const result: any = { provider };
  if (name === "web_search")
    Object.assign(result, {
      query: values.query,
    });
  return result;
}
/** Encode dictionaries and account arrays exactly as the existing MCP content contract. */
function success(value: any): any {
  return Array.isArray(value)
    ? {
        content: value.map((row) => ({
          type: "text",
          text: JSON.stringify(row),
        })),
        structuredContent: { result: value },
        isError: false,
      }
    : {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        isError: false,
      };
}
/** Preserve the explicit protocol metadata while delegating JSON-RPC and negotiation to the SDK. */
export function buildMCP(service: QuotaService, search: SearchService): Server {
  const server = new Server(
    { name: "plan-quotas", version: "0.0.5" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: structuredClone(MCP_TOOLS) as any,
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const params = request.params;
    const name = params.name;
    if (!schemas[name])
      return {
        isError: true,
        content: [
          { type: "text", text: "工具不存在，请刷新工具列表后重新选择。" },
        ],
      };
    try {
      const args = prepareArguments(name, params.arguments ?? {});
      if (name === "list_accounts")
        return success(service.protocolAccounts(args.provider));
      if (name === "get_token_quota")
        return success(service.queryQuotas({ category: "token", ...args }));
      if (name === "get_tool_quota")
        return success(service.queryQuotas({ category: "tools", ...args }));
      if (name === "get_history")
        return success(service.protocolHistories(args.provider));
      return success(await search.webSearch(args.query, args.provider));
    } catch (error) {
      if (error instanceof MCPInputError) {
        const result: any = {
          errorCode: "invalid_parameters",
          message: error.message,
        };
        if (error.field) result.field = error.field;
        return { ...success(result), isError: true };
      }
      if (error instanceof SearchError)
        return {
          ...success({ error_code: error.code, attempts: error.attempts }),
          isError: true,
        };
      return {
        ...success({
          errorCode: "internal_error",
          message: "暂时无法读取用量，请稍后重试。",
        }),
        isError: true,
      };
    }
  });
  return server;
}
/** Mount a stateless SDK transport, cleaning each request without owning application state. */
export function mountMCP(
  app: FastifyInstance,
  service: QuotaService,
  search: SearchService,
): void {
  const active = new Set<Server>();
  app.post("/mcp", async (request, reply) => {
    const server = buildMCP(service, search),
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    active.add(server);
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.once("close", () => {
      active.delete(server);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("Content-Type", "application/json");
        reply.raw.end(JSON.stringify({ detail: "MCP 服务暂时不可用" }));
      } else reply.raw.end();
    }
  });
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    handler: async (_request, reply) =>
      reply
        .code(405)
        .header("Allow", "POST")
        .send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled([...active].map((server) => server.close()));
  });
}
