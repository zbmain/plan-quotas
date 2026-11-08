import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  metric,
  SnapshotSchema,
  type StoredAccount,
} from "@plan-quotas/shared";
import { Store } from "../src/storage.js";
import { QuotaService } from "../src/service.js";
import {
  SearchService,
  normalizeResults,
  decodeLayers,
  glmToolError,
  type SearchAdapter,
} from "../src/search.js";
import {
  AdapterError,
  requestJSON,
  type Adapter,
  type Fetcher,
} from "../src/adapters/base.js";
import { account, tempRoot, result } from "./helpers.js";
import { addMillis, now } from "../src/time.js";
const stores: Store[] = [],
  roots: string[] = [],
  services: QuotaService[] = [],
  searches: SearchService[] = [];
/** Supply a manually releasable promise for deterministic concurrent-request checks. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
/** Allocate only synthetic credentials and fail the test if any real HTTP request is attempted. */
async function fresh(
  adapter?: Adapter,
  searchAdapters?: Record<string, SearchAdapter>,
  profiles: StoredAccount[] = [account({ search_enabled: true })],
  client: Fetcher = async () => {
    throw new Error("unexpected external network");
  },
) {
  const root = tempRoot();
  roots.push(root.root);
  const store = new Store(root.data);
  stores.push(store);
  await store.open();
  store.saveConfig({ ...store.config, accounts: profiles });
  for (const row of profiles)
    store.setCredentials(row.id, { api_key: "fixture-secret-" + row.id });
  const fake: Adapter = adapter ?? {
    fetch: vi.fn<Adapter["fetch"]>(async () => [result(), null]),
  };
  const service = new QuotaService(store, client, { glm: fake, minimax: fake });
  services.push(service);
  const search = new SearchService(store, client, searchAdapters);
  searches.push(search);
  return { store, service, search, profiles, fake };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const search of searches.splice(0)) search.stop();
  for (const service of services.splice(0)) await service.stop();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("persists sanitized successful observations and keeps balance zero out of quota pressure", async () => {
  const {
    store,
    service,
    profiles: [one],
  } = await fresh();
  expect((await service.refresh(one.id)).status).toBe("ok");
  expect(store.getSnapshot(one.id).data!.source).toBe("provider_adapter");
  expect(service.dashboard().summary).toMatchObject({
    healthy: 1,
    low: 1,
    errors: 0,
  });
  expect(JSON.stringify(service.dashboard())).not.toMatch(
    /credentials|api_key|fixture-secret/,
  );
  expect(
    QuotaService.isLow({
      ...result(),
      metrics: [
        metric({ id: "wallet", label: "余额", kind: "balance", remaining: 0 }),
      ],
    }),
  ).toBe(false);
});
it("pauses repeated authentication failures until credentials are reset", async () => {
  const call = vi.fn(async () => {
      throw new AdapterError("auth_required");
    }),
    {
      service,
      profiles: [one],
    } = await fresh({ fetch: call });
  await service.refresh(one.id);
  await service.refresh(one.id, true);
  expect(call).toHaveBeenCalledTimes(1);
  service.resetAccount(one.id);
  call.mockImplementation(async () => [result(), null] as never);
  expect((await service.refresh(one.id, true)).status).toBe("ok");
  expect(call).toHaveBeenCalledTimes(2);
});
it("honors Retry-After and the sixty-second manual refresh cooldown", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const call = vi.fn(async () => {
      throw new AdapterError("rate_limited", 3600);
    }),
    {
      store,
      service,
      profiles: [one],
    } = await fresh({ fetch: call });
  const snapshot = await service.refresh(one.id, true);
  expect(snapshot.retry_at).toBe(addMillis(now(), 3600000));
  await service.refresh(one.id);
  expect(call).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 3600001);
  call.mockImplementation(async () => [result(), null] as never);
  expect((await service.refresh(one.id, true)).status).toBe("ok");
  await service.refresh(one.id, true);
  expect(call).toHaveBeenCalledTimes(2);
  expect(store.history(one.id, "24h").points.some((row: any) => !row.gap)).toBe(
    true,
  );
});
it.each([false, true])(
  "retries scheduled network failures three times before publishing failure (exhausted=%s)",
  async (exhausted) => {
    const fourth = gate(),
      released = gate();
    const client = vi.fn<Fetcher>(async () => {
      if (client.mock.calls.length <= 3)
        throw new TypeError("synthetic disconnect");
      fourth.release();
      await released.promise;
      if (exhausted)
        throw new DOMException("synthetic timeout", "TimeoutError");
      return new Response('{"ok":true}');
    });
    const adapter: Adapter = {
      async fetch(_credentials, _auth, transport) {
        await requestJSON(transport, "GET", "https://example.com/usage");
        return [result(), null];
      },
    };
    const {
      store,
      service,
      profiles: [one],
    } = await fresh(adapter, undefined, undefined, client);
    const previous = SnapshotSchema.parse({
      account_id: one.id,
      status: "ok",
      data: result(),
      last_attempt_at: addMillis(now(), -120000),
      last_success_at: addMillis(now(), -120000),
    });
    store.saveSnapshot(previous);
    const pending = service.pollOnce();
    await fourth.promise;
    try {
      expect(client).toHaveBeenCalledTimes(4);
      expect(store.getSnapshot(one.id)).toEqual(previous);
    } finally {
      released.release();
      await pending;
    }
    const snapshot = store.getSnapshot(one.id);
    expect(client).toHaveBeenCalledTimes(4);
    expect(snapshot.status).toBe(exhausted ? "error" : "ok");
    expect(snapshot.error_code).toBe(exhausted ? "network_error" : null);
    if (exhausted) {
      expect(snapshot.data).toEqual(previous.data);
      expect(snapshot.last_success_at).toBe(previous.last_success_at);
    }
  },
);

