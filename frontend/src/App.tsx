import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LoaderCircle,
  LogOut,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import type { Account, Dashboard, History, Metric, Provider } from "./types";

/** Send a same-origin API request and expose only the server's safe detail message. */
const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response
    .json()
    .catch(() => ({ detail: "服务暂时无法读取数据" }));
  if (!response.ok)
    throw new Error(body.detail || `请求失败 (${response.status})`);
  return body as T;
};
const providerNames: Record<string, string> = {
  minimax: "MiniMax",
  glm: "智谱 GLM",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  volcengine: "火山引擎",
  aliyun: "阿里云百炼",
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  antigravity: "Google Antigravity",
};
const statusLabel: Record<string, string> = {
  ok: "运行正常",
  pending: "等待采集",
  auth_required: "认证失效",
  rate_limited: "请求受限",
  error: "采集异常",
  disabled: "已暂停",
};
const connectionErrorLabel: Record<string, string> = {
  invalid_credentials: "认证信息无效，请检查认证方式和必填字段",
  auth_required: "认证已失效，请重新配置凭据",
  rate_limited: "渠道请求受限，请稍后再试",
  network_error: "暂时无法连接渠道服务",
  upstream_error: "渠道服务暂时不可用",
  invalid_response: "渠道返回的数据暂时无法识别",
};
/** Format an API timestamp for the dashboard's Asia/Shanghai display timezone. */
const formatTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        month: "numeric",
        day: "numeric",
        timeZone: "Asia/Shanghai",
      }).format(new Date(value))
    : "暂无记录";
