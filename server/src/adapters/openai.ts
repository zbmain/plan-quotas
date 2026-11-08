import type { Credentials } from "@plan-quotas/shared";
import { createHash } from "node:crypto";
import {
  AdapterError,
  metric,
  number,
  object,
  requestJSON,
  requireCredential,
  timestamp,
  usage,
  now,
  type Adapter,
  type AdapterResult,
  type Fetcher,
} from "./base.js";

export class OpenAIAdapter implements Adapter {
  /** Collect UTC-month organization costs with an admin key, or validate a project key. */
  async fetch(
    credentials: Credentials,
    authType: string,
    client: Fetcher,
  ): Promise<AdapterResult> {
    if (authType === "oauth") {
      const token = requireCredential(credentials, "access_token");
      const org = requireCredential(credentials, "organization_id");
      if (!/^org-[A-Za-z0-9_-]+$/.test(org))
        throw new AdapterError("invalid_credentials");
      const root = object(
        await requestJSON(
          client,
          "GET",
          "https://api.openai.com/v1/dashboard/billing/credit_grants",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "OpenAI-Organization": org,
            },
          },
        ),
      );
      const balance = number(root.total_available);
      if (
        balance === null ||
        !Array.isArray(root.grants?.data) ||
        root.grants?.has_more === true
      )
        throw new AdapterError("invalid_response");
      const metrics = [
        metric({
          id: "openai-credit-balance",
          label: "API 可用额度",
          kind: "balance",
          unit: "USD",
          currency: "USD",
          remaining: balance,
        }),
      ];
      for (const grant of root.grants.data) {
        const amount = number(grant?.grant_amount),
          used = number(grant?.used_amount),
          starts = number(grant?.effective_at),
          expires = number(grant?.expires_at);
        if (
          !grant ||
          typeof grant.id !== "string" ||
          amount === null ||
          amount <= 0 ||
          used === null ||
          used < 0 ||
          starts === null ||
          expires === null ||
          !timestamp(starts) ||
          !timestamp(expires)
        )
          throw new AdapterError("invalid_response");
        if (
          grant.is_scheduled === true ||
          grant.is_held_for_prepaid_transition === true ||
          starts * 1000 > Date.now() ||
          expires * 1000 <= Date.now()
        )
          continue;
        const id = createHash("sha256")
          .update(grant.id)
          .digest("hex")
          .slice(0, 16);
        metrics.push(
          metric({
            id: `openai-grant-${id}`,
            label: `额度包（${new Date(starts * 1000).toISOString().slice(0, 10)} 起）`,
            kind: "quota",
            unit: "USD",
            currency: "USD",
            used,
            limit: amount,
            remaining: amount - used,
            used_percent: (used / amount) * 100,
            resets_at: timestamp(expires),
          }),
        );
      }
      return [
        usage({ plan: null, source: "openai_credit_grants", metrics }, now()),
        null,
      ];
    }
    if (authType !== "api_key") throw new AdapterError("invalid_credentials");
    const admin = credentials.admin_key?.trim();
    const key = credentials.api_key?.trim();
    if (!admin && !key) throw new AdapterError("invalid_credentials");
    const metrics = [];
    if (!admin && key) {
      const models = object(
        await requestJSON(client, "GET", "https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        }),
      );
      if (!Array.isArray(models.data))
        throw new AdapterError("invalid_response");
    }
    if (admin) {
      const date = new Date();
      const start = Math.floor(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000,
      );
      let page: string | null = null;
      let total = 0;
      let pages = 0;
      do {
        const params = new URLSearchParams({
          start_time: String(start),
          limit: "31",
        });
        if (page) params.set("page", page);
        const root = object(
          await requestJSON(
            client,
            "GET",
            `https://api.openai.com/v1/organization/costs?${params}`,
            { headers: { Authorization: `Bearer ${admin}` } },
          ),
        );
        if (!Array.isArray(root.data))
          throw new AdapterError("invalid_response");
        for (const bucket of root.data) {
          if (!Array.isArray(bucket?.results))
            throw new AdapterError("invalid_response");
          for (const row of bucket.results) {
            const value = number(row?.amount?.value);
            if (
              value === null ||
              String(row?.amount?.currency).toLowerCase() !== "usd"
            )
              throw new AdapterError("invalid_response");
            total += value;
          }
        }
        page =
          root.has_more === true &&
          typeof root.next_page === "string" &&
          root.next_page
            ? root.next_page
            : null;
        if (root.has_more === true && !page)
          throw new AdapterError("invalid_response");
        if (++pages > 100) throw new AdapterError("invalid_response");
      } while (page);
      metrics.push(
        metric({
          id: "openai-monthly-cost",
          label: "本月组织费用（UTC）",
          kind: "cost",
          unit: "USD",
          used: total,
          currency: "USD",
          window: "monthly",
        }),
      );
    }
    return [usage({ plan: null, source: "openai", metrics }, now()), null];
  }
}