it.each([401, 403, 429, 400, 302])(
  "does not apply scheduled network retries to HTTP %s",
  async (status) => {
    const client = vi
      .fn<Fetcher>()
      .mockImplementation(async () => new Response("{}", { status }));
    const adapter: Adapter = {
      async fetch(_credentials, _auth, transport) {
        await requestJSON(transport, "GET", "https://example.com/usage");
        return [result(), null];
      },
    };
    const { service } = await fresh(adapter, undefined, undefined, client);
    await service.pollOnce();
    expect(client).toHaveBeenCalledTimes(1);
  },
);

it("isolates scheduled network retries from a concurrent manual refresh", async () => {
  const adapter: Adapter = {
    async fetch(_credentials, _auth, transport) {
      await requestJSON(transport, "GET", "https://example.com/usage");
      return [result(), null];
    },
  };
  const automaticClient = vi
    .fn<Fetcher>()
    .mockRejectedValue(new TypeError("synthetic disconnect"));
  const manualClient = vi
    .fn<Fetcher>()
    .mockRejectedValue(new TypeError("synthetic disconnect"));
  const automatic = await fresh(adapter, undefined, undefined, automaticClient);
  const manual = await fresh(adapter, undefined, undefined, manualClient);
  await Promise.all([
    automatic.service.pollOnce(),
    manual.service.refresh(manual.profiles[0].id, true),
  ]);
  expect(automaticClient).toHaveBeenCalledTimes(4);
  expect(manualClient).toHaveBeenCalledTimes(2);
});