/** Format a numeric reading without inventing values for missing measurements. */
const formatNumber = (v?: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(v);

/** Format a history sample in the viewer's configured Asia/Shanghai timezone. */
export function formatHistoryTime(timestamp: string, range: string) {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions =
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : range === "7d"
        ? { month: "numeric", day: "numeric", hour: "2-digit" }
        : { month: "numeric", day: "numeric" };
  return date.toLocaleString("zh-CN", {
    ...options,
    timeZone: "Asia/Shanghai",
  });
}

/** Describe how long remains before a metric's next provider-reported reset. */
export function resetCountdown(resetsAt: string, now = Date.now()) {
  const remaining = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(remaining)) return "重置时间未知";
  if (remaining <= 0) return "即将重置";
  const minutes = Math.floor(remaining / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${remainder} 分钟后`;
  return `${Math.max(1, remainder)} 分钟后`;
}

/** Preserve history gaps and add a null sample before quota resets to break the line. */
export function historyRows(history: History, metricId: string) {
  const sampledRows = history.points.map((point) => {
    const metric = point.metrics.find((item) => item.id === metricId);
    return {
      timestamp: Date.parse(point.timestamp),
      value: point.gap ? null : historyMetricValue(metric),
      gap: point.gap,
      reset: point.reset,
    };
  });
  return sampledRows.flatMap((point) =>
    point.reset && point.value != null
      ? [{ ...point, value: null, resetBreak: true }, point]
      : [point],
  );
}

/** Choose the actual observed balance, cost, or quota reading for a history series. */
export function historyMetricValue(metric?: Metric) {
  if (!metric) return null;
  if (metric.kind === "quota")
    return metric.remaining ?? metric.used ?? metric.used_percent ?? null;
  if (metric.kind === "balance") return metric.remaining ?? metric.used ?? null;
  return metric.used ?? metric.remaining ?? null;
}

/** Name a history series according to whether it plots remaining, used, or cost. */
export function historySeriesLabel(metric?: Metric) {
  if (!metric) return "额度";
  if (metric.kind === "quota") {
    if (metric.remaining != null) return `${metric.label} · 剩余`;
    if (metric.used != null) return `${metric.label} · 已用`;
    if (metric.used_percent != null) return `${metric.label} · 已用比例`;
    return metric.label;
  }
  if (metric.kind === "balance") return `${metric.label} · 余额`;
  return `${metric.label} · 本期消费`;
}

/** Format a metric using its own currency or unit, without combining unlike measures. */
export function metricValue(value: number | undefined | null, metric: Metric) {
  if (value == null) return "暂无数据";
  if (metric.kind === "balance" || metric.kind === "cost")
    return `${metric.currency === "CNY" ? "¥" : metric.currency === "USD" ? "$" : metric.currency ? `${metric.currency} ` : ""}${formatNumber(value)}`;
  return `${formatNumber(value)}${metric.unit === "%" ? "%" : metric.unit ? ` ${metric.unit}` : ""}`;
}
/** Return the unbounded usage percentage as reported or derived from quota values. */
export function rawProgressOf(metric: Metric) {
  if (metric.used_percent != null) return metric.used_percent;
  if (metric.used != null && metric.limit != null && metric.limit > 0)
    return (metric.used / metric.limit) * 100;
  if (metric.remaining != null && metric.limit != null && metric.limit > 0)
    return ((metric.limit - metric.remaining) / metric.limit) * 100;
  return null;
}

/** Clamp a usage percentage for the visual progress bar while preserving raw readings elsewhere. */
export function progressOf(metric: Metric) {
  const percentage = rawProgressOf(metric);
  return percentage == null ? null : Math.max(0, Math.min(100, percentage));
}

/** Build create or update payloads matching the account API's separate schemas. */
export function buildAccountPayload(
  draft: {
    provider: string;
    alias: string;
    auth_type: string;
    credentials: Record<string, string>;
  },
  editing: boolean,
  order: number,
) {
  const credentials = Object.fromEntries(
    Object.entries(draft.credentials).filter(
      ([, value]) => value.trim() !== "",
    ),
  );
  if (editing) {
    return {
      alias: draft.alias,
      auth_type: draft.auth_type,
      ...(Object.keys(credentials).length ? { credentials } : {}),
    };
  }
  return {
    provider: draft.provider,
    alias: draft.alias,
    auth_type: draft.auth_type,
    credentials,
    enabled: true,
    order,
  };
}
/** Convert the supported auth identifiers into human-readable labels. */
function authName(auth: string) {
  return (
    (
      {
        api_key: "API Key",
        cookie: "Cookie",
        oauth: "OAuth",
        jwt: "JWT",
        aksk: "Access Key / Secret Key",
      } as Record<string, string>
    )[auth] || auth
  );
}

/** Render the public quota overview and route the administrator path to its control panel. */
function App() {
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">(
    () => {
      const saved = localStorage.getItem("pq-theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    },
  );
  const [dark, setDark] = useState(
    () =>
      themeMode === "dark" ||
      (themeMode === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches),
  );
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, History>>({});
  const [range, setRange] = useState<Record<string, string>>({});
  const [page, setPage] = useState(
    location.pathname.startsWith("/admin") ? "admin" : "home",
  );
  const refresh = useCallback(async () => {
    try {
      setDashboard(await api<Dashboard>("/api/public/dashboard"));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "暂时无法连接服务");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("pq-theme", themeMode);
  }, [dark, themeMode]);
  useEffect(() => {
    if (themeMode === "system") {
      const media = matchMedia("(prefers-color-scheme: dark)");
      const sync = () => setDark(media.matches);
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
  }, [themeMode]);
  useEffect(() => {
    const fn = () =>
      setPage(location.pathname.startsWith("/admin") ? "admin" : "home");
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);
  const navigate = (to: "home" | "admin") => {
    window.history.pushState({}, "", to === "admin" ? "/admin" : "/");
    setPage(to);
  };
  const cycleTheme = () => {
    const next =
      themeMode === "system"
        ? "light"
        : themeMode === "light"
          ? "dark"
          : "system";
    setThemeMode(next);
    setDark(
      next === "dark" ||
        (next === "system" &&
          matchMedia("(prefers-color-scheme: dark)").matches),
    );
  };
  const accounts = dashboard?.accounts || [];
  const providers = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.provider))),
    [accounts],
  );
  const visible = accounts.filter(
    (a) =>
      (selectedProvider === "all" || a.provider === selectedProvider) &&
      (!query ||
        `${a.alias} ${providerNames[a.provider] || a.provider}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (statusFilter === "all" ||
        (statusFilter === "healthy"
          ? a.enabled && a.status === "ok" && !a.stale
          : statusFilter === "attention"
            ? a.enabled && (a.status !== "ok" || a.stale)
            : !a.enabled)),
  );
  const loadHistory = async (id: string, period: string) => {
    setRange({ ...range, [id]: period });
    try {
      setHistory({
        ...history,
        [id]: await api<History>(
          `/api/public/accounts/${id}/history?range=${period}`,
        ),
      });
    } catch {
      setHistory({
        ...history,
        [id]: { account_id: id, range: period, points: [] },
      });
    }
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-icon">
            <Gauge size={19} />
          </span>
          <span className="brand-word">
            plan-quotas<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <span className="brand-caption">配额簿 · AI 用量面板</span>
        </button>
        <div className="header-right">
          <span className="live-indicator">
            <i />
            {loadError
              ? "面板连接异常"
              : accountsNeedAttention(dashboard?.accounts)
                ? "部分账号需关注"
                : "用量定时采集"}
          </span>
          <button
            className="icon-button theme-toggle"
            aria-label={`切换主题，当前${themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "深色" : "浅色"}`}
            onClick={cycleTheme}
          >
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button
            className="header-link"
            aria-label="管理面板"
            onClick={() => navigate("admin")}
          >
            <Shield size={15} /> 管理面板 <ArrowRight size={14} />
          </button>
        </div>
      </header>
      {page === "admin" ? (
        <Admin
          onBack={() => navigate("home")}
          dark={dark}
          cycleTheme={cycleTheme}
          themeMode={themeMode}
        />
      ) : (
        <main className="page-wrap">
          <div className="hero-row">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" />
                订阅状态总览{" "}
                <span className="eyebrow-en">SUBSCRIPTION OVERVIEW</span>
              </div>
              <h1>
                把每份额度，<em>看得清楚。</em>
              </h1>
              <p className="hero-sub">
                所有 AI 编程订阅的用量与状态，一页掌握。
              </p>
            </div>
            <div className="hero-aside">
              <span className="date-stamp">数据采集周期</span>
              <strong>
                {dashboard?.interval_minutes ?? 5}
                <small> 分钟</small>
              </strong>
              <span className="last-updated">
                <Clock3 size={13} />
                最近更新 {formatTime(dashboard?.summary.updated_at)}
              </span>
            </div>
          </div>
          <section className="stat-grid">
            <Stat
              icon={<Command size={17} />}
              label="已接入账号"
              value={dashboard?.summary.total ?? 0}
              suffix="个"
              tone="green"
            />
            <Stat
              icon={<Activity size={17} />}
              label="运行正常"
              value={dashboard?.summary.healthy ?? 0}
              suffix="个"
              tone="blue"
            />
            <Stat
              icon={<AlertCircle size={17} />}
              label="额度紧张"
              value={dashboard?.summary.low ?? 0}
              suffix="个"
              tone="amber"
            />
            <Stat
              icon={<CircleHelp size={17} />}
              label="需要关注"
              value={dashboard?.summary.errors ?? 0}
              suffix="个"
              tone="red"
            />
          </section>
          <section className="accounts-section">
            <div className="section-head">
              <div>
                <div className="section-title-line">
                  <h2>订阅账号</h2>
                  <span className="count-pill">{visible.length}</span>
                </div>
                <p>额度独立展示，不混合计算不同计量方式</p>
              </div>
              <div className="toolbar">
                <label className="search-box">
                  <Search size={15} />
                  <input
                    placeholder="搜索账号"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      aria-label="清除搜索内容"
                      onClick={() => setQuery("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </label>
                <select
                  aria-label="按渠道筛选"
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                >
                  <option value="all">所有渠道</option>
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {providerNames[p] || p}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="按状态筛选"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">所有状态</option>
                  <option value="healthy">运行正常</option>
                  <option value="attention">需要关注</option>
                  <option value="paused">已暂停</option>
                </select>
              </div>
            </div>
            {loading ? (
              <div className="empty-state">
                <LoaderCircle className="spin" />
                <strong>正在读取用量</strong>
                <span>很快就好</span>
              </div>
            ) : loadError ? (
              <div className="empty-state error-state">
                <AlertCircle />
                <strong>暂时无法连接用量服务</strong>
                <span>{loadError}</span>
                <button
                  className="button secondary"
                  onClick={() => {
                    setLoading(true);
                    void refresh();
                  }}
                >
                  <RefreshCw size={14} />
                  重新加载
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <div className="empty-art">
                  <Gauge size={28} />
                </div>
                <strong>
                  {accounts.length
                    ? "没有符合条件的账号"
                    : "你的用量面板已就绪"}
                </strong>
                <span>
                  {accounts.length
                    ? "试试调整搜索词或筛选条件"
                    : "尚未添加 AI 订阅账号。完成配置后，用量会显示在这里。"}
                </span>
                {!accounts.length && (
                  <button
                    className="button primary"
                    onClick={() => navigate("admin")}
                  >
                    <Plus size={15} /> 添加第一个账号 <ArrowRight size={15} />
                  </button>
                )}
              </div>
            ) : (
              <div className="account-grid">
                {visible.map((a, i) => (
                  <AccountCard
                    key={a.id}
                    account={a}
                    index={i}
                    expanded={expanded === a.id}
                    onExpand={() => {
                      setExpanded(expanded === a.id ? null : a.id);
                      if (expanded !== a.id && !history[a.id])
                        void loadHistory(a.id, "24h");
                    }}
                    history={history[a.id]}
                    range={range[a.id] || "24h"}
                    onRange={(p) => void loadHistory(a.id, p)}
                  />
                ))}
              </div>
            )}
          </section>
          <footer className="page-footer">
            <span>
              <span className="footer-mark">Q</span> 配额簿{" "}
              <span className="footer-muted">· 为每份算力留一盏灯</span>
            </span>
            <span className="footer-right">
              公开面板 <i />
              只读访问 <span className="footer-sep">|</span> 自动刷新 30 秒
            </span>
          </footer>
        </main>
      )}
    </div>
  );
}
/** Render one summary statistic with its semantic color and icon. */
function Stat({
  icon,
  label,
  value,
  suffix,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix: string;
  tone: string;
}) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-icon">{icon}</span>
      <span className="stat-label">{label}</span>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
      <span className="stat-accent" />
    </div>
  );
}

