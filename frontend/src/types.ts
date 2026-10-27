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
};
export type Usage = {
  plan?: string | null;
  metrics: Metric[];
  source?: string;
  fetched_at?: string;
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
};
export type Dashboard = {
  accounts: Account[];
  summary: {
    total: number;
    healthy: number;
    low: number;
    errors: number;
    updated_at?: string | null;
  };
  interval_minutes: number;
};
export type PublicSettings = {
  page_title: string;
};
export type AdminSettings = PublicSettings & {
  interval_minutes: number;
  mcp_configured: boolean;
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