it("coalesces duplicate collection requests under the same account lock", async () => {
  const entered = gate(),
    released = gate(),
    call = vi.fn(async () => {
      entered.release();
      await released.promise;
      return [result(), null] as [ReturnType<typeof result>, null];
    }),
    {
      service,
      profiles: [one],
    } = await fresh({ fetch: call });
  const first = service.refresh(one.id);
  await entered.promise;
  const second = service.refresh(one.id);
  released.release();
  expect(
    (await Promise.all([first, second])).every((row) => row.status === "ok"),
  ).toBe(true);
  expect(call).toHaveBeenCalledTimes(1);
});
for (const change of ["credentials", "delete"])
  it(`discards an inflight collection after ${change}`, async () => {
    const entered = gate(),
      released = gate(),
      {
        service,
        store,
        profiles: [one],
      } = await fresh({
        fetch: async () => {
          entered.release();
          await released.promise;
          return [result(), null];
        },
      });
    const pending = service.refresh(one.id);
    await entered.promise;
    if (change === "credentials")
      store.setCredentials(one.id, { api_key: "replaced" });
    else store.saveConfig({ ...store.config, accounts: [] });
    released.release();
    expect((await pending).status).toBe("pending");
    expect(store.getSnapshot(one.id).data).toBeNull();
  });
it("retains last good data and a refreshed OAuth bundle even if the next response fails", async () => {
  const call = vi.fn(
      async () => [result(), null] as [ReturnType<typeof result>, null],
    ),
    {
      service,
      store,
      profiles: [one],
    } = await fresh({ fetch: call });
  await service.refresh(one.id);
  const previous = store.getSnapshot(one.id);
  const failure = new AdapterError("invalid_response");
  failure.rotated_credentials = {
    access_token: "new-access",
    refresh_token: "new-refresh",
  };
  call.mockRejectedValue(failure);
  const failed = await service.refresh(one.id);
  expect(failed.data).toEqual(previous.data);
  expect(failed.last_success_at).toBe(previous.last_success_at);
  expect(store.getCredentials(one.id)).toEqual(failure.rotated_credentials);
  expect(service.dashboard().summary.healthy).toBe(0);
  expect(service.dashboard().accounts[0].stale).toBe(true);
});
it("reduces unexpected exceptions and credential-bearing fields to safe values", async () => {
  const {
    service,
    store,
    profiles: [one],
  } = await fresh({
    fetch: async () => {
      throw new Error("unsafe fixture-secret");
    },
  });
  expect((await service.refresh(one.id)).error_code).toBe("invalid_response");
  expect(JSON.stringify(store.getSnapshot(one.id))).not.toContain("unsafe");
  const secret = "x".repeat(300),
    data = QuotaService.sanitize(
      {
        ...result(),
        plan: "before " + secret,
        metrics: [
          metric({
            id: secret,
            label: secret.toUpperCase(),
            window: secret,
            unit: secret,
          }),
        ],
      },
      { api_key: secret },
    );
  expect(JSON.stringify(data)).not.toContain(secret);
  expect(data.plan).toBe("before [已隐藏]");
});
it("keeps a new snapshot when history append fails and retries cleanup on later polls", async () => {
  const {
    service,
    store,
    profiles: [one],
  } = await fresh();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(store, "appendHistory").mockImplementation(() => {
    throw new Error("private detail");
  });
  expect((await service.refresh(one.id)).status).toBe("ok");
  expect(store.getSnapshot(one.id).status).toBe("ok");
  const cleanup = vi
    .spyOn(store, "cleanupHistory")
    .mockImplementationOnce(() => {
      throw new Error("private detail");
    });
  await service.pollOnce();
  await service.pollOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
    "private detail",
  );
});
it("shares four collection slots with connection tests and retains configured ordering", async () => {
  let active = 0,
    peak = 0;
  const call = async () => {
    active++;
    peak = Math.max(peak, active);
    await delay(8);
    active--;
    return [result(), null] as [ReturnType<typeof result>, null];
  };
  const profiles = Array.from({ length: 8 }, (_, i) =>
    account({ order: 8 - i }),
  );
  const { service } = await fresh({ fetch: call }, {}, profiles);
  await Promise.all([
    ...profiles.map((row) => service.refresh(row.id)),
    ...Array.from({ length: 4 }, () => service.withCollection(call)),
  ]);
  expect(peak).toBe(4);
  expect(service.protocolAccounts().map((row) => row.id)).toEqual(
    [...profiles].reverse().map((row) => row.id),
  );
});
it("rechecks paused account state after waiting for the collection capacity", async () => {
  const held = gate(),
    entered = gate(),
    profiles = Array.from({ length: 5 }, () => account()),
    call = vi.fn(async () => {
      if (call.mock.calls.length === 4) entered.release();
      await held.promise;
      return [result(), null] as [ReturnType<typeof result>, null];
    }),
    { service, store } = await fresh({ fetch: call }, {}, profiles);
  const pending = profiles.map((row) => service.refresh(row.id));
  await entered.promise;
  store.saveConfig({
    ...store.config,
    accounts: profiles.map((row, i) =>
      i === 4 ? { ...row, enabled: false } : row,
    ),
  });
  held.release();
  await Promise.all(pending);
  expect(call).toHaveBeenCalledTimes(4);
});
for (const payload of [
  {},
  { organic: {} },
  { search_result: null },
  [],
  null,
  { error: "raw secret" },
])
  it(`rejects malformed search payload ${JSON.stringify(payload)}`, () => {
    expect(() => normalizeResults(payload)).toThrow("invalid_response");
  });
