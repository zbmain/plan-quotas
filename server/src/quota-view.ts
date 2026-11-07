const fields = [
  "id",
  "label",
  "kind",
  "unit",
  "used",
  "limit",
  "remaining",
  "used_percent",
  "window",
  "resets_at",
  "currency",
];
export const GLM_MCP_TOOLS = new Set([
  "mcp",
  "web_search",
  "web_reader",
  "zread",
]);

/** Hide GLM tool breakdowns without altering its persisted source observations. */
export function visibleMetrics(provider: string, metrics: any[]): any[] {
  return metrics.filter(
    (row) => provider !== "glm" || !String(row.id ?? "").startsWith("glm-mcp-"),
  );
}
/** Normalize established cycle aliases without turning a fixed 30 days into a billing month. */
export function quotaWindow(value: string | null): string | null {
  const key = (value || "").trim().toLowerCase().replaceAll(" ", "");
  if (["5h", "5hour", "5hours", "5小时", "300m", "300分钟"].includes(key))
    return "5h";
  if (["week", "weekly", "7d", "7days", "每周", "1week"].includes(key))
    return "week";
  if (["month", "monthly", "每月", "1month"].includes(key)) return "month";
  return value;
}
/** Project a stored metric into the existing internal card schema and annotate sharing. */
function viewMetric(raw: any, provider: string): any {
  const item: any = Object.fromEntries(
    fields.map((key) => [key, raw[key] ?? null]),
  );
  item.window = quotaWindow(item.window);
  item.remaining_percent =
    item.unit === "%" && item.remaining !== null
      ? item.remaining
      : item.used_percent !== null
        ? 100 - item.used_percent
        : item.remaining !== null && item.limit
          ? (item.remaining / item.limit) * 100
          : null;
  Object.assign(item, {
    quota_scope: "independent",
    tool: null,
    shared_quota_ids: [],
    availability: "available",
    note: null,
  });
  if (provider === "glm") {
    if (item.label === "MCP 调用次数") item.quota_scope = "shared_pool";
    else if (String(item.id ?? "").startsWith("glm-") && item.unit === "tokens")
      item.unit = "额度单位";
  }
  return item;
}
/** Group models, tools and balances for cards without modifying the original snapshot. */
export function buildQuotaList(
  accounts: any[],
  options: { include_shared_search?: boolean } = {},
): any[] {
  return accounts.map((account) => {
    const provider = account.provider ?? "",
      metrics = visibleMetrics(provider, account.data?.metrics ?? []).map(
        (row) => viewMetric(row, provider),
      );
    const token = metrics.filter(
      (row) =>
        row.kind === "quota" &&
        row.tool === null &&
        row.quota_scope !== "shared_pool",
    );
    const tools = metrics.filter(
      (row) => row.tool !== null || row.quota_scope === "shared_pool",
    );
    if (provider === "minimax" && options.include_shared_search !== false)
      for (const item of token.filter((row) =>
        ["5h", "week"].includes(row.window),
      ))
        tools.push({
          ...Object.fromEntries(fields.map((key) => [key, null])),
          id: `minimax-web-search-${item.window}`,
          label: "联网搜索",
          kind: "quota",
          unit: "次",
          window: item.window,
          resets_at: item.resets_at,
          remaining_percent: null,
          quota_scope: "shared",
          tool: "web_search",
          shared_quota_ids: [item.id],
          availability: "unavailable",
          note: "共享套餐额度，独立用量暂无数据",
        });
    return {
      id: account.id ?? null,
      provider: account.provider ?? null,
      alias: account.alias ?? null,
      enabled: account.enabled ?? false,
      status: account.status ?? null,
      stale: account.stale ?? false,
      updated_at: account.last_success_at ?? null,
      token,
      tools,
      balances: metrics.filter((row) => ["balance", "cost"].includes(row.kind)),
    };
  });
}
/** Preserve the internal quota-summary grouping used by compatibility fixtures. */
export function quotaSummary(rows: any[], category: string): any[] {
  const groups = new Map<string, any>(),
    seen = new Set<string>();
  for (const account of rows)
    for (const item of account[category]) {
      const scope = item.quota_scope;
      if (scope === "shared_pool") {
        const pool = JSON.stringify([account.id, item.id]);
        if (seen.has(pool)) continue;
        seen.add(pool);
      }
      const key = JSON.stringify([
        account.provider,
        category,
        scope,
        item.tool,
        item.unit,
        item.window,
        item.label,
      ]);
      if (!groups.has(key))
        groups.set(key, {
          provider: account.provider,
          category,
          quota_scope: scope,
          tool: item.tool,
          unit: item.unit,
          window: item.window,
          label: item.label,
          total: null,
          used: null,
          remaining: null,
          valid_count: 0,
          missing_count: 0,
          stale_count: 0,
        });
      const group = groups.get(key);
      if (account.stale || account.status !== "ok") {
        group.stale_count++;
        continue;
      }
      if (scope === "shared") {
        if (item.used === null) group.missing_count++;
        else {
          group.used = (group.used || 0) + item.used;
          group.valid_count++;
        }
        continue;
      }
      if (
        item.availability === "unavailable" ||
        item.unit === "%" ||
        [item.limit, item.used, item.remaining].some((value) => value === null)
      ) {
        group.missing_count++;
        continue;
      }
      for (const field of ["total", "used", "remaining"])
        group[field] =
          (group[field] || 0) + item[field === "total" ? "limit" : field];
      group.valid_count++;
    }
  return [...groups.values()];
}
