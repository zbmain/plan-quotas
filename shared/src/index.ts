import { z } from "zod";
import catalog from "./catalog.json" with { type: "json" };
import verified from "./verified.json" with { type: "json" };
import tools from "./mcp-tools.json" with { type: "json" };

export const DEFAULT_PAGE_TITLE = "plan-quotas · 仪表盘 AI 用量面板";
export const ProviderIdSchema = z.enum([
  "minimax",
  "glm",
  "kimi",
  "deepseek",
  "volcengine",
  "aliyun",
  "codex",
  "claude",
  "cursor",
  "opencode",
  "opendesign",
  "antigravity",
]);
export const AuthTypeSchema = z.enum([
  "api_key",
  "cookie",
  "oauth",
  "jwt",
  "aksk",
  "control_key",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type AuthType = z.infer<typeof AuthTypeSchema>;
export type Credentials = Record<string, string>;
export const StatusSchema = z.enum([
  "pending",
  "ok",
  "auth_required",
  "rate_limited",
  "error",
  "disabled",
]);
const numeric = z.number().finite().nullable().default(null);
const text = z.string().nullable().default(null);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const MetricSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["quota", "balance", "cost"]).default("quota"),
  unit: z.string().default("%"),
  used: numeric,
  limit: numeric,
  remaining: numeric,
  used_percent: numeric,
  window: text,
  resets_at: text,
  currency: text,
});
export type StoredMetric = z.infer<typeof MetricSchema>;
export type Metric = {
  id: string;
  label: string;
  kind: "quota" | "balance" | "cost";
  unit?: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  used_percent?: number | null;
  window?: string | null;
  resets_at?: string | null;
  currency?: string | null;
  remaining_percent?: number | null;
  quota_scope?: "independent" | "shared_pool" | "shared" | "unknown";
  tool?: string | null;
  shared_quota_ids?: string[];
  availability?: string;
  note?: string | null;
};
export const UsageSchema = z.object({
  plan: text,
  metrics: z.array(MetricSchema).default([]),
  source: z.string(),
  fetched_at: z.string(),
});
export type UsageResult = z.infer<typeof UsageSchema>;
export type Usage = {
  plan?: string | null;
  metrics: Metric[];
  source?: string;
  fetched_at?: string;
};
export const StoredAccountSchema = z.object({
  id: uuid,
  provider: ProviderIdSchema,
  alias: z.string().min(1).max(80),
  auth_type: AuthTypeSchema,
  enabled: z.boolean().default(true),
  search_enabled: z.boolean().default(false),
  order: z.number().int().default(0),
  created_at: z.string(),
});
export type StoredAccount = z.infer<typeof StoredAccountSchema>;
export const SnapshotSchema = z.object({
  account_id: uuid,
  status: StatusSchema.default("pending"),
  data: UsageSchema.nullable().default(null),
  last_attempt_at: text,
  last_success_at: text,
  error_code: text,
  retry_at: text,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  page_title: z.string().min(1).max(120).default(DEFAULT_PAGE_TITLE),
  interval_minutes: z.number().min(0.5).max(60).default(1),
  accounts: z.array(StoredAccountSchema).default([]),
  info_require_password: z.boolean().default(false),
  info_password_hash: text,
  api_access_version: z.literal(1).optional(),
});
export type AppConfig = z.infer<typeof ConfigSchema>;
export const ACCESS_TOKEN_LIMIT = 5;
export type AccessToken = { id: string; created_at: string };
export type ApiAccessSettings = {
  require_apikey: boolean;
  limit: number;
  tokens: AccessToken[];
};
export type Account = {
  id: string;
  provider: string;
  alias: string;
  enabled: boolean;
  status?: string;
  stale?: boolean;
  data?: Usage | null;
  last_attempt_at?: string | null;
  last_success_at?: string | null;
  error_code?: string | null;
  verification?: string;
  credential_configured?: boolean;
  credential_keys?: string[];
  auth_type?: string;
  order?: number;
  search_enabled?: boolean;
  search_supported?: boolean;
};
export type QuotaListAccount = {
  id: string;
  provider: string;
  alias: string;
  enabled: boolean;
  status?: string;
  stale?: boolean;
  updated_at?: string | null;
  token: Metric[];
  tools: Metric[];
  balances: Metric[];
};
export type Dashboard = {
  accounts: Account[];
  list?: QuotaListAccount[];
  summary: {
    total: number;
    healthy: number;
    low: number;
    errors: number;
    updated_at?: string | null;
  };
  interval_minutes: number;
};
export type PublicSettings = { page_title: string };
export type AdminSettings = PublicSettings & {
  interval_minutes: number;
};
export type Provider = {
  id: string;
  name: string;
  auth_types: string[];
  fields: Record<
    string,
    {
      key: string;
      label: string;
      required: boolean;
      secret: boolean;
      placeholder?: string;
    }[]
  >;
  help?: string;
  docs_url?: string;
};
export type History = {
  account_id: string;
  range: string;
  points: {
    timestamp: string;
    metrics: Metric[];
    gap: boolean;
    reset: boolean;
  }[];
};
export type QuotaItem = {
  id: string;
  name: string;
  period: string | null;
  total: number | null;
  used: number | null;
  remaining: number | null;
  unit: string;
  resetAt: string | null;
  usedPercent?: number;
  kind?: string;
  tool?: string | null;
  shared?: boolean;
  sharedWith?: string[];
  extra?: string;
};
export type ProtocolHeader = {
  id: string;
  name: string;
  channel: string;
  planName: string | null;
  status: string;
  isValid: boolean;
  invalidMessage: string | null;
  updatedAt: string | null;
};
export type ProtocolAccount = ProtocolHeader & {
  token: QuotaItem[];
  tools: QuotaItem[];
  balances: QuotaItem[];
};
export const PROVIDERS: Provider[] = catalog.map((provider) => ({
  ...provider,
  fields: Object.fromEntries(
    Object.entries(provider.fields).filter(([, items]) => items !== undefined),
  ),
}));
export const CATALOG = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider]),
);
export const VERIFIED_AUTH_METHODS = new Set(
  (verified as string[][]).map((pair) => pair.join(":")),
);
export const MCP_TOOLS = tools;

/** Construct an explicit nullable metric, matching existing persisted snapshots. */
export function metric(input: z.input<typeof MetricSchema>): StoredMetric {
  return MetricSchema.parse(input);
}
/** Validate adapter output before it is stored or exposed to a client. */
export function usage(
  input: Omit<z.input<typeof UsageSchema>, "fetched_at"> & {
    fetched_at?: string;
  },
  now: string,
): UsageResult {
  return UsageSchema.parse({ ...input, fetched_at: input.fetched_at ?? now });
}
/** Build a pending snapshot without discarding the established nullable fields. */
export function pending(account_id: string): Snapshot {
  return SnapshotSchema.parse({ account_id });
}
