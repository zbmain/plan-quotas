import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Mutex, Semaphore } from "async-mutex";
import type { StoredAccount } from "@plan-quotas/shared";
import { Store } from "./storage.js";
import { AdapterError, type Fetcher } from "./adapters/base.js";
import { millis } from "./time.js";
export const SEARCH_ERROR_CODES = new Set([
  "auth_required",
  "rate_limited",
  "quota_exhausted",
  "timeout",
  "network_error",
  "upstream_error",
  "invalid_response",
  "unavailable",
  "invalid_parameters",
]);
export class SearchError extends Error {
  code: string;
  /** Retain only public account attempts and an allowlisted search failure category. */
  constructor(
    code: string,
    public attempts: any[],
  ) {
    super(code);
    this.code = SEARCH_ERROR_CODES.has(code) ? code : "upstream_error";
  }
}
/** Decode at most three JSON string layers without interpreting external content as instructions. */
export function decodeLayers(value: any): any {
  if (typeof value === "string" && value.length > 1048576)
    throw new AdapterError("invalid_response");
  for (let i = 0; i < 3 && typeof value === "string"; i++)
    value = JSON.parse(value);
  return value;
}
/** Bound Retry-After seconds or HTTP dates to the same one-day ceiling. */
export function retryAfter(value: string | null): number {
  if (!value) return 60;
  const result = /^[+-]?\d+$/.test(value)
    ? Number(value)
    : Math.floor((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(result) ? Math.max(1, Math.min(result, 86400)) : 60;
}
/** Classify structured SDK/transport causes without parsing or returning their raw messages. */
export function transportError(
  error: unknown,
  seen = new Set<unknown>(),
): AdapterError {
  if (!error || typeof error !== "object" || seen.has(error))
    return new AdapterError("upstream_error");
  seen.add(error);
  if (error instanceof AdapterError)
    return new AdapterError(
      SEARCH_ERROR_CODES.has(error.code) ? error.code : "upstream_error",
      error.retry_after,
    );
  const value = error as any;
  for (const child of [
    ...(Array.isArray(value.errors) ? value.errors : []),
    value.cause,
  ]) {
    const classified = transportError(child, seen);
    if (classified.code !== "upstream_error") return classified;
  }
  const status =
    value.statusCode ??
    value.status ??
    value.data?.status ??
    value.response?.status;
  if ([401, 403].includes(status)) return new AdapterError("auth_required");
  if (status === 429)
    return new AdapterError(
      "rate_limited",
      retryAfter(value.response?.headers?.get?.("retry-after") ?? null),
    );
  if (["AbortError", "TimeoutError"].includes(value.name))
    return new AdapterError("timeout");
  return new AdapterError(
    error instanceof TypeError ? "network_error" : "upstream_error",
  );
}
/** Classify GLM tool failures without returning their raw error content. */
export function glmToolError(result: any): string {
  const fragments = (result.content ?? [])
    .filter((item: any) => typeof item.text === "string")
    .map((item: any) => item.text);
  for (const key of ["code", "status_code", "error", "message"])
    if (["string", "number"].includes(typeof result.structuredContent?.[key]))
      fragments.push(String(result.structuredContent[key]));
  const text = fragments.join(" ").toLowerCase();
  if (
    ["429", "rate limit", "too many requests", "限流"].some((value) =>
      text.includes(value),
    )
  )
    return "rate_limited";
  if (
    ["quota", "exhaust", "insufficient", "额度不足", "用量已达"].some((value) =>
      text.includes(value),
    )
  )
    return "quota_exhausted";
  if (
    ["401", "403", "unauthorized", "invalid api key", "认证失败"].some(
      (value) => text.includes(value),
    )
  )
    return "auth_required";
  return "upstream_error";
}
/** Normalize documented result fields, keeping only safe absolute HTTP(S) result URLs. */
export function normalizeResults(payload: any, maxResults = 10): any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new AdapterError("invalid_response");
  let rows = payload.organic ?? payload.results ?? payload.search_result;
  for (let i = 0; i < 3; i++) {
    if (typeof rows === "string")
      try {
        rows = decodeLayers(rows);
      } catch {
        throw new AdapterError("invalid_response");
      }
    if (rows && typeof rows === "object" && !Array.isArray(rows)) {
      rows = rows.organic ?? rows.results ?? rows.items ?? rows.search_result;
      continue;
    }
    break;
  }
  if (!Array.isArray(rows)) throw new AdapterError("invalid_response");
  const results = [];
  for (const row of rows.slice(0, maxResults)) {
    if (!row || typeof row !== "object") continue;
    const title = row.title,
      url = row.link ?? row.url,
      snippet = row.snippet ?? row.content;
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof snippet !== "string"
    )
      continue;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host)
        continue;
    } catch {
      continue;
    }
    const date = row.published_at ?? row.publish_date ?? row.date;
    results.push({
      title: title.slice(0, 500),
      url: url.slice(0, 2048),
      snippet: snippet.slice(0, 4000),
      published_at: typeof date === "string" ? date.slice(0, 100) : null,
    });
  }
  const related = Array.isArray(payload.related_searches)
    ? payload.related_searches
    : [];
  return {
    results,
    related_searches: related
      .map((item: any) =>
        item && typeof item === "object" ? item.query : item,
      )
      .filter((item: any) => typeof item === "string")
      .map((item: string) => item.slice(0, 500))
      .slice(0, 20),
  };
}
export interface SearchAdapter {
  search(apiKey: string, query: string, signal?: AbortSignal): Promise<any>;
}
/** Wait for a lock without allowing a timed-out waiter to start a later billable request. */
async function acquire(
  lock: Mutex | Semaphore,
  signal: AbortSignal,
): Promise<() => void> {
  if (signal.aborted) throw new SearchError("timeout", []);
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const abort = () => {
      abandoned = true;
      reject(new SearchError("timeout", []));
    };
    signal.addEventListener("abort", abort, { once: true });
    void lock.acquire().then((value) => {
      const release = Array.isArray(value) ? value[1] : value;
      signal.removeEventListener("abort", abort);
      if (abandoned || signal.aborted) {
        release();
        if (!abandoned) reject(new SearchError("timeout", []));
      } else resolve(release);
    });
  });
}
/** Stop awaiting an upstream search when its deadline expires, even for injected test transports. */
async function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AdapterError("timeout"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export class SearchService {
  private locks = new Map<string, Mutex>();
  private semaphore = new Semaphore(4);
  private cooldowns = new Map<string, [number, string]>();
  private shutdown = new AbortController();
  /** Share encrypted credentials while keeping search consumption separate from quota snapshots. */
  constructor(
    readonly store: Store,
    private client: Fetcher,
    private adapters: Record<string, SearchAdapter> = {},
  ) {}
  /** Stop outstanding search transports during graceful service shutdown. */
  stop(): void {
    this.shutdown.abort();
  }
  /** Return only the public identity of the account that actually handled a search. */
  private identity(account: StoredAccount): any {
    return {
      provider: account.provider,
      account_id: account.id,
      alias: account.alias,
    };
  }
  /** Build safe attempt metadata without echoing queries, headers or upstream errors. */
  private attempt(account: StoredAccount, status: string): any {
    status =
      status === "success" || SEARCH_ERROR_CODES.has(status)
        ? status
        : "upstream_error";
    return {
      ...this.identity(account),
      status,
      error_code: status === "success" ? null : status,
    };
  }
  /** Recheck mutable account flags whenever a search has waited for capacity. */
  private searchable(
    account: StoredAccount | undefined,
    provider: string | null,
  ): account is StoredAccount {
    return (
      !!account &&
      ["glm", "minimax"].includes(account.provider) &&
      (!provider || provider === account.provider) &&
      account.enabled &&
      account.search_enabled &&
      account.auth_type === "api_key"
    );
  }
  /** Restrict search quota evidence to the actual shared windows exposed by the supplier. */
  private relevant(account: StoredAccount): any[] {
    const rows = this.store.getSnapshot(account.id).data?.metrics ?? [];
    return rows.filter((row) =>
      account.provider === "minimax"
        ? ["interval-0", "weekly-0"].includes(row.id)
        : row.id.startsWith("glm-") && row.unit === "次",
    );
  }
  /** Skip only a fresh exhausted allowance that applies to web search. */
  private exhausted(account: StoredAccount): boolean {
    const snapshot = this.store.getSnapshot(account.id);
    if (
      !snapshot.data ||
      snapshot.status !== "ok" ||
      !snapshot.last_success_at ||
      Date.now() - millis(snapshot.last_success_at) >
        this.store.config.interval_minutes * 120000
    )
      return false;
    return this.relevant(account).some(
      (row) =>
        (!row.resets_at || millis(row.resets_at) > Date.now()) &&
        row.remaining !== null &&
        row.remaining <= 0 &&
        (account.provider === "minimax"
          ? row.used_percent !== null && ["5h", "week"].includes(row.window)
          : row.limit !== null),
    );
  }
  /** Expire local cooldowns without inventing a count or an independent search allowance. */
  private blocked(account: StoredAccount): string | null {
    if (this.exhausted(account)) return "quota_exhausted";
    const value = this.cooldowns.get(account.id);
    if (value && value[0] > Date.now()) return value[1];
    this.cooldowns.delete(account.id);
    return null;
  }
  /** Discover and invoke only the known GLM search tool through the official client. */
  private async glm(
    apiKey: string,
    query: string,
    signal: AbortSignal,
  ): Promise<any> {
    const client = new Client({ name: "plan-quotas-search", version: "0.0.5" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://open.bigmodel.cn/api/mcp/web_search_prime/mcp"),
      {
        // The SDK may make discovery/SSE requests; every request stays on the fixed search endpoint.
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== "https://open.bigmodel.cn" ||
            url.pathname !== "/api/mcp/web_search_prime/mcp"
          )
            throw new AdapterError("upstream_error");
          const response = await this.client(url.toString(), {
            ...init,
            redirect: "manual",
            signal: init?.signal
              ? AbortSignal.any([init.signal, signal])
              : signal,
          });
          if ([401, 403, 429].includes(response.status)) {
            const error = new AdapterError(
              response.status === 429 ? "rate_limited" : "auth_required",
              response.status === 429
                ? retryAfter(response.headers.get("retry-after"))
                : null,
            );
            await response.body?.cancel().catch(() => {});
            throw error;
          }
          return response;
        },
        requestInit: {
          headers: { Authorization: `Bearer ${apiKey}` },
          redirect: "manual",
          signal,
        },
      },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools(),
        tool = tools.tools.find((item) =>
          ["web_search_prime", "webSearchPrime"].includes(item.name),
        );
      if (!tool) throw new AdapterError("invalid_response");
      const result = await client.callTool({
        name: tool.name,
        arguments: { search_query: query },
      });
      if (result.isError) throw new AdapterError(glmToolError(result));
      const values = [
        result.structuredContent,
        ...(result.content as any[]).map((item) => item.text),
      ];
      for (const value of values) {
        try {
          const parsed = decodeLayers(value);
          if (Array.isArray(parsed)) return { search_result: parsed };
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          /* Try the next public text block. */
        }
      }
      throw new AdapterError("invalid_response");
    } catch (error) {
      if (signal.aborted) throw new AdapterError("timeout");
      throw transportError(error);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  /** Make exactly one supplier search attempt, with no automatic retry of billable requests. */
  private async search(
    provider: string,
    key: string,
    query: string,
    signal: AbortSignal,
  ): Promise<any> {
    if (this.adapters[provider])
      return this.adapters[provider].search(key, query, signal);
    if (provider === "glm") return this.glm(key, query, signal);
    let response: Response;
    try {
      response = await this.client(
        "https://api.minimax.cn/v1/coding_plan/search",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query }),
          signal,
          redirect: "manual",
        },
      );
    } catch {
      throw new AdapterError(signal.aborted ? "timeout" : "network_error");
    }
    if ([401, 403].includes(response.status))
      throw new AdapterError("auth_required");
    if (response.status === 429)
      throw new AdapterError(
        "rate_limited",
        retryAfter(response.headers.get("retry-after")),
      );
    if (!response.ok) throw new AdapterError("upstream_error");
    let payload: any;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new AdapterError("invalid_response");
    }
    const code = payload?.base_resp?.status_code;
    if (code !== undefined && code !== null && code !== 0 && code !== "0")
      throw new AdapterError(
        String(code) === "1004" ? "auth_required" : "upstream_error",
      );
    return payload;
  }
  /** Route once through enabled ordered accounts and stop even for a valid empty result. */
  async webSearch(
    query: string,
    provider: string | null = null,
    accountId: string | null = null,
    maxResults = 10,
  ): Promise<any> {
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 4000 ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 10 ||
      (provider !== null && !["glm", "minimax"].includes(provider))
    )
      throw new SearchError("invalid_parameters", []);
    let accounts = [...this.store.config.accounts].sort(
      (a, b) => a.order - b.order,
    );
    if (accountId) {
      const account = accounts.find((row) => row.id === accountId);
      if (!account || (provider && account.provider !== provider))
        throw new SearchError("unavailable", []);
      accounts = [account];
    }
    const attempts: any[] = [],
      total = new AbortController(),
      timer = setTimeout(() => total.abort(), 60000),
      signal = AbortSignal.any([total.signal, this.shutdown.signal]);
    try {
      for (const original of accounts) {
        let account = this.store.config.accounts.find(
          (row) => row.id === original.id,
        );
        if (!this.searchable(account, provider)) continue;
        let blocked = this.blocked(account);
        if (blocked) {
          attempts.push(this.attempt(account, blocked));
          continue;
        }
        if (!this.locks.has(account.id))
          this.locks.set(account.id, new Mutex());
        try {
          const releaseAccount = await acquire(
            this.locks.get(account.id)!,
            signal,
          );
          let result: any;
          try {
            account = this.store.config.accounts.find(
              (row) => row.id === original.id,
            );
            if (!this.searchable(account, provider)) continue;
            blocked = this.blocked(account);
            if (blocked) {
              attempts.push(this.attempt(account, blocked));
              continue;
            }
            const releaseGlobal = await acquire(this.semaphore, signal);
            try {
              account = this.store.config.accounts.find(
                (row) => row.id === original.id,
              );
              if (!this.searchable(account, provider)) continue;
              blocked = this.blocked(account);
              if (blocked) {
                attempts.push(this.attempt(account, blocked));
                continue;
              }
              const key = this.store.getCredentials(account.id).api_key?.trim();
              if (!key) throw new AdapterError("auth_required");
              const local = AbortSignal.any([
                signal,
                AbortSignal.timeout(15000),
              ]);
              result = await bounded(
                this.search(account.provider, key, query.trim(), local),
                local,
              );
            } finally {
              releaseGlobal();
            }
          } finally {
            releaseAccount();
          }
          const normalized = normalizeResults(result, maxResults);
          this.cooldowns.delete(account.id);
          attempts.push(this.attempt(account, "success"));
          return {
            query: query.trim(),
            ...this.identity(account),
            ...normalized,
            attempts,
          };
        } catch (error) {
          if (signal.aborted) throw new SearchError("timeout", attempts);
          const code =
            error instanceof AdapterError
              ? error.code
              : error instanceof SearchError
                ? error.code
                : "upstream_error";
          if (["rate_limited", "quota_exhausted"].includes(code)) {
            const future = this.relevant(account ?? original).flatMap((row) =>
              row.resets_at && millis(row.resets_at) > Date.now()
                ? [millis(row.resets_at)]
                : [],
            );
            const wait =
              error instanceof AdapterError ? error.retry_after : null;
            const seconds = Math.max(
              1,
              Math.min(
                wait ||
                  (future.length
                    ? Math.floor((Math.min(...future) - Date.now()) / 1000)
                    : 60),
                86400,
              ),
            );
            this.cooldowns.set(original.id, [
              Date.now() + seconds * 1000,
              code,
            ]);
          }
          attempts.push(this.attempt(account ?? original, code));
        }
      }
    } finally {
      clearTimeout(timer);
    }
    throw new SearchError(
      attempts.at(-1)?.error_code ?? "unavailable",
      attempts,
    );
  }
}
