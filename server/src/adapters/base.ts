import type { Credentials, UsageResult } from "@plan-quotas/shared";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
export { metric, usage } from "@plan-quotas/shared";
export { timestamp, now, addMillis, millis } from "../time.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type AdapterResult = [UsageResult, Credentials | null];
const networkRetryPolicy = new AsyncLocalStorage<number>();

/** Scope network retries to one collection without changing concurrent search or connection tests. */
export function withNetworkRetries<T>(
  retries: number,
  operation: () => Promise<T>,
): Promise<T> {
  return networkRetryPolicy.run(retries, operation);
}
export interface Adapter {
  fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult>;
}
export class AdapterError extends Error {
  rotated_credentials?: Credentials;
  /** Keep only an allowlisted category and a bounded retry delay, never an upstream body. */
  constructor(
    public code: string,
    public retry_after: number | null = null,
  ) {
    super(code);
  }
}
/** Accept only a JSON object before reading supplier-specific properties. */
export function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterError("invalid_response");
  return value;
}
/** Convert optional numeric fields without inventing a zero for missing values. */
export function number(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "object"
  )
    return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
/** Read a declared credential without reflecting its contents in errors. */
export function requireCredential(
  credentials: Credentials,
  key: string,
): string {
  const value = credentials[key]?.trim();
  if (!value) throw new AdapterError("invalid_credentials");
  return value;
}
/** Read a cookie by exact name, leaving unrelated browser state untouched. */
export function cookieValue(cookie: string, names: string[]): string | null {
  for (const item of cookie.split(";")) {
    const pos = item.indexOf("=");
    if (
      pos >= 0 &&
      names.includes(item.slice(0, pos).trim()) &&
      item.slice(pos + 1).trim()
    )
      return item.slice(pos + 1).trim();
  }
  return null;
}
/** Decode public JWT claims used by a supplier's correlation headers. */
export function jwtClaims(token: string): Record<string, any> {
  try {
    return object(
      JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()),
    );
  } catch {
    return {};
  }
}
export type RequestOptions = {
  headers?: Record<string, string>;
  json?: any;
  data?: Record<string, string> | null;
  content?: string;
  oauth_token?: boolean;
  forbidden_code?: string;
  signal?: AbortSignal;
};
/** Retry network failures under the collection policy; retry server failures once and reject redirects. */
export async function requestJSON(
  client: Fetcher,
  method: string,
  url: string,
  options: RequestOptions = {},
): Promise<any> {
  const networkRetries = networkRetryPolicy.getStore() ?? 1;
  let networkFailures = 0;
  let serverFailures = 0;
  for (;;) {
    let response: Response;
    let text: string;
    try {
      const headers = { ...options.headers };
      let body: string | undefined;
      if (options.json !== undefined && options.json !== null) {
        body = JSON.stringify(options.json);
        headers["Content-Type"] ??= "application/json";
      }
      if (options.data) {
        body = new URLSearchParams(options.data).toString();
        headers["Content-Type"] ??= "application/x-www-form-urlencoded";
      }
      if (options.content !== undefined) body = options.content;
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000);
      response = await client(url, {
        method,
        headers,
        body,
        signal,
        redirect: "manual",
      });
      // Native fetch resolves at headers; include streamed body reads in the network deadline.
      text = await response.text();
    } catch {
      if (networkFailures < networkRetries && !options.signal?.aborted) {
        await delay(250 * 2 ** networkFailures++);
        continue;
      }
      throw new AdapterError("network_error");
    }
    if (response.status === 401) throw new AdapterError("auth_required");
    if (response.status === 403)
      throw new AdapterError(options.forbidden_code ?? "auth_required");
    if (response.status === 429) {
      const raw = response.headers.get("retry-after") ?? "60";
      let seconds = /^[+-]?\d+$/.test(raw)
        ? Number(raw)
        : Math.floor((Date.parse(raw) - Date.now()) / 1000);
      if (!Number.isFinite(seconds)) seconds = 60;
      throw new AdapterError(
        "rate_limited",
        Math.max(1, Math.min(seconds, 86400)),
      );
    }
    if (response.status === 400 && options.oauth_token) {
      let error;
      try {
        error = JSON.parse(text)?.error;
      } catch {
        /* A non-JSON OAuth failure is still an upstream error. */
      }
      if (
        ["invalid_grant", "invalid_client", "unauthorized_client"].includes(
          error,
        )
      )
        throw new AdapterError("auth_required");
      throw new AdapterError("upstream_error");
    }
    if (
      response.status >= 500 &&
      serverFailures++ === 0 &&
      !options.signal?.aborted
    ) {
      await delay(250);
      continue;
    }
    if (!response.ok) throw new AdapterError("upstream_error");
    try {
      return JSON.parse(text);
    } catch {
      throw new AdapterError("invalid_response");
    }
  }
}
/** Preserve a rotated OAuth credential even when parsing the subsequent usage response fails. */
export function rotatedError(
  code: string,
  rotated: Credentials | null,
): AdapterError {
  const error = new AdapterError(code);
  if (rotated) error.rotated_credentials = rotated;
  return error;
}
