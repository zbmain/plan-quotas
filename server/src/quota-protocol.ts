import type {
  ProtocolAccount,
  ProtocolHeader,
  QuotaItem,
} from "@plan-quotas/shared";
import { buildQuotaList, GLM_MCP_TOOLS } from "./quota-view.js";
import { timestamp, compare } from "./time.js";
const messages: Record<string, string> = {
  auth_required: "认证已失效，请在管理后台更新凭据。",
  invalid_credentials: "认证信息无效，请检查渠道凭据。",
  network_error: "暂时无法连接渠道，以下保留上次成功结果。",
  upstream_error: "渠道服务暂时不可用，以下保留上次成功结果。",
  invalid_response: "渠道返回格式暂时无法识别，以下保留上次成功结果。",
  subscription_unavailable: "套餐暂不可用，请检查套餐权限和工作区。",
  rate_limited: "渠道请求受限，请等待自动重试。",
};
const statuses: Record<string, string> = {
  pending: "等待首次采集或重新采集。",
  disabled: "账号已暂停，以下为上次采集结果。",
  stale: "数据已过期，以下为上次成功结果。",
  auth_required: messages.auth_required,
  rate_limited: messages.rate_limited,
  error: "采集失败，以下保留上次成功结果。",
};
const generic =
  /^(?:(?:glm|kimi)\s+)?(?:coding\s+plan|quota|额度|套餐(?:额度)?|5\s*小时(?:用量|限额)?|7\s*天(?:用量|限额)?|周额度|weekly quota|session quota|短周期|长周期)$/i;