it("normalizes nested GLM JSON, dates and safe result URLs without extra upstream fields", () => {
  const response = {
    search_result: JSON.stringify({
      items: [
        {
          title: "官方",
          link: "https://example.com",
          content: "内容",
          publish_date: "2026-11-07",
          secret: "not-public",
        },
        { title: "bad", link: "javascript:alert(1)", content: "unsafe" },
      ],
    }),
    related_searches: [{ query: "相关" }, "另一个", 3],
  };
  expect(normalizeResults(response)).toEqual({
    results: [
      {
        title: "官方",
        url: "https://example.com",
        snippet: "内容",
        published_at: "2026-11-07",
      },
    ],
    related_searches: ["相关", "另一个"],
  });
  expect(decodeLayers(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({
    a: 1,
  });
});
for (const [text, expected] of [
  ["429 too many requests", "rate_limited"],
  ["quota exhausted", "quota_exhausted"],
  ["invalid api key 401", "auth_required"],
  ["unrecognized unsafe secret", "upstream_error"],
])
  it(`classifies GLM search error as ${expected}`, () => {
    expect(glmToolError({ content: [{ type: "text", text }] })).toBe(expected);
  });
it("routes by configured account order and stops at a valid empty search", async () => {
  const seen: string[] = [],
    profiles = [
      account({ provider: "minimax", order: 9, search_enabled: true }),
      account({ order: 1, search_enabled: true }),
    ],
    stub = {
      search: async (key: string) => {
        seen.push(key);
        return { organic: [] };
      },
    },
    { search } = await fresh(undefined, { glm: stub, minimax: stub }, profiles);
  const response = await search.webSearch("q");
  expect(response.account_id).toBe(profiles[1].id);
  expect(response.results).toEqual([]);
  expect(seen).toEqual(["fixture-secret-" + profiles[1].id]);
});
it("falls back once per account, respects provider filters and preserves safe attempt identities", async () => {
  const profiles = [
      account({ order: 0, search_enabled: true }),
      account({ provider: "minimax", order: 1, search_enabled: true }),
    ],
    glm = vi.fn(async () => {
      throw new AdapterError("auth_required");
    }),
    mini = vi.fn(async () => ({ organic: [] })),
    { search } = await fresh(
      undefined,
      { glm: { search: glm }, minimax: { search: mini } },
      profiles,
    );
  const response = await search.webSearch("q");
  expect(response.provider).toBe("minimax");
  expect(response.attempts.map((row: any) => row.status)).toEqual([
    "auth_required",
    "success",
  ]);
  expect(JSON.stringify(response)).not.toContain("fixture-secret");
  await expect(search.webSearch("q", "glm")).rejects.toMatchObject({
    code: "auth_required",
  });
  expect(mini).toHaveBeenCalledTimes(1);
  await expect(
    search.webSearch("q", null, profiles[0].id),
  ).rejects.toMatchObject({ code: "auth_required" });
  expect(mini).toHaveBeenCalledTimes(1);
});
for (const changes of [
  { enabled: false },
  { search_enabled: false },
  { auth_type: "cookie" as const },
  { provider: "kimi" as const },
])
  it(`skips search accounts with ${JSON.stringify(changes)}`, async () => {
    const call = vi.fn(async () => ({ organic: [] })),
      { search } = await fresh(undefined, { glm: { search: call } }, [
        account({ search_enabled: true, ...changes }),
      ]);
    await expect(search.webSearch("q")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(call).not.toHaveBeenCalled();
  });
for (const [query, count, provider] of [
  ["", 10, null],
  [" ", 10, null],
  ["x".repeat(4001), 10, null],
  ["q", 0, null],
  ["q", 11, null],
  ["q", 1.5, null],
  ["q", 10, "other"],
] as const)
  it(`validates search arguments before any request ${query.length}/${count}/${provider}`, async () => {
    const call = vi.fn(async () => ({ organic: [] })),
      { search } = await fresh(undefined, { glm: { search: call } });
    await expect(
      search.webSearch(query, provider, null, count),
    ).rejects.toMatchObject({ code: "invalid_parameters" });
    expect(call).not.toHaveBeenCalled();
  });
for (const evidence of ["fresh", "stale", "reset-passed", "unknown"])
  it(`uses only fresh applicable quota evidence (${evidence})`, async () => {
    const call = vi.fn(async () => ({ organic: [] })),
      {
        search,
        store,
        profiles: [one],
      } = await fresh(undefined, { glm: { search: call } });
    store.saveSnapshot(
      SnapshotSchema.parse({
        account_id: one.id,
        status: "ok",
        last_success_at: addMillis(now(), evidence === "stale" ? -180000 : 0),
        data: {
          ...result(),
          metrics: [
            metric({
              id: "glm-0",
              label: "MCP 调用次数",
              unit: "次",
              remaining: evidence === "unknown" ? null : 0,
              limit: 100,
              resets_at: addMillis(
                now(),
                evidence === "reset-passed" ? -1000 : 3600000,
              ),
            }),
          ],
        },
      }),
    );
    if (evidence === "fresh") {
      await expect(search.webSearch("q")).rejects.toMatchObject({
        code: "quota_exhausted",
      });
      expect(call).not.toHaveBeenCalled();
    } else {
      await search.webSearch("q");
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
for (const code of ["rate_limited", "quota_exhausted"])
  it(`cools down search after ${code} without repeated billable attempts`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const call = vi.fn(async () => {
        throw new AdapterError(code, 90);
      }),
      { search } = await fresh(undefined, { glm: { search: call } });
    await expect(search.webSearch("q")).rejects.toMatchObject({ code });
    await expect(search.webSearch("q")).rejects.toMatchObject({ code });
    expect(call).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 90001);
    await expect(search.webSearch("q")).rejects.toMatchObject({ code });
    expect(call).toHaveBeenCalledTimes(2);
  });
it("serializes one account search and rechecks settings after a queued wait", async () => {
  const entered = gate(),
    released = gate(),
    call = vi.fn(async () => {
      entered.release();
      await released.promise;
      return { organic: [] };
    }),
    {
      search,
      store,
      profiles: [one],
    } = await fresh(undefined, { glm: { search: call } });
  const first = search.webSearch("q");
  await entered.promise;
  const second = search.webSearch("q");
  const rejected = expect(second).rejects.toMatchObject({
    code: "unavailable",
  });
  store.saveConfig({
    ...store.config,
    accounts: [{ ...one, search_enabled: false }],
  });
  released.release();
  await first;
  await rejected;
  expect(call).toHaveBeenCalledTimes(1);
});
it("caps global search concurrency at four and checks settings after both locks", async () => {
  const entered = gate(),
    released = gate();
  let active = 0,
    peak = 0;
  const profiles = Array.from({ length: 5 }, () =>
    account({ search_enabled: true }),
  );
  const call = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 4) entered.release();
      await released.promise;
      active--;
      return { organic: [] };
    }),
    { search, store } = await fresh(
      undefined,
      { glm: { search: call } },
      profiles,
    );
  const running = profiles
    .slice(0, 4)
    .map((row) => search.webSearch("q", null, row.id));
  await entered.promise;
  const last = search.webSearch("q", null, profiles[4].id);
  const rejection = expect(last).rejects.toMatchObject({ code: "unavailable" });
  store.saveConfig({
    ...store.config,
    accounts: profiles.map((row, i) =>
      i === 4 ? { ...row, enabled: false } : row,
    ),
  });
  released.release();
  await Promise.all(running);
  await rejection;
  expect(peak).toBe(4);
  expect(call).toHaveBeenCalledTimes(4);
});
it("uses the fixed MiniMax endpoint once with no retry and classifies documented business errors", async () => {
  const client = vi.fn<Fetcher>(
      async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 1004 } })),
    ),
    { search } = await fresh(
      undefined,
      {},
      [account({ provider: "minimax", search_enabled: true })],
      client,
    );
  await expect(search.webSearch("q")).rejects.toMatchObject({
    code: "auth_required",
  });
  expect(client).toHaveBeenCalledTimes(1);
  expect(client.mock.calls[0][0]).toBe(
    "https://api.minimax.cn/v1/coding_plan/search",
  );
  expect((client.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
});
it("aborts active search at shutdown without exposing transport errors or invoking a fallback", async () => {
  const entered = gate(),
    { search } = await fresh(undefined, {
      glm: {
        search: async () => {
          entered.release();
          return new Promise(() => {});
        },
      },
    });
  const pending = search.webSearch("q");
  const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
  await entered.promise;
  search.stop();
  await rejection;
});
it("retries streamed-body network failures once and never follows cross-origin redirects", async () => {
  const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("network reset"));
          },
        }),
      ),
    client = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(broken())
      .mockResolvedValueOnce(new Response('{"ok":true}'));
  expect(await requestJSON(client, "GET", "https://example.com")).toEqual({
    ok: true,
  });
  expect(client).toHaveBeenCalledTimes(2);
  expect(
    client.mock.calls.every(([, init]) => init!.redirect === "manual"),
  ).toBe(true);
  const redirect = vi.fn<Fetcher>().mockResolvedValue(
    new Response("", {
      status: 302,
      headers: { location: "https://evil.invalid" },
    }),
  );
  await expect(
    requestJSON(redirect, "GET", "https://example.com"),
  ).rejects.toMatchObject({ code: "upstream_error" });
  expect(redirect).toHaveBeenCalledTimes(1);
});
it("enforces the fifteen-second per-account search deadline without retrying that account", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    timeout(ms === 15000 ? 15 : ms),
  );
  const called = vi.fn(async () => new Promise(() => {})),
    { search } = await fresh(undefined, { glm: { search: called } });
  await expect(search.webSearch("q")).rejects.toMatchObject({
    code: "timeout",
  });
  expect(called).toHaveBeenCalledTimes(1);
});
it("stops all search fallbacks at the overall deadline", async () => {
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: any,
    ms?: number,
    ...args: any[]
  ) =>
    timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout);
  const called = vi.fn(async () => new Promise(() => {})),
    profiles = [
      account({ search_enabled: true }),
      account({ provider: "minimax", search_enabled: true }),
    ],
    { search } = await fresh(
      undefined,
      { glm: { search: called }, minimax: { search: called } },
      profiles,
    );
  await expect(search.webSearch("q")).rejects.toMatchObject({
    code: "timeout",
  });
  expect(called).toHaveBeenCalledTimes(1);
});
it("uses the official GLM MCP client and maps only the documented search tool and arguments", async () => {
  const requests: any[] = [];
  const client: Fetcher = async (url, init) => {
    expect(url).toBe("https://open.bigmodel.cn/api/mcp/web_search_prime/mcp");
    expect(init!.redirect).toBe("manual");
    if (init!.method === "GET") return new Response("", { status: 405 });
    const rpc = JSON.parse(String(init!.body));
    requests.push(rpc);
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let body: any;
    if (rpc.method === "initialize")
      body = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-glm", version: "1" },
      };
    if (rpc.method === "tools/list")
      body = {
        tools: [
          {
            name: "web_search_prime",
            inputSchema: {
              type: "object",
              properties: { search_query: { type: "string" } },
            },
          },
        ],
      };
    if (rpc.method === "tools/call")
      body = {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              JSON.stringify({
                search_result: [
                  {
                    title: "官方文档",
                    link: "https://example.com",
                    content: "结果",
                  },
                ],
              }),
            ),
          },
        ],
      };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: body }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const { search } = await fresh(undefined, {}, undefined, client);
  const response = await search.webSearch("搜索内容");
  expect(response.results[0].title).toBe("官方文档");
  expect(requests.find((row) => row.method === "tools/call").params).toEqual({
    name: "web_search_prime",
    arguments: { search_query: "搜索内容" },
  });
});
it("preserves GLM HTTP Retry-After through SDK transport errors and prevents immediate reuse", async () => {
  const client = vi.fn<Fetcher>(
      async () =>
        new Response("private supplier response", {
          status: 429,
          headers: { "retry-after": "45" },
        }),
    ),
    { search } = await fresh(undefined, {}, undefined, client);
  await expect(search.webSearch("q")).rejects.toMatchObject({
    code: "rate_limited",
  });
  await expect(search.webSearch("q")).rejects.toMatchObject({
    code: "rate_limited",
  });
  expect(client).toHaveBeenCalledTimes(1);
});
it("returns ordered histories for enabled accounts over a fixed 24-hour window without collection", async () => {
  const profiles = [
    account({ provider: "glm", order: 8, alias: "同名账号" }),
    account({ provider: "minimax", order: 2 }),
    account({ provider: "glm", order: 0, alias: "同名账号", enabled: false }),
  ];
  const { service, store, fake } = await fresh(undefined, {}, profiles);
  for (const row of profiles) store.appendHistory(row.id, result());
  const history = service.protocolHistories("glm");
  expect(history).toMatchObject({ version: 2, range: "24h", accountCount: 1 });
  expect(history.accounts.map((row: any) => row.id)).toEqual([profiles[0].id]);
  for (const row of history.accounts) {
    expect(row.points).toHaveLength(288);
    expect(row.points.some((point: any) => !point.isMissing)).toBe(true);
    expect(row).not.toHaveProperty("account");
  }
  expect(
    service.protocolHistories().accounts.map((row: any) => row.id),
  ).toEqual([profiles[1].id, profiles[0].id]);
  expect(service.protocolAccounts().map((row) => row.id)).toEqual([
    profiles[1].id,
    profiles[0].id,
  ]);
  expect(service.queryQuotas().accounts.map((row: any) => row.id)).toEqual([
    profiles[1].id,
    profiles[0].id,
  ]);
  expect(
    service.queryQuotas({ account_ids: [profiles[2].id] }).accounts,
  ).toEqual([]);
  expect(() => service.protocolHistory(profiles[2].id, "24h")).toThrow(
    "账号不存在",
  );
  expect(
    service.dashboard().accounts.find((row: any) => row.id === profiles[2].id),
  ).toMatchObject({ status: "disabled", enabled: false });
  expect(service.protocolHistories("kimi")).toEqual({
    version: 2,
    range: "24h",
    accountCount: 0,
    accounts: [],
  });
  expect(vi.mocked(fake.fetch)).not.toHaveBeenCalled();
});
for (const code of [
  "auth_required",
  "rate_limited",
  "quota_exhausted",
  "timeout",
  "network_error",
  "upstream_error",
  "invalid_response",
])
  it(`uses only the next ordered account within an explicitly selected channel after ${code}`, async () => {
    const profiles = [
        account({ provider: "glm", order: 7, search_enabled: true }),
        account({ provider: "minimax", order: 1, search_enabled: true }),
        account({ provider: "glm", order: 0, search_enabled: true }),
      ],
      seen: string[] = [];
    const stub = {
      search: async (key: string) => {
        seen.push(key);
        if (key.endsWith(profiles[2].id)) throw new AdapterError(code, 60);
        return { organic: [] };
      },
    };
    const { search } = await fresh(
      undefined,
      { glm: stub, minimax: stub },
      profiles,
    );
    const response = await search.webSearch("q", "glm");
    expect(response.account_id).toBe(profiles[0].id);
    expect(response.provider).toBe("glm");
    expect(seen).toEqual([
      "fixture-secret-" + profiles[2].id,
      "fixture-secret-" + profiles[0].id,
    ]);
    expect(response.attempts.map((row: any) => row.status)).toEqual([
      code,
      "success",
    ]);
  });
