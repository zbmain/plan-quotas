import { describe, expect, it, vi, afterEach } from "vitest";
import { OpenAIAdapter } from "../src/adapters/openai.js";
import type { Fetcher } from "../src/adapters/base.js";
import { validateCredentials } from "../src/settings.js";

afterEach(() => vi.useRealTimers());

describe("OpenAI adapter", () => {
  it("validates a project key without fabricating quota", async () => {
    const client: Fetcher = async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-key",
      );
      return Response.json({ data: [] });
    };
    const [result] = await new OpenAIAdapter().fetch(
      { api_key: "test-key" },
      "api_key",
      client,
    );
    expect(result.metrics).toEqual([]);
  });
  it("reads active credit grants and balance with a console session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    const client: Fetcher = async (url, init) => {
      expect(url).toBe(
        "https://api.openai.com/v1/dashboard/billing/credit_grants",
      );
      expect(new Headers(init?.headers).get("openai-organization")).toBe(
        "org-test",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer session-test",
      );
      return Response.json({
        total_available: 71.5,
        grants: {
          data: [
            {
              id: "grant-1",
              grant_amount: 72,
              used_amount: 0.5,
              effective_at: 1794099587,
              expires_at: 1796025978,
              is_scheduled: false,
            },
            {
              id: "expired",
              grant_amount: 20,
              used_amount: 0,
              effective_at: 1700000000,
              expires_at: 1710000000,
              is_scheduled: false,
            },
          ],
        },
      });
    };
    const [result] = await new OpenAIAdapter().fetch(
      { access_token: "session-test", organization_id: "org-test" },
      "oauth",
      client,
    );
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics[0]).toMatchObject({
      kind: "balance",
      remaining: 71.5,
    });
    expect(result.metrics[1]).toMatchObject({
      kind: "quota",
      used: 0.5,
      limit: 72,
      remaining: 71.5,
    });
    expect(result.metrics[1].resets_at).toBeTruthy();
  });
  it("sums paginated organization costs using the admin key", async () => {
    const client: Fetcher = async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer admin-key",
      );
      const query = new URL(url).searchParams;
      return Response.json(
        query.has("page")
          ? {
              data: [{ results: [{ amount: { value: 2, currency: "usd" } }] }],
              has_more: false,
            }
          : {
              data: [
                { results: [{ amount: { value: 1.5, currency: "usd" } }] },
              ],
              has_more: true,
              next_page: "next",
            },
      );
    };
    const [result] = await new OpenAIAdapter().fetch(
      { admin_key: "admin-key" },
      "api_key",
      client,
    );
    expect(result.metrics[0]).toMatchObject({
      kind: "cost",
      used: 3.5,
      currency: "USD",
    });
  });
  it("requires at least one key while allowing an admin key alone", () => {
    expect(() => validateCredentials("openai", "api_key", {})).toThrow();
    expect(() =>
      validateCredentials("openai", "api_key", { admin_key: "admin-key" }),
    ).not.toThrow();
    expect(() =>
      validateCredentials("openai", "oauth", {
        access_token: "session-test",
        organization_id: "org-test",
      }),
    ).not.toThrow();
  });
  it("does not require a working project key when an admin key is provided", async () => {
    const client: Fetcher = async (url) => {
      expect(url).toContain("/organization/costs?");
      return Response.json({ data: [], has_more: false });
    };
    const [result] = await new OpenAIAdapter().fetch(
      { api_key: "old-project-key", admin_key: "admin-key" },
      "api_key",
      client,
    );
    expect(result.metrics[0]).toMatchObject({ kind: "cost", used: 0 });
  });
});