/** Keep genuinely numeric finite values only; a boolean must not become a quota count. */
function numeric(value: any): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Describe cache validity independently of subscription payment or quota exhaustion. */
export function accountHeader(raw: any): ProtocolHeader {
  let status = raw.status || "pending";
  if (!raw.enabled) status = "disabled";
  else if (status === "ok" && raw.stale) status = "stale";
  const isValid = status === "ok";
  const message = ["disabled", "stale", "pending"].includes(status)
    ? statuses[status]
    : messages[raw.error_code] || statuses[status];
  return {
    id: raw.id ?? null,
    name: raw.alias ?? null,
    channel: raw.provider ?? null,
    planName: raw.data?.plan ?? null,
    status,
    isValid,
    invalidMessage: isValid ? null : message || "暂时无法读取渠道用量。",
    updatedAt: timestamp(raw.last_success_at),
  };
}
/** Serialize a quota using shared simple fields and truthful units. */
export function quotaItem(raw: any, group: string): QuotaItem {
  let total = numeric(raw.limit),
    used = numeric(raw.used),
    remaining = numeric(raw.remaining);
  const percentage = numeric(raw.used_percent);
  let unit = raw.unit || "";
  if (["quota", "额度单位"].includes(unit)) unit = "额度";
  if (
    group !== "balances" &&
    (unit === "%" ||
      (percentage !== null &&
        total === null &&
        used === null &&
        remaining === null))
  ) {
    unit = "%";
    if (used === null) used = percentage;
    if (total === null && (used !== null || remaining !== null)) total = 100;
    if (remaining === null && used !== null)
      remaining = Math.max(0, 100 - used);
  }
  if (total !== null && total >= 0) {
    if (
      used === null &&
      remaining !== null &&
      remaining >= 0 &&
      remaining <= total
    )
      used = total - remaining;
    if (remaining === null && used !== null && used >= 0 && used <= total)
      remaining = total - used;
  }
  const period = raw.window ?? null;
  let name = String(raw.label || "额度");
  if (group === "token" && generic.test(name.trim()))
    name =
      (
        { "5h": "短周期", week: "长周期", month: "月度额度" } as Record<
          string,
          string
        >
      )[period] || name;
  const item: QuotaItem = {
    id: raw.id ?? null,
    name,
    period,
    total,
    used,
    remaining,
    unit: group === "balances" ? raw.currency || unit : unit,
    resetAt: timestamp(raw.resets_at),
  };
  if (
    percentage !== null &&
    unit !== "%" &&
    [total, used, remaining].some((value) => value === null)
  )
    item.usedPercent = percentage;
  let note = raw.note;
  if (group === "balances") item.kind = raw.kind;
  if (group === "tools") {
    const pool = raw.quota_scope === "shared_pool";
    item.tool = pool ? "mcp" : raw.tool;
    if (["shared", "shared_pool"].includes(raw.quota_scope)) item.shared = true;
    if (raw.shared_quota_ids?.length)
      item.sharedWith = [...raw.shared_quota_ids];
    if (pool) note = "所有 MCP 工具共享此额度；不提供单工具独立次数。";
  }
  if (note) item.extra = String(note);
  return item;
}
/** Count current model/tool pressure without treating a zero monetary wallet as depleted plan quota. */
function low(account: ProtocolAccount): boolean {
  return (
    account.isValid &&
    [...account.token, ...account.tools].some(
      (row) =>
        (row.usedPercent !== undefined && row.usedPercent >= 80) ||
        (row.total !== null &&
          row.total > 0 &&
          ((row.remaining !== null && row.remaining / row.total <= 0.2) ||
            (row.used !== null && row.used / row.total >= 0.8))),
    )
  );
}
/** Summarize account health without repeating the individual quota records. */
function accountCounts(accounts: ProtocolAccount[]): {
  accountCount: number;
  healthy: number;
  low: number;
  errors: number;
} {
  return {
    accountCount: accounts.length,
    healthy: accounts.filter((row) => row.isValid).length,
    low: accounts.filter(low).length,
    errors: accounts.filter((row) =>
      ["error", "auth_required", "rate_limited"].includes(row.status),
    ).length,
  };
}
/** Return the current V2 HTTP/MCP envelope from cached observations only. */
export function buildResponse(
  source: any[],
  intervalMinutes: number,
  options: {
    category?: string;
    period?: string | null;
    tool?: string | null;
  } = {},
): any {
  const category = options.category ?? "all",
    period = options.period ?? null,
    tool = options.tool ?? null,
    views = buildQuotaList(source);
  const accounts: ProtocolAccount[] = source.map((raw, index) => {
    const view = views[index],
      row: ProtocolAccount = {
        ...accountHeader(raw),
        token: [],
        tools: [],
        balances: [],
      };
    if (["all", "tools"].includes(category))
      row.tools = view.tools
        .filter(
          (item: any) =>
            (period === null || item.window === period) &&
            (tool === null ||
              item.tool === tool ||
              (raw.provider === "glm" &&
                item.quota_scope === "shared_pool" &&
                GLM_MCP_TOOLS.has(tool))),
        )
        .map((item: any) => quotaItem(item, "tools"));
    const context = new Set(row.tools.flatMap((item) => item.sharedWith ?? []));
    row.token = view.token
      .filter(
        (item: any) =>
          (period === null || item.window === period) &&
          (["all", "token"].includes(category) || context.has(item.id)),
      )
      .map((item: any) => quotaItem(item, "token"));
    if (["all", "token"].includes(category))
      row.balances = view.balances
        .filter((item: any) => period === null || item.window === period)
        .map((item: any) => quotaItem(item, "balances"));
    return row;
  });
  const updated = accounts
    .flatMap((row) => (row.updatedAt ? [row.updatedAt] : []))
    .sort(compare);
  return {
    version: 2,
    updatedAt: updated.at(-1) ?? null,
    refreshIntervalSeconds: intervalMinutes * 60,
    ...accountCounts(accounts),
    accounts,
  };
}
/** Use the same item vocabulary for actual history, retaining gaps and reset markers. */
export function historyResponse(account: any, history: any): any {
  return {
    version: 2,
    account: { id: account.id, name: account.alias, channel: account.provider },
    range: history.range,
    points: (history.points ?? []).map((point: any) => {
      const view = buildQuotaList(
        [{ ...account, data: { metrics: point.metrics ?? [] } }],
        { include_shared_search: false },
      )[0];
      return {
        time: timestamp(point.timestamp),
        isMissing: !!point.gap,
        isReset: !!point.reset,
        ...Object.fromEntries(
          ["token", "tools", "balances"].map((category) => [
            category,
            view[category].map((item: any) => quotaItem(item, category)),
          ]),
        ),
      };
    }),
  };
}