it("auto follows global account order across channels and observes administrator priority changes", async () => {
  const profiles = [
      account({ provider: "glm", order: 7, search_enabled: true }),
      account({ provider: "minimax", order: 1, search_enabled: true }),
      account({ provider: "glm", order: 0, search_enabled: true }),
      account({
        provider: "glm",
        order: -1,
        search_enabled: true,
        enabled: false,
      }),
      account({ provider: "glm", order: -2, search_enabled: false }),
    ],
    seen: string[] = [];
  const stub = {
    search: async (key: string) => {
      seen.push(key);
      if (key.endsWith(profiles[2].id)) throw new AdapterError("auth_required");
      return { organic: [] };
    },
  };
  const { search, store } = await fresh(
    undefined,
    { glm: stub, minimax: stub },
    profiles,
  );
  expect((await search.webSearch("q")).account_id).toBe(profiles[1].id);
  expect(seen).toEqual([
    "fixture-secret-" + profiles[2].id,
    "fixture-secret-" + profiles[1].id,
  ]);
  store.saveConfig({
    ...store.config,
    accounts: profiles.map((row, index) =>
      index === 0 ? { ...row, order: -3 } : row,
    ),
  });
  seen.length = 0;
  expect((await search.webSearch("q")).account_id).toBe(profiles[0].id);
  expect(seen).toEqual(["fixture-secret-" + profiles[0].id]);
});