/** Render a provider account, its independent metrics, and its sampled usage history. */
function AccountCard({
  account: a,
  index,
  expanded,
  onExpand,
  history,
  range,
  onRange,
}: {
  account: Account;
  index: number;
  expanded: boolean;
  onExpand: () => void;
  history?: History;
  range: string;
  onRange: (v: string) => void;
}) {
  const [metricId, setMetricId] = useState("");
  const metricChoices = Array.from(
    new Map(
      (history?.points || [])
        .flatMap((point) => point.metrics)
        .map((metric) => [metric.id, metric]),
    ).values(),
  );
  const activeMetricId = metricChoices.some((metric) => metric.id === metricId)
    ? metricId
    : (metricChoices[0]?.id ?? "");
  return (
    <article
      className={`account-card card-enter ${a.stale ? "is-stale" : ""}`}
      style={{ animationDelay: `${index * 55}ms` }}
    >
      <div className="card-top">
        <div className={`provider-mark provider-${a.provider}`}>
          {(
            {
              minimax: "M",
              glm: "GLM",
              kimi: "K",
              deepseek: "D",
              volcengine: "V",
              aliyun: "阿",
              codex: "⌘",
              claude: "✳",
              cursor: "↗",
              antigravity: "✦",
            } as Record<string, string>
          )[a.provider] || "AI"}
        </div>
        <div className="account-title">
          <span className="provider-name">
            {providerNames[a.provider] || a.provider}
          </span>
          <span className="account-alias">{a.alias}</span>
        </div>
        <span className={`status-tag status-${a.status}`}>
          <i />
          {a.stale && a.status === "ok"
            ? "数据过期"
            : statusLabel[a.status || "pending"] || a.status || "等待采集"}
        </span>
        <button
          className="more-button"
          aria-label="查看历史趋势"
          onClick={onExpand}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
      <div className="plan-line">
        <span>{a.data?.plan || "订阅计划"}</span>
        <span
          className="verified-mark"
          title="仅表示该渠道与认证方式的接入逻辑经过实测，不保证当前账号凭据状态"
        >
          {a.verification === "verified" ? (
            <>
              <CheckCircle2 size={12} />
              接入已实测
            </>
          ) : (
            <>尚未实测</>
          )}
        </span>
      </div>
      {!a.data ? (
        <div className="no-usage">
          <span className="no-usage-icon">
            <Activity size={16} />
          </span>
          <div>
            <strong>
              {a.status === "auth_required"
                ? "需要重新认证"
                : a.status === "pending"
                  ? "等待首次采集"
                  : "暂无用量数据"}
            </strong>
            <span>
              {a.error_code
                ? `状态代码：${a.error_code}`
                : "首次采集完成后，用量信息会显示在这里"}
            </span>
          </div>
        </div>
      ) : (
        <div className="metric-list">
          {a.data.metrics?.length ? (
            a.data.metrics.map((m) => <MetricView metric={m} key={m.id} />)
          ) : (
            <div className="no-metric">渠道尚未返回可展示的用量指标</div>
          )}
        </div>
      )}
      <div className="card-foot">
        <span>
          <Clock3 size={12} />
          {a.data?.fetched_at
            ? `${a.stale ? "上次成功（已过期）" : "更新于"} ${formatTime(a.data.fetched_at)}`
            : "尚未采集"}
        </span>
        <button onClick={onExpand}>
          {expanded ? "收起趋势" : "查看历史趋势"}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
      {expanded && (
        <div className="history-panel">
          <div className="history-head">
            <strong>用量观测</strong>
            {metricChoices.length > 1 && (
              <select
                className="metric-picker"
                aria-label="选择历史指标"
                value={activeMetricId}
                onChange={(event) => setMetricId(event.target.value)}
              >
                {metricChoices.map((metric) => (
                  <option key={metric.id} value={metric.id}>
                    {metric.label}
                  </option>
                ))}
              </select>
            )}
            <div className="range-tabs">
              {[
                ["24h", "24 小时"],
                ["7d", "7 天"],
                ["30d", "30 天"],
              ].map(([v, l]) => (
                <button
                  className={range === v ? "active" : ""}
                  key={v}
                  onClick={() => onRange(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          {history?.points.some(
            (point) => !point.gap && point.metrics.length,
          ) ? (
            <HistoryChart
              history={history}
              range={range}
              metricId={activeMetricId}
            />
          ) : history?.points.length ? (
            <div className="history-empty">采集完成后会逐步形成趋势</div>
          ) : (
            <div className="history-empty">
              {history ? "当前范围暂无历史记录" : "正在读取历史记录…"}
            </div>
          )}
          <small>历史记录反映定时采集时的额度变化，不代表精确消费账单。</small>
        </div>
      )}
    </article>
  );
}

/** Tell the dashboard header when any enabled account needs attention. */
function accountsNeedAttention(accounts?: Account[]) {
  return Boolean(
    accounts?.some(
      (account) =>
        account.enabled && (account.status !== "ok" || account.stale),
    ),
  );
}
/** Render an individual metric with its remaining value and progress when known. */
function MetricView({ metric: m }: { metric: Metric }) {
  const percent = progressOf(m);
  const remaining = m.remaining;
  const value =
    m.kind === "balance"
      ? metricValue(remaining ?? m.used, m)
      : m.kind === "cost"
        ? metricValue(m.used, m)
        : remaining != null
          ? metricValue(remaining, m)
          : m.limit != null
            ? `${metricValue(m.used, m)} / ${metricValue(m.limit, m)}`
            : metricValue(m.used, m);
  const reportedPercent = rawProgressOf(m);
  const percentText =
    reportedPercent == null ? null : Math.round(reportedPercent);
  return (
    <div className="metric-block">
      <div className="metric-label-row">
        <span className="metric-label">
          {m.label}
          {m.window && <span className="window-label">{m.window}</span>}
        </span>
        <span className="metric-remaining">
          {m.kind === "quota" && remaining != null ? (
            <>
              <small>剩余</small> {metricValue(remaining, m)}
            </>
          ) : (
            value
          )}
        </span>
      </div>
      {m.kind === "quota" && percent != null && (
        <div className="progress-track">
          <span
            className={`progress-fill ${percent >= 85 ? "high" : percent >= 65 ? "medium" : ""}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <div className="metric-meta">
        <span>
          {m.kind === "quota" && percentText != null
            ? `已用 ${percentText}%`
            : m.kind === "balance"
              ? "账户余额"
              : m.kind === "cost"
                ? "本周期消费"
                : m.limit != null
                  ? `总额度 ${metricValue(m.limit, m)}`
                  : "额度状态"}
        </span>
        <span>
          {m.resets_at
            ? `重置于 ${formatTime(m.resets_at)}（${resetCountdown(m.resets_at)}）`
            : m.window || ""}
        </span>
      </div>
    </div>
  );
}
/** Plot one selected metric while preserving missing samples and reset breaks. */
function HistoryChart({
  history: h,
  range,
  metricId,
}: {
  history: History;
  range: string;
  metricId: string;
}) {
  const selectedMetric = h.points
    .flatMap((point) => point.metrics)
    .find((metric) => metric.id === metricId);
  const rows = historyRows(h, metricId);
  const resetPoints = rows.filter(
    (point) => point.reset && point.value != null,
  );
  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={144}>
        <AreaChart
          data={rows}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient
              id={`fill-${h.account_id}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="var(--chart-color)"
                stopOpacity={0.22}
              />
              <stop
                offset="100%"
                stopColor="var(--chart-color)"
                stopOpacity={0.01}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke="var(--line)"
            strokeDasharray="3 4"
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(timestamp: number) =>
              formatHistoryTime(new Date(timestamp).toISOString(), range)
            }
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <Tooltip
            formatter={(value) =>
              selectedMetric
                ? metricValue(Number(value), selectedMetric)
                : value
            }
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--ink)" }}
            labelFormatter={(timestamp) =>
              formatHistoryTime(
                new Date(Number(timestamp)).toISOString(),
                range,
              )
            }
          />
          {resetPoints.map((point, index) => (
            <ReferenceDot
              key={`${point.timestamp}-${index}`}
              x={point.timestamp}
              y={point.value!}
              r={3.5}
              fill="var(--amber)"
              stroke="var(--surface)"
              strokeWidth={1.5}
            />
          ))}
          <Area
            type="monotone"
            dataKey="value"
            name={historySeriesLabel(selectedMetric)}
            stroke="var(--chart-color)"
            fill={`url(#fill-${h.account_id})`}
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 2, fill: "var(--chart-color)", strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Handle administrator authentication, provider credentials, collection settings, and MCP access. */
function Admin({
  onBack,
  dark,
  cycleTheme,
  themeMode,
}: {
  onBack: () => void;
  dark: boolean;
  cycleTheme: () => void;
  themeMode: "system" | "light" | "dark";
}) {
  const [csrf, setCsrf] = useState("");
  const [logged, setLogged] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [defaultPassword, setDefaultPassword] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [interval, setIntervalValue] = useState(5);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [step, setStep] = useState(1);
  const [providerId, setProviderId] = useState("");
  const [alias, setAlias] = useState("");
  const [authType, setAuthType] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<
    "idle" | "testing" | "ok" | "error"
  >("idle");
  const [testError, setTestError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const adminApi = async <T,>(path: string, method = "GET", body?: unknown) =>
    api<T>(path, {
      method,
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const loadAdmin = useCallback(async (tokenCsrf?: string) => {
    try {
      const session = await api<{
        csrf_token: string;
        default_password: boolean;
      }>("/api/admin/session");
      setCsrf(tokenCsrf || session.csrf_token);
      setDefaultPassword(session.default_password);
      setLogged(true);
      const [a, p, s] = await Promise.all([
        api<Account[]>("/api/admin/accounts"),
        api<Provider[]>("/api/public/providers"),
        api<{ interval_minutes: number; mcp_configured: boolean }>(
          "/api/admin/settings",
        ),
      ]);
      setAccounts(a);
      setProviders(p);
      setIntervalValue(s.interval_minutes);
      setMcpConfigured(s.mcp_configured);
    } catch {
      setLogged(false);
    }
  }, []);
  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    try {
      const r = await api<{ csrf_token: string; default_password: boolean }>(
        "/api/admin/login",
        { method: "POST", body: JSON.stringify({ password }) },
      );
      setCsrf(r.csrf_token);
      setDefaultPassword(r.default_password);
      setPassword("");
      await loadAdmin(r.csrf_token);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "登录失败");
    }
  };
  const logout = async () => {
    await adminApi("/api/admin/logout", "POST").catch(() => {});
    setLogged(false);
    setCsrf("");
  };
  const provider = providers.find((p) => p.id === providerId);
  const authTypes = provider?.auth_types || [];
  const fields = provider?.fields?.[authType] || [];
  const openNew = () => {
    setEditing(null);
    setStep(1);
    setProviderId("");
    setAlias("");
    setAuthType("");
    setCredentials({});
    setTestResult("idle");
    setModal(true);
  };
  const openEdit = (a: Account) => {
    setEditing(a);
    setStep(2);
    setProviderId(a.provider);
    setAlias(a.alias);
    setAuthType(a.auth_type || "");
    setCredentials({});
    setTestResult("idle");
    setModal(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const payload = buildAccountPayload(
        { provider: providerId, alias, auth_type: authType, credentials },
        Boolean(editing),
        accounts.length,
      );
      if (editing)
        await adminApi(`/api/admin/accounts/${editing.id}`, "PATCH", payload);
      else await adminApi("/api/admin/accounts", "POST", payload);
      setModal(false);
      setNotice("账号配置已保存");
      await loadAdmin(csrf);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTestResult("testing");
    setTestError("");
    try {
      const suppliedCredentials = Object.fromEntries(
        Object.entries(credentials).filter(([, value]) => value.trim() !== ""),
      );
      await adminApi("/api/admin/test", "POST", {
        provider: providerId,
        auth_type: authType,
        ...(Object.keys(suppliedCredentials).length
          ? { credentials: suppliedCredentials }
          : {}),
        ...(editing ? { account_id: editing.id } : {}),
      });
      setTestResult("ok");
    } catch (error) {
      setTestResult("error");
      const code = error instanceof Error ? error.message : "";
      setTestError(
        connectionErrorLabel[code] || "连接测试失败，请检查认证信息后重试",
      );
    }
  };
  const toggle = async (a: Account) => {
    try {
      await adminApi(`/api/admin/accounts/${a.id}`, "PATCH", {
        enabled: !a.enabled,
      });
      await loadAdmin(csrf);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "更新失败");
    }
  };
  const reorder = async (a: Account, delta: number) => {
    const sorted = [...accounts].sort(
      (x, y) => (x.order || 0) - (y.order || 0),
    );
    const ix = sorted.findIndex((x) => x.id === a.id),
      j = ix + delta;
    if (j < 0 || j >= sorted.length) return;
    [sorted[ix], sorted[j]] = [sorted[j], sorted[ix]];
    try {
      await Promise.all(
        sorted.map((x, i) =>
          adminApi(`/api/admin/accounts/${x.id}`, "PATCH", { order: i }),
        ),
      );
      await loadAdmin(csrf);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "排序失败");
    }
  };
  const remove = async (a: Account) => {
    if (!confirm(`确定删除「${a.alias}」？对应凭据、缓存和历史记录也会删除。`))
      return;
    try {
      await adminApi(`/api/admin/accounts/${a.id}`, "DELETE");
      await loadAdmin(csrf);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "删除失败");
    }
  };
  const saveSettings = async () => {
    try {
      await adminApi("/api/admin/settings", "PATCH", {
        interval_minutes: interval,
      });
      setNotice("采集周期已更新");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "设置保存失败");
    }
  };
  const issueToken = async () => {
    try {
      const r = await adminApi<{ token: string }>(
        "/api/admin/mcp-token",
        "POST",
        {},
      );
      setToken(r.token);
      setShowToken(true);
      setMcpConfigured(true);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "令牌生成失败");
    }
  };
  const revoke = async () => {
    if (!confirm("撤销后，使用当前 MCP 令牌的客户端将无法继续访问。确定撤销？"))
      return;
    try {
      await adminApi("/api/admin/mcp-token", "DELETE");
      setToken("");
      setMcpConfigured(false);
      setNotice("MCP 令牌已撤销");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "撤销失败");
    }
  };
  if (!logged)
    return (
      <main className="admin-login-wrap">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={15} />
          返回用量面板
        </button>
        <form className="login-card" onSubmit={login}>
          <div className="login-emblem">
            <Shield size={22} />
          </div>
          <span className="eyebrow">管理员入口</span>
          <h1>欢迎回来。</h1>
          <p>登录后管理渠道账号、采集与 MCP 访问。</p>
          <label className="field-label">
            管理员密码
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入管理密码"
            />
          </label>
          {loginError && (
            <div className="inline-error">
              <AlertCircle size={14} />
              {loginError}
            </div>
          )}
          <button className="button primary login-submit">
            登录管理面板 <ArrowRight size={15} />
          </button>
          <span className="login-foot">
            <KeyRound size={13} />
            密码由部署环境中的 ADMIN_PASSWORD 设置
          </span>
        </form>
      </main>
    );
  return (
    <main className="admin-wrap">
      <div className="admin-top">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={15} />
          用量面板
        </button>
        <div className="admin-top-right">
          <span className="admin-session">
            <span />
            管理员会话有效
          </span>
          <button
            className="icon-button"
            aria-label={`切换主题，当前${themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "深色" : "浅色"}`}
            onClick={cycleTheme}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="logout-button" onClick={logout}>
            <LogOut size={14} />
            退出
          </button>
        </div>
      </div>
      <div className="admin-heading">
        <div>
          <span className="eyebrow">
            <span className="eyebrow-line" />
            控制中心
          </span>
          <h1>管理面板</h1>
          <p>管理订阅接入、采集节奏与远程 MCP。</p>
        </div>
        <button className="button primary" onClick={openNew}>
          <Plus size={16} />
          添加渠道账号
        </button>
      </div>
      {defaultPassword && (
        <div className="security-notice">
          <Shield size={17} />
          <span>
            <strong>正在使用默认管理密码</strong>
            <small>请在部署配置中设置 ADMIN_PASSWORD，避免未授权访问。</small>
          </span>
        </div>
      )}
      <section className="admin-panel">
        <div className="panel-title">
          <div>
            <h2>渠道账号</h2>
            <p>启用的账号会定期采集用量数据</p>
          </div>
          <span className="count-pill">{accounts.length} 个</span>
        </div>
        {accounts.length === 0 ? (
          <div className="admin-empty">
            <div className="empty-art">
              <Command size={24} />
            </div>
            <strong>还没有接入渠道</strong>
            <span>添加第一个账号，开始汇总你的订阅用量。</span>
            <button className="button secondary" onClick={openNew}>
              <Plus size={14} />
              添加账号
            </button>
          </div>
        ) : (
          <div className="admin-account-list">
            {[...accounts]
              .sort((a, b) => (a.order || 0) - (b.order || 0))
              .map((a, i) => (
                <div
                  className={`admin-account-row ${!a.enabled ? "disabled-row" : ""}`}
                  key={a.id}
                >
                  <div className={`provider-mark provider-${a.provider}`}>
                    {providerNames[a.provider]?.slice(0, 2) || "AI"}
                  </div>
                  <div className="admin-account-info">
                    <strong>{a.alias}</strong>
                    <span>
                      {providerNames[a.provider] || a.provider}
                      <i /> {authName(a.auth_type || "")}
                      <i />{" "}
                      <span
                        className={
                          a.credential_configured
                            ? "credential-on"
                            : "credential-off"
                        }
                      >
                        {a.credential_configured
                          ? "凭据已配置 · ••••••"
                          : "凭据待配置"}
                      </span>
                    </span>
                  </div>
                  <span
                    className={`status-tag ${a.enabled ? "status-ok" : "status-disabled"}`}
                  >
                    <i />
                    {a.enabled ? "已启用" : "已暂停"}
                  </span>
                  <div className="row-actions">
                    <button
                      title="上移"
                      aria-label="上移账号"
                      disabled={i === 0}
                      onClick={() => void reorder(a, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      title="下移"
                      aria-label="下移账号"
                      disabled={i === accounts.length - 1}
                      onClick={() => void reorder(a, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      title="刷新用量"
                      aria-label="刷新账号用量"
                      onClick={() =>
                        void adminApi(
                          `/api/admin/accounts/${a.id}/refresh`,
                          "POST",
                          {},
                        )
                          .then(() => setNotice("已提交刷新请求"))
                          .catch((e) => setNotice(e.message))
                      }
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button title="编辑" onClick={() => openEdit(a)}>
                      <Settings2 size={14} />
                    </button>
                    <button
                      title={a.enabled ? "暂停" : "启用"}
                      onClick={() => void toggle(a)}
                    >
                      {a.enabled ? (
                        <span className="pause-symbol">Ⅱ</span>
                      ) : (
                        <Check size={15} />
                      )}
                    </button>
                    <button
                      title="删除"
                      className="danger-action"
                      onClick={() => void remove(a)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
      <section className="admin-panel settings-panel">
        <div className="panel-title">
          <div>
            <h2>数据采集</h2>
            <p>采集频率会影响上游请求次数</p>
          </div>
          <Clock3 size={18} className="panel-icon" />
        </div>
        <div className="setting-row">
          <div>
            <strong>自动采集周期</strong>
            <span>每个已启用账号按此周期更新用量</span>
          </div>
          <div className="setting-control">
            <select
              value={interval}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
            >
              {[1, 3, 5, 10, 15, 30, 60].map((v) => (
                <option key={v} value={v}>
                  每 {v} 分钟
                </option>
              ))}
            </select>
            <button
              className="button secondary small"
              onClick={() => void saveSettings()}
            >
              保存
            </button>
          </div>
        </div>
      </section>
      <section className="admin-panel settings-panel">
        <div className="panel-title">
          <div>
            <h2>远程 MCP 接入</h2>
            <p>让支持 MCP 的智能体安全读取用量数据</p>
          </div>
          <span className={`mcp-state ${mcpConfigured ? "configured" : ""}`}>
            <i />
            {mcpConfigured ? "已启用" : "未配置"}
          </span>
        </div>
        <div className="setting-row mcp-row">
          <div>
            <strong>只读访问令牌</strong>
            <span>仅在生成时显示，请复制并妥善保管</span>
          </div>
          <div className="setting-control">
            {mcpConfigured ? (
              <button
                className="button secondary small"
                onClick={() => void revoke()}
              >
                撤销令牌
              </button>
            ) : (
              <button
                className="button secondary small"
                onClick={() => void issueToken()}
              >
                <KeyRound size={14} />
                生成令牌
              </button>
            )}
          </div>
        </div>
        {token && (
          <div className="token-box">
            <code>
              {showToken ? token : "•".repeat(Math.min(token.length, 36))}
            </code>
            <button
              aria-label={showToken ? "隐藏 MCP 令牌" : "显示 MCP 令牌"}
              onClick={() => setShowToken(!showToken)}
            >
              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              aria-label="复制 MCP 令牌"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token)
                  .then(() => setNotice("令牌已复制"))
              }
            >
              <Copy size={15} />
            </button>
          </div>
        )}
        <div className="mcp-endpoint">
          <span>服务地址</span>
          <code>{location.origin}/mcp</code>
          <button
            aria-label="复制 MCP 服务地址"
            onClick={() =>
              void navigator.clipboard
                .writeText(`${location.origin}/mcp`)
                .then(() => setNotice("地址已复制"))
            }
          >
            <Copy size={13} />
          </button>
        </div>
      </section>
      <footer className="admin-footer">
        配额簿 <span>·</span> 本地管理空间
      </footer>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(false);
          }}
        >
          <div
            className="config-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="config-dialog-title"
          >
            <div className="modal-top">
              <div>
                <span className="eyebrow">
                  {editing ? "编辑接入" : "新增接入"} · STEP {step} OF 2
                </span>
                <h2 id="config-dialog-title">
                  {step === 1 ? "选择服务渠道" : "填写账号信息"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭账号配置对话框"
                onClick={() => setModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="step-progress">
              <i className={step >= 1 ? "on" : ""} />
              <i className={step >= 2 ? "on" : ""} />
            </div>
            {step === 1 ? (
              <>
                <div className="provider-select-grid">
                  {providers.length ? (
                    providers.map((p) => (
                      <button
                        key={p.id}
                        className={`provider-choice ${providerId === p.id ? "selected" : ""}`}
                        onClick={() => {
                          setProviderId(p.id);
                          setAuthType("");
                        }}
                      >
                        <span className={`provider-mark provider-${p.id}`}>
                          {(providerNames[p.id] || p.name).slice(0, 2)}
                        </span>
                        <span>{providerNames[p.id] || p.name}</span>
                        {providerId === p.id && <CheckCircle2 size={15} />}
                      </button>
                    ))
                  ) : (
                    <div className="no-provider">服务列表加载中…</div>
                  )}
                </div>
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    onClick={() => setModal(false)}
                  >
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={!providerId}
                    onClick={() => setStep(2)}
                  >
                    继续 <ArrowRight size={14} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="form-scroll">
                  <label className="field-label">
                    账号别名
                    <input
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      placeholder="例如：个人主账号"
                      maxLength={80}
                    />
                  </label>
                  <label className="field-label">
                    认证方式
                    <select
                      value={authType}
                      disabled={testResult === "testing"}
                      onChange={(e) => {
                        setAuthType(e.target.value);
                        setCredentials({});
                        setTestResult("idle");
                      }}
                    >
                      <option value="">选择认证方式</option>
                      {authTypes.map((t) => (
                        <option key={t} value={t}>
                          {authName(t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {editing && authType && (
                    <p className="provider-help">
                      不修改凭据时全部留空；更新认证时，请重新填写全部必填项。
                    </p>
                  )}
                  {authType &&
                    fields.map((field) => (
                      <label className="field-label" key={field.key}>
                        {field.label}
                        {field.required && <i className="required-mark">*</i>}
                        {field.secret && (
                          <span className="secret-hint">
                            加密保存，不会回显
                          </span>
                        )}
                        <input
                          type={field.secret ? "password" : "text"}
                          value={credentials[field.key] || ""}
                          disabled={testResult === "testing"}
                          onChange={(e) => {
                            setCredentials({
                              ...credentials,
                              [field.key]: e.target.value,
                            });
                            setTestResult("idle");
                            setTestError("");
                          }}
                          placeholder={
                            editing &&
                            field.secret &&
                            editing.credential_configured
                              ? "已配置（不修改凭据时留空）"
                              : field.placeholder || `输入${field.label}`
                          }
                        />
                      </label>
                    ))}
                  {provider?.help && (
                    <div className="provider-help">
                      <CircleHelp size={14} />
                      {provider.help}
                      {provider.docs_url && (
                        <a
                          href={provider.docs_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          认证说明 <ArrowRight size={12} />
                        </a>
                      )}
                    </div>
                  )}
                  {testResult !== "idle" && (
                    <div className={`test-result ${testResult}`}>
                      <span>
                        {testResult === "testing" ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : testResult === "ok" ? (
                          <CheckCircle2 size={15} />
                        ) : (
                          <AlertCircle size={15} />
                        )}
                      </span>
                      {testResult === "testing"
                        ? "正在测试连接…"
                        : testResult === "ok"
                          ? "连接成功，已读取到渠道数据"
                          : testError}
                    </div>
                  )}
                </div>
                <div className="modal-actions modal-actions-split">
                  <button
                    className="button secondary"
                    onClick={() => setStep(1)}
                  >
                    <ArrowLeft size={14} />
                    上一步
                  </button>
                  <div>
                    <button
                      className="button secondary test-button"
                      disabled={!authType || testResult === "testing"}
                      onClick={() => void test()}
                    >
                      <RefreshCw size={14} />
                      测试连接
                    </button>
                    <button
                      className="button primary"
                      disabled={!alias.trim() || !authType || busy}
                      onClick={() => void save()}
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Check size={15} />
                      )}
                      保存配置
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div className="toast">
          <CheckCircle2 size={15} />
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </main>
  );
}

export default App;
