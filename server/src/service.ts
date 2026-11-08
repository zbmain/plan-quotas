import { Mutex, Semaphore } from "async-mutex";
import {
  UsageSchema,
  SnapshotSchema,
  metric,
  VERIFIED_AUTH_METHODS,
  type StoredAccount,
  type Snapshot,
  type Credentials,
  type UsageResult,
} from "@plan-quotas/shared";
import { Store } from "./storage.js";
import { buildQuotaList } from "./quota-view.js";
import {
  buildResponse,
  accountHeader,
  historyResponse,
} from "./quota-protocol.js";
import {
  AdapterError,
  withNetworkRetries,
  type Adapter,
  type Fetcher,
} from "./adapters/base.js";
import { now, millis, addMillis, compare, utc } from "./time.js";

export const SAFE_ERRORS = new Set([
  "auth_required",
  "invalid_credentials",
  "rate_limited",
  "network_error",
  "upstream_error",
  "invalid_response",
  "subscription_unavailable",
]);
/** Compare credential revisions without relying on insertion-order differences. */
function same(a: Credentials, b: Credentials): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => a[key] === b[key])
  );
}
export class QuotaService {
  private semaphore = new Semaphore(4);
  private locks = new Map<string, Mutex>();
  private manual = new Map<string, number>();
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanupDate: string | null = null;
  private polling: Promise<void> | null = null;
  /** Bind collection state to one store and one injectable fixed-host HTTP transport. */
  constructor(
    readonly store: Store,
    private client: Fetcher,
    readonly adapters: Record<string, Adapter>,
  ) {}
  /** Share each account's mutation lock between refreshes and administrator writes. */
  accountLock(id: string): Mutex {
    if (!this.locks.has(id)) this.locks.set(id, new Mutex());
    return this.locks.get(id)!;
  }
  /** Share the four-account collection capacity with administrator connection tests. */
  withCollection<T>(work: () => Promise<T>): Promise<T> {
    return this.semaphore.runExclusive(work);
  }
  /** Retain stable configured ordering, including paused accounts. */
  ordered(): StoredAccount[] {
    return [...this.store.config.accounts].sort((a, b) => a.order - b.order);
  }
  /** Look up current configuration after an asynchronous wait. */
  find(id: string): StoredAccount | undefined {
    return this.store.config.accounts.find((row) => row.id === id);
  }
  /** Verify a result still belongs to the exact credential revision that initiated it. */
  private current(id: string, credentials: Credentials): boolean {
    return !!this.find(id) && same(this.store.getCredentials(id), credentials);
  }
  /** Preserve the public account whitelist independently of the persisted credential metadata. */
  publicAccount(
    account: StoredAccount,
    snapshot: Snapshot,
    includeData = false,
  ): any {
    const stale =
      !!snapshot.data &&
      (snapshot.status !== "ok" ||
        snapshot.last_success_at === null ||
        Date.now() - millis(snapshot.last_success_at) >
          this.store.config.interval_minutes * 120000);
    const deadline = snapshot.last_success_at
      ? addMillis(
          snapshot.last_success_at,
          this.store.config.interval_minutes * 120000,
        )
      : null;
    // Older failed snapshots lack the first failure time, so do not invent one.
    const staleSince = !stale
      ? null
      : snapshot.status === "ok"
        ? deadline
        : snapshot.stale_since && deadline
          ? compare(snapshot.stale_since, deadline) < 0
            ? snapshot.stale_since
            : deadline
          : snapshot.stale_since;
    const result: any = {
      id: account.id,
      provider: account.provider,
      alias: account.alias,
      enabled: account.enabled,
      status: account.enabled ? snapshot.status : "disabled",
      stale,
      stale_since: staleSince,
      last_attempt_at: snapshot.last_attempt_at,
      last_success_at: snapshot.last_success_at,
      error_code: snapshot.error_code,
      verification: VERIFIED_AUTH_METHODS.has(
        `${account.provider}:${account.auth_type}`,
      )
        ? "verified"
        : "not_tested",
    };
    if (includeData)
      result.data = snapshot.data ? structuredClone(snapshot.data) : null;
    return result;
  }
  /** Return safe directory rows for selector resolution without reading any credentials. */
  listAccounts(
    provider: string | null = null,
    status: string | null = null,
  ): any[] {
    return this.ordered()
      .filter((row) => !provider || row.provider === provider)
      .map((account) => ({
        ...this.publicAccount(account, this.store.getSnapshot(account.id)),
        order: account.order,
        search_supported:
          ["glm", "minimax"].includes(account.provider) &&
          account.auth_type === "api_key",
        search_enabled: account.search_enabled,
      }))
      .filter((row) =>
        !status || status === "stale"
          ? !status || (row.enabled && row.stale)
          : row.status === status,
      );
  }
  /** Read current snapshots only, with no implicit supplier collection. */
  getUsage(ids: string[] | null = null, provider: string | null = null): any[] {
    return this.ordered()
      .filter(
        (row) =>
          (ids === null || ids.includes(row.id)) &&
          (!provider || row.provider === provider),
      )
      .map((account) =>
        this.publicAccount(account, this.store.getSnapshot(account.id), true),
      );
  }
  /** Build the unchanged internal dashboard payload used by the existing React interface. */
  dashboard(): any {
    const accounts = this.getUsage(),
      active = accounts.filter((row) => row.enabled),
      healthy = active.filter((row) => row.status === "ok" && !row.stale);
    const times = accounts
      .flatMap((row) => (row.last_success_at ? [row.last_success_at] : []))
      .sort(compare);
    return {
      accounts,
      summary: {
        total: accounts.length,
        healthy: healthy.length,
        low: healthy.filter((row) => QuotaService.isLow(row.data)).length,
        errors: active.filter((row) =>
          ["auth_required", "rate_limited", "error"].includes(row.status),
        ).length,
        updated_at: times.at(-1) ?? null,
      },
      interval_minutes: this.store.config.interval_minutes,
      list: buildQuotaList(accounts),
    };
  }
  /** Project the shared V2 HTTP/MCP protocol while preserving selection order. */
  queryQuotas(
    options: {
      category?: string;
      provider?: string | null;
      account_ids?: string[] | null;
      window?: string | null;
      tool?: string | null;
    } = {},
  ): any {
    return buildResponse(
      this.getUsage(options.account_ids ?? null, options.provider ?? null),
      this.store.config.interval_minutes,
      {
        category: options.category,
        period: options.window,
        tool: options.tool,
      },
    );
  }
  /** Return the V2 account directory with current status filtering and search metadata. */
  protocolAccounts(
    provider: string | null = null,
    status: string | null = null,
  ): any[] {
    return this.ordered()
      .filter((row) => !provider || row.provider === provider)
      .map((account) => ({
        ...accountHeader(
          this.publicAccount(account, this.store.getSnapshot(account.id), true),
        ),
        order: account.order,
        searchSupported:
          ["glm", "minimax"].includes(account.provider) &&
          account.auth_type === "api_key",
        searchEnabled: account.search_enabled,
      }))
      .filter((row) => !status || row.status === status);
  }
  /** Keep hidden GLM tool counters from creating visible trend resets. */
  history(id: string, range: string): any {
    const account = this.find(id);
    if (!account) return { account_id: id, range, points: [] };
    return this.store.history(
      id,
      range,
      account.provider === "glm" ? ["glm-mcp-"] : [],
    );
  }
  /** Return actual history using the same quota fields as current external queries. */
  protocolHistory(id: string, range: string): any {
    const account = this.getUsage([id])[0];
    if (!account) throw new Error("账号不存在");
    return historyResponse(account, this.history(id, range));
  }
  /** Read every selected channel account's last twenty-four hours without collecting upstream data. */
  protocolHistories(provider: string | null = null): any {
    const accounts = this.ordered()
      .filter((account) => !provider || account.provider === provider)
      .map((account) => {
        const history = this.protocolHistory(account.id, "24h");
        return { ...history.account, points: history.points };
      });
    return {
      version: 2,
      range: "24h",
      accountCount: accounts.length,
      accounts,
    };
  }
  /** Strip credential substrings before constructing a whitelisted persisted result. */
  static sanitize(result: UsageResult, credentials: Credentials): UsageResult {
    const secrets = Object.values(credentials).filter(
      (value) => typeof value === "string" && value,
    );
    const clean = (
      value: string | null,
      fallback: string | null = null,
    ): string | null => {
      if (value === null) return null;
      let text = value;
      for (const secret of secrets)
        text = text.replace(
          new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          "[已隐藏]",
        );
      return text.slice(0, 160) || fallback;
    };
    const metrics = result.metrics.map((row, index) =>
      metric({
        ...row,
        id: clean(row.id, `metric-${index}`)!,
        label: clean(row.label, "额度")!,
        window: clean(row.window),
        currency: clean(row.currency),
        unit: clean(row.unit, "%")!,
      }),
    );
    return UsageSchema.parse({
      plan: clean(result.plan),
      metrics,
      source: "provider_adapter",
      fetched_at: utc(result.fetched_at),
    });
  }
  /** Flag only known model/tool pressure; balances retain their monetary semantics. */
  static isLow(data: any): boolean {
    return (
      !!data &&
      data.metrics.some(
        (row: any) =>
          row.kind === "quota" &&
          ((row.remaining != null &&
            row.limit > 0 &&
            row.remaining / row.limit <= 0.2) ||
            (row.used_percent != null && row.used_percent >= 80)),
      )
    );
  }
  /** Clear an auth pause only after credentials or authentication settings have been changed. */
  resetAccount(id: string): Snapshot {
    const current = this.store.getSnapshot(id),
      reset = {
        ...current,
        status: "pending" as const,
        error_code: null,
        retry_at: null,
        last_attempt_at: null,
      };
    this.manual.delete(id);
    this.store.saveSnapshot(reset);
    return reset;
  }
  /** Commit a safe failure without discarding the previous successful observation. */
  private failure(
    id: string,
    credentials: Credentials,
    previous: Snapshot,
    code: string,
    attempted: string,
    retry_at: string | null = null,
  ): Snapshot {
    if (!this.current(id, credentials)) return this.store.getSnapshot(id);
    const status = ["auth_required", "invalid_credentials"].includes(code)
      ? "auth_required"
      : code === "rate_limited"
        ? "rate_limited"
        : "error";
    const result = SnapshotSchema.parse({
      account_id: id,
      status,
      data: previous.data,
      last_attempt_at: attempted,
      last_success_at: previous.last_success_at,
      stale_since: previous.data
        ? (previous.stale_since ?? (previous.status === "ok" ? now() : null))
        : null,
      error_code: code,
      retry_at,
    });
    this.store.saveSnapshot(result);
    return result;
  }
  /** Collect once per account and discard stale results following any credential revision. */
  async refresh(id: string, manual = false): Promise<Snapshot> {
    const lock = this.accountLock(id),
      waiting = lock.isLocked();
    return lock.runExclusive(async () => {
      let account = this.find(id);
      if (!account) return this.store.getSnapshot(id);
      const previous = this.store.getSnapshot(id);
      if (waiting) return previous;
      if (!account.enabled) {
        const disabled = {
          ...previous,
          status: "disabled" as const,
          error_code: null,
        };
        this.store.saveSnapshot(disabled);
        return disabled;
      }
      if (
        previous.status === "auth_required" ||
        (previous.status === "rate_limited" &&
          previous.retry_at &&
          compare(previous.retry_at, now()) > 0)
      )
        return previous;
      if (
        manual &&
        this.manual.has(id) &&
        Date.now() - this.manual.get(id)! < 60000
      )
        return previous;
      if (manual) this.manual.set(id, Date.now());
      const attempted = now(),
        credentials = this.store.getCredentials(id);
      return this.semaphore.runExclusive(async () => {
        account = this.find(id);
        if (!account) return previous;
        if (!account.enabled) {
          const disabled = {
            ...previous,
            status: "disabled" as const,
            error_code: null,
          };
          this.store.saveSnapshot(disabled);
          return disabled;
        }
        if (!same(this.store.getCredentials(id), credentials))
          return this.store.getSnapshot(id);
        let result: UsageResult,
          rotated: Credentials | null = null;
        const client: Fetcher = (url, options) =>
          this.client(url, {
            ...options,
            signal: options?.signal
              ? AbortSignal.any([options.signal, this.controller.signal])
              : this.controller.signal,
          });
        try {
          const adapter = this.adapters[account.provider];
          if (!adapter) throw new AdapterError("invalid_response");
          [result, rotated] = await withNetworkRetries(manual ? 1 : 3, () =>
            adapter.fetch(credentials, account!.auth_type, client),
          );
          result = QuotaService.sanitize(UsageSchema.parse(result), {
            ...credentials,
            ...rotated,
          });
        } catch (error) {
          let code =
              error instanceof AdapterError && SAFE_ERRORS.has(error.code)
                ? error.code
                : "invalid_response",
            retry: string | null = null;
          if (code === "rate_limited")
            retry = addMillis(
              now(),
              Math.max(
                1,
                Math.min(
                  error instanceof AdapterError
                    ? (error.retry_after ?? 60)
                    : 60,
                  86400,
                ),
              ) * 1000,
            );
          let current = credentials;
          const rotation =
            error instanceof AdapterError
              ? error.rotated_credentials
              : undefined;
          if (rotation) {
            if (
              typeof rotation !== "object" ||
              Array.isArray(rotation) ||
              Object.values(rotation).some((value) => typeof value !== "string")
            ) {
              code = "invalid_response";
              retry = null;
            } else if (this.current(id, credentials)) {
              this.store.setCredentials(id, rotation);
              current = rotation;
            }
          }
          return this.failure(id, current, previous, code, attempted, retry);
        }
        if (!this.current(id, credentials)) return this.store.getSnapshot(id);
        if (rotated) this.store.setCredentials(id, rotated);
        const snapshot = SnapshotSchema.parse({
          account_id: id,
          status: "ok",
          data: result,
          last_attempt_at: attempted,
          last_success_at: result.fetched_at,
        });
        this.store.saveSnapshot(snapshot);
        try {
          this.store.appendHistory(id, result);
        } catch {
          console.warn(
            `quota_service_error code=history_write_failed account_id=${id}`,
          );
        }
        return snapshot;
      });
    });
  }
  /** Start one poll loop, avoiding overlapping cycles while retaining a five-second due check. */
  start(): void {
    if (this.polling || this.timer) return;
    const tick = async () => {
      if (this.controller.signal.aborted) return;
      this.polling = this.pollOnce();
      try {
        await this.polling;
      } finally {
        this.polling = null;
        if (!this.controller.signal.aborted)
          this.timer = setTimeout(tick, 5000);
      }
    };
    void tick();
  }
  /** Apply existing per-account scheduling and daily retention without surfacing private exceptions. */
  async pollOnce(): Promise<void> {
    const due = this.store.config.accounts.filter((account) => {
      if (!account.enabled) return false;
      try {
        const snapshot = this.store.getSnapshot(account.id),
          reference = snapshot.last_attempt_at || snapshot.last_success_at;
        return (
          !reference ||
          Date.now() - millis(reference) >=
            this.store.config.interval_minutes * 60000
        );
      } catch {
        console.warn(
          `quota_service_error code=snapshot_read_failed account_id=${account.id}`,
        );
        return false;
      }
    });
    await Promise.allSettled(due.map((account) => this.refresh(account.id)));
    const date = now().slice(0, 10);
    if (this.cleanupDate !== date)
      try {
        this.store.cleanupHistory();
        this.cleanupDate = date;
      } catch {
        console.warn("quota_service_error code=history_cleanup_failed");
      }
  }
  /** Abort supplier reads and wait for the active poll before releasing the data lease. */
  async stop(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.polling) await this.polling;
  }
}