it("reports the first failure or freshness deadline as the expiry time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const call = vi.fn(
    async () => [result(), null] as [ReturnType<typeof result>, null],
  );
  const {
    service,
    store,
    profiles: [one],
  } = await fresh({ fetch: call });
  await service.refresh(one.id);
  const success = store.getSnapshot(one.id).last_success_at!;
  vi.setSystemTime(Date.now() + 30_000);
  call.mockRejectedValue(new AdapterError("invalid_response"));
  await service.refresh(one.id);
  const firstFailure = now();
  expect(service.dashboard().accounts[0].stale_since).toBe(firstFailure);
  vi.setSystemTime(Date.now() + 30_000);
  await service.refresh(one.id);
  expect(service.dashboard().accounts[0].stale_since).toBe(firstFailure);
  call.mockImplementation(async () => [result(), null]);
  await service.refresh(one.id);
  expect(service.dashboard().accounts[0].stale_since).toBeNull();
  const nextSuccess = store.getSnapshot(one.id).last_success_at!;
  vi.setSystemTime(Date.now() + 120_001);
  expect(service.dashboard().accounts[0].stale_since).toBe(
    addMillis(nextSuccess, 120_000),
  );
  expect(success).not.toBe(firstFailure);
});

it("does not invent an expiry time for an older failed snapshot", async () => {
  const {
    service,
    store,
    profiles: [one],
  } = await fresh({
    fetch: async () => {
      throw new AdapterError("invalid_response");
    },
  });
  store.saveSnapshot(
    SnapshotSchema.parse({
      account_id: one.id,
      status: "error",
      data: result(),
      last_success_at: now(),
    }),
  );
  expect(service.dashboard().accounts[0].stale_since).toBeNull();
  await service.refresh(one.id);
  expect(service.dashboard().accounts[0].stale_since).toBeNull();
});
