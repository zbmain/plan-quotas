import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  metric,
  MCP_TOOLS,
  SnapshotSchema,
  DEFAULT_PAGE_TITLE,
} from "@plan-quotas/shared";
import { createApp } from "../src/app.js";
import { AdapterError, type Adapter } from "../src/adapters/base.js";
import { account, result, tempRoot } from "./helpers.js";
import { now } from "../src/time.js";
import type { SearchAdapter } from "../src/search.js";

const roots: string[] = [],
  apps: ReturnType<typeof createApp>[] = [];
/** Start an isolated application with no real credentials, supplier requests, or background polling. */
async function fresh(
  adapter?: Adapter,
  searchAdapters?: Record<string, SearchAdapter>,
) {
  const root = tempRoot();
  roots.push(root.root);
  const fake: Adapter = adapter ?? {
    fetch: vi.fn<Adapter["fetch"]>(async () => [
      result(70, "额度 fixture-private-key"),
      null,
    ]),
  };
  const records: unknown[] = [];
  const app = createApp({
    settings: {
      dataDir: root.data,
      staticDir: root.web,
      adminPassword: "fixture-admin",
      allowedHosts: ["testserver", "localhost", "127.0.0.1", "[::1]"],
    },
    adapters: { minimax: fake, glm: fake, codex: fake, opencode: fake },
    poll: false,
    searchAdapters,
    log: (row) => records.push(row),
  });
  apps.push(app);
  await app.ready();
  /** Make in-process requests with the same Host and optional administrator session as a browser. */
  const request = (
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: method as any,
      url,
      headers: { host: "testserver", ...headers },
      ...(payload !== undefined ? { payload: payload as any } : {}),
    });
  /** Authenticate and retain both the scoped cookie and synchronizer token. */
  async function login() {
    const response = await request("POST", "/api/admin/login", {
      password: "fixture-admin",
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"]).split(";")[0],
      "x-csrf-token": response.json().csrf_token,
      origin: "http://testserver",
    };
  }
  /** Save one synthetic API Key account through the real administrator boundary. */
  async function add(headers: Record<string, string>, changes = {}) {
    const response = await request(
      "POST",
      "/api/admin/accounts",
      {
        provider: "minimax",
        alias: "工作账号",
        auth_type: "api_key",
        credentials: { api_key: "fixture-private-key" },
        ...changes,
      },
      headers,
    );
    expect(response.statusCode).toBe(201);
    return response.json();
  }
  /** Request a synthetic key through the same protected routes as the administrator UI. */
  async function createToken(headers: Record<string, string>) {
    const created = await request(
      "POST",
      "/api/admin/access-tokens",
      {},
      headers,
    );
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const revealed = await request(
      "POST",
      "/api/admin/access-tokens/" + id + "/reveal",
      {},
      headers,
    );
    expect(revealed.statusCode).toBe(200);
    return { id, apikey: revealed.json().apikey as string };
  }
  return { app, fake, records, request, login, add, createToken, ...root };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

for (const [method, url] of [
  ["GET", "/api/admin/session"],
  ["GET", "/api/admin/accounts"],
  ["PATCH", "/api/admin/settings"],
  ["POST", "/api/admin/mcp-token"],
  ["DELETE", "/api/admin/accounts/missing"],
])
  it(`denies anonymous administrator ${method} ${url}`, async () => {
    const { request } = await fresh();
    expect(
      (await request(method, url, method === "GET" ? undefined : {}))
        .statusCode,
    ).toBe(401);
  });
it("uses scoped HttpOnly sessions, rejects CSRF and foreign origins, and revokes logout", async () => {
  const { request, login } = await fresh(),
    headers = await login();
  const response = await request("POST", "/api/admin/login", {
    password: "fixture-admin",
  });
  expect(response.headers["set-cookie"]).toMatch(
    /Path=\/api\/admin; HttpOnly; SameSite=Strict/i,
  );
  expect(
    (
      await request(
        "PATCH",
        "/api/admin/settings",
        { interval_minutes: 0.5 },
        { cookie: headers.cookie },
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await request(
        "PATCH",
        "/api/admin/settings",
        {},
        { ...headers, origin: "https://evil.invalid" },
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (await request("POST", "/api/admin/logout", {}, headers)).statusCode,
  ).toBe(200);
  expect(
    (await request("GET", "/api/admin/session", undefined, headers)).statusCode,
  ).toBe(401);
});
for (const interval of [0.5, 1, 2, 5])
  it(`persists the supported ${interval} minute collection interval`, async () => {
    const { request, login } = await fresh(),
      headers = await login();
    const changed = await request(
      "PATCH",
      "/api/admin/settings",
      { interval_minutes: interval },
      headers,
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json().interval_minutes).toBe(interval);
  });
for (const interval of [0, 3, 10, 60, "1"])
  it(`rejects unsupported interval ${interval}`, async () => {
    const { request, login } = await fresh();
    expect(
      (
        await request(
          "PATCH",
          "/api/admin/settings",
          { interval_minutes: interval },
          await login(),
        )
      ).statusCode,
    ).toBe(422);
  });
for (const title of [
  "  我的 AI 用量  ",
  "<img src=x onerror=alert(1)>",
  'A & B "标题"',
  "  ",
])
  it(`escapes and persists page titles ${JSON.stringify(title)}`, async () => {
    const { app, request, login } = await fresh();
    const response = await request(
      "PATCH",
      "/api/admin/settings",
      { page_title: title },
      await login(),
    );
    expect(response.json().page_title).toBe(title.trim() || DEFAULT_PAGE_TITLE);
    for (const url of ["/", "/admin", "/admin/"]) {
      const page = await request("GET", url);
      expect(page.statusCode).toBe(200);
      if (title.includes("<img")) expect(page.body).toContain("&lt;img");
      expect(page.body).not.toContain("<img src=x");
    }
    expect(app.quota.store.config.page_title).toBe(
      title.trim() || DEFAULT_PAGE_TITLE,
    );
  });
it("retains account metadata and masks credentials across CRUD, cached quotas and history", async () => {
  const { app, request, login, add, fake, data } = await fresh(),
    headers = await login(),
    created = await add(headers);
  expect(created).not.toHaveProperty("credentials");
  const metadata = (
    await request("GET", "/api/admin/accounts", undefined, headers)
  ).json()[0];
  expect(metadata.credential_keys).toEqual(["api_key"]);
  expect(metadata.credential_configured).toBe(true);
  expect(
    (
      await request(
        "POST",
        `/api/admin/accounts/${created.id}/refresh`,
        {},
        headers,
      )
    ).json().status,
  ).toBe("ok");
  const before = vi.mocked(fake.fetch).mock.calls.length;
  const info = await request("GET", "/info");
  expect(info.statusCode).toBe(200);
  expect(info.json().accountCount).toBe(1);
  expect(info.json()).not.toHaveProperty("summary");
  expect(Object.keys(info.json()).sort()).toEqual([
    "accountCount",
    "accounts",
    "errors",
    "healthy",
    "low",
    "refreshIntervalSeconds",
    "updatedAt",
    "version",
  ]);
  expect(info.json().accounts[0].channel).toBe("minimax");
  expect(info.json().accounts[0]).not.toHaveProperty("provider");
  expect(info.body).not.toContain("fixture-private-key");
  expect(info.body).not.toContain("channelName");
  expect(info.body).not.toContain('"list"');
  await request("GET", "/api/public/dashboard");
  await request("GET", `/api/public/accounts/${created.id}/history?range=7d`);
  expect(vi.mocked(fake.fetch).mock.calls.length).toBe(before);
  expect(fs.readFileSync(path.join(data, "secrets.enc"), "utf8")).not.toContain(
    "fixture-private-key",
  );
  await request(
    "PATCH",
    `/api/admin/accounts/${created.id}`,
    { alias: "备用账号", enabled: false, order: 8 },
    headers,
  );
  expect(app.quota.store.getCredentials(created.id)).toEqual({
    api_key: "fixture-private-key",
  });
  expect((await request("GET", "/info")).json().accounts[0].status).toBe(
    "disabled",
  );
  await request(
    "DELETE",
    `/api/admin/accounts/${created.id}`,
    undefined,
    headers,
  );
  expect((await request("GET", "/info")).json().accounts).toEqual([]);
  expect(app.quota.store.getCredentials(created.id)).toEqual({});
});
it("validates credential fields and connection failures without leaking raw supplier text", async () => {
  const secret = "fixture-private-key",
    { request, login } = await fresh({
      fetch: async () => {
        throw new Error(`unsafe upstream ${secret}`);
      },
    }),
    headers = await login();
  for (const credentials of [
    { api_key: secret, unexpected: "private" },
    { api_key: "a\nb" },
    {},
  ]) {
    const response = await request(
      "POST",
      "/api/admin/test",
      { provider: "minimax", auth_type: "api_key", credentials },
      headers,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
  }
  const failed = await request(
    "POST",
    "/api/admin/test",
    {
      provider: "minimax",
      auth_type: "api_key",
      credentials: { api_key: secret },
    },
    headers,
  );
  expect(failed.statusCode).toBe(502);
  expect(failed.json()).toEqual({ detail: "invalid_response" });
});
it("keeps safe subscription-unavailable errors in cached channel status", async () => {
  const { request, login, add } = await fresh({
      fetch: async () => {
        throw new AdapterError("subscription_unavailable");
      },
    }),
    headers = await login(),
    created = await add(headers, { provider: "opencode" });
  expect(
    (
      await request(
        "POST",
        `/api/admin/accounts/${created.id}/refresh`,
        {},
        headers,
      )
    ).json().status,
  ).toBe("error");
  const row = (await request("GET", "/info")).json().accounts[0];
  expect(row.channel).toBe("opencode");
  expect(row.token).toEqual([]);
  expect(row.tools).toEqual([]);
});
it("reuses OAuth connection-test rotation when saving the original credential bundle", async () => {
  const seen: unknown[] = [];
  const { request, login, app } = await fresh({
      fetch: async (credentials) => {
        seen.push(credentials);
        return [
          result(),
          {
            ...credentials,
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
          },
        ];
      },
    }),
    headers = await login(),
    credentials = {
      access_token: "expired-access",
      refresh_token: "original-refresh",
    };
  const tested = await request(
    "POST",
    "/api/admin/test",
    { provider: "codex", auth_type: "oauth", credentials },
    headers,
  );
  expect(tested.statusCode).toBe(200);
  expect(tested.body).not.toContain("rotated-access");
  const created = await request(
    "POST",
    "/api/admin/accounts",
    { provider: "codex", alias: "OAuth", auth_type: "oauth", credentials },
    headers,
  );
  expect(created.statusCode).toBe(201);
  expect(app.quota.store.getCredentials(created.json().id)).toMatchObject({
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
  });
  expect(seen).toHaveLength(1);
});
for (const url of [
  "/data/master.key",
  "/master.key",
  "/secrets.enc",
  "/.env",
  "/assets/../master.key",
  "/assets/%2e%2e/config.json",
  "/assets/third-party/../../secrets.enc",
])
  it(`cannot expose private files at ${url}`, async () => {
    const { request } = await fresh();
    const response = await request("GET", url);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("nonce");
  });
it("enforces Host, browser Origin, request size and safe validation boundaries", async () => {
  const { request, login } = await fresh();
  expect(
    (await request("GET", "/healthz", undefined, { host: "evil.invalid" }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await request("GET", "/api/public/dashboard", undefined, {
        origin: "https://evil.invalid",
      })
    ).statusCode,
  ).toBe(403);
  const headers = await login();
  expect(
    (
      await request(
        "POST",
        "/api/admin/test",
        { large: "x".repeat(150000) },
        headers,
      )
    ).statusCode,
  ).toBe(413);
  const bad = await request(
    "POST",
    "/api/admin/accounts",
    { credentials: { api_key: "must-not-echo" } },
    headers,
  );
  expect(bad.statusCode).toBe(422);
  expect(bad.body).not.toContain("must-not-echo");
  expect((await request("GET", "/assets/test.js")).statusCode).toBe(200);
});
it("shares key protection across info and MCP with immediate revocation and redacted logs", async () => {
  const { request, login, records, createToken } = await fresh(),
    headers = await login();
  expect(
    (
      await request(
        "PATCH",
        "/api/admin/access-settings",
        { require_apikey: true },
        headers,
      )
    ).statusCode,
  ).toBe(400);
  const first = await createToken(headers),
    second = await createToken(headers);
  expect(
    (
      await request(
        "PATCH",
        "/api/admin/access-settings",
        { require_apikey: true },
        headers,
      )
    ).statusCode,
  ).toBe(200);
  expect((await request("GET", "/info")).statusCode).toBe(401);
  for (const route of ["/info", "/info/", "/mcp", "/mcp/"]) {
    const byQuery = await request(
      "GET",
      route + "?apikey=" + first.apikey + "&private=hidden",
    );
    expect(byQuery.statusCode).not.toBe(401);
    const byHeader = await request("GET", route, undefined, {
      ApiKey: second.apikey,
    });
    expect(byHeader.statusCode).not.toBe(401);
    expect(byHeader.raw.req.headers).not.toHaveProperty("apikey");
    expect(JSON.stringify(byHeader.raw.req.rawHeaders)).not.toContain(
      second.apikey,
    );
  }
  const both = await request("GET", "/info?apikey=" + first.apikey, undefined, {
    apikey: first.apikey,
    password: "retired-secret",
    "X-API-Password": "retired-secret",
  });
  expect(both.statusCode).toBe(200);
  expect(both.raw.req.url).toBe("/info");
  for (const name of ["apikey", "password", "x-api-password"])
    expect(both.raw.req.headers).not.toHaveProperty(name);
  expect(JSON.stringify(both.raw.req.rawHeaders)).not.toMatch(
    /sk-|retired-secret/,
  );
  expect(
    (
      await request("GET", "/info?apikey=" + first.apikey, undefined, {
        apikey: second.apikey,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await request(
        "GET",
        "/info?apikey=" + first.apikey + "&apikey=" + first.apikey,
      )
    ).statusCode,
  ).toBe(401);
  const rejected = await request(
    "GET",
    "/info?apikey=" + first.apikey,
    undefined,
    { apikey: first.apikey, origin: "https://untrusted.example" },
  );
  expect(rejected.statusCode).toBe(403);
  expect(rejected.raw.req.url).toBe("/info");
  expect(rejected.raw.req.headers).not.toHaveProperty("apikey");
  await request(
    "DELETE",
    "/api/admin/access-tokens/" + first.id,
    undefined,
    headers,
  );
  expect(
    (await request("GET", "/info", undefined, { apikey: first.apikey }))
      .statusCode,
  ).toBe(401);
  expect(
    (await request("GET", "/info", undefined, { apikey: second.apikey }))
      .statusCode,
  ).toBe(200);
  for (const legacy of [
    { password: second.apikey },
    { "X-API-Password": second.apikey },
    { authorization: "Bearer " + second.apikey },
  ] as Record<string, string>[]) {
    expect((await request("GET", "/info", undefined, legacy)).statusCode).toBe(
      401,
    );
  }
  expect(
    (await request("GET", "/info?password=" + second.apikey)).statusCode,
  ).toBe(401);
  await request(
    "PATCH",
    "/api/admin/access-settings",
    { require_apikey: false },
    headers,
  );
  expect((await request("GET", "/info")).statusCode).toBe(200);
  expect(JSON.stringify(records)).not.toMatch(
    /sk-|apikey|password|hidden|retired-secret/,
  );
});
it("protects metadata, generation, reveal and revocation with administrator sessions and CSRF", async () => {
  const { request, login, createToken } = await fresh(),
    headers = await login(),
    token = await createToken(headers);
  const cases: [string, string, unknown?][] = [
    ["GET", "/api/admin/access-settings"],
    ["PATCH", "/api/admin/access-settings", { require_apikey: false }],
    ["POST", "/api/admin/access-tokens", {}],
    ["POST", "/api/admin/access-tokens/" + token.id + "/reveal", {}],
    ["DELETE", "/api/admin/access-tokens/" + token.id],
  ];
  for (const [method, route, body] of cases) {
    expect(
      (await request(method, route, body, { apikey: token.apikey })).statusCode,
    ).toBe(401);
    if (method !== "GET")
      expect(
        (await request(method, route, body, { cookie: headers.cookie }))
          .statusCode,
      ).toBe(403);
  }
  const listed = await request(
    "GET",
    "/api/admin/access-settings",
    undefined,
    headers,
  );
  expect(listed.body).not.toContain(token.apikey);
  expect(listed.headers["cache-control"]).toBe("no-store");
  const reveal = await request(
    "POST",
    "/api/admin/access-tokens/" + token.id + "/reveal",
    {},
    headers,
  );
  expect(reveal.headers["cache-control"]).toBe("no-store");
  expect(
    (await request("GET", "/api/admin/info-settings", undefined, headers))
      .statusCode,
  ).toBe(404);
});
it("enforces the five-token cap under concurrent requests and keeps last-key revocation protected", async () => {
  const { request, login } = await fresh(),
    headers = await login();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request("POST", "/api/admin/access-tokens", {}, headers),
    ),
  );
  expect(responses.filter((row) => row.statusCode === 201)).toHaveLength(5);
  expect(responses.filter((row) => row.statusCode === 409)).toHaveLength(3);
  const tokens = responses
    .filter((row) => row.statusCode === 201)
    .map((row) => row.json());
  await request(
    "PATCH",
    "/api/admin/access-settings",
    { require_apikey: true },
    headers,
  );
  for (const token of tokens)
    await request(
      "DELETE",
      "/api/admin/access-tokens/" + token.id,
      undefined,
      headers,
    );
  expect(
    (
      await request("GET", "/api/admin/access-settings", undefined, headers)
    ).json(),
  ).toMatchObject({ require_apikey: true, tokens: [] });
  expect((await request("GET", "/info")).statusCode).toBe(401);
});
it("persists API keys across restart while invalidating administrator sessions", async () => {
  const { app, request, login, createToken, data, web } = await fresh(),
    headers = await login(),
    token = await createToken(headers);
  await request(
    "PATCH",
    "/api/admin/access-settings",
    { require_apikey: true },
    headers,
  );
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const next = createApp({
    settings: { dataDir: data, staticDir: web, allowedHosts: ["testserver"] },
    poll: false,
  });
  apps.push(next);
  await next.ready();
  expect(
    (
      await next.inject({
        url: "/info?apikey=" + token.apikey,
        headers: { host: "testserver" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await next.inject({
        url: "/api/admin/session",
        headers: { host: "testserver", cookie: headers.cookie },
      })
    ).statusCode,
  ).toBe(401);
});
it("discovers and calls all five tools with the official TypeScript MCP client and existing protocol", async () => {
  const { app, request, login, createToken } = await fresh(),
    headers = await login();
  const one = account({ provider: "glm", alias: "主账号" });
  app.quota.store.saveConfig({ ...app.quota.store.config, accounts: [one] });
  app.quota.store.setCredentials(one.id, { api_key: "fixture-private-key" });
  app.quota.store.saveSnapshot(
    SnapshotSchema.parse({
      account_id: one.id,
      status: "ok",
      data: {
        ...result(),
        metrics: [
          metric({
            id: "q",
            label: "短周期",
            window: "5 小时",
            used_percent: 30,
          }),
        ],
      },
      last_success_at: now(),
    }),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  /** Exercise real HTTP initialization, published forms, cached queries and actionable errors. */
  async function session(
    apikey?: string,
    query = false,
    headerName = "apikey",
  ) {
    const client = new Client({ name: "migration-test", version: "1" });
    const url = new URL(address + "/mcp");
    if (query && apikey) url.searchParams.set("apikey", apikey);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: apikey && !query ? { [headerName]: apikey } : {},
      },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toEqual(MCP_TOOLS);
      const listed = await client.callTool({
        name: "list_accounts",
        arguments: { channel: "glm" },
      });
      expect((listed.structuredContent as any).result[0].channel).toBe("glm");
      for (const name of ["get_token_quota", "get_tool_quota"]) {
        const response = await client.callTool({
          name,
          arguments: { channel: "glm" },
        });
        expect(response.isError).toBe(false);
        expect(response.structuredContent).not.toHaveProperty("summary");
        expect(response.structuredContent).toMatchObject({
          accountCount: 1,
          healthy: 1,
          low: 0,
          errors: 0,
        });
      }
      const history = await client.callTool({
        name: "get_history",
        arguments: { channel: "glm" },
      });
      expect(history.isError).toBe(false);
      expect(history.structuredContent).toMatchObject({
        range: "24h",
        accountCount: 1,
        accounts: [{ id: one.id, channel: "glm" }],
      });
      expect(
        (history.structuredContent as any).accounts[0].points,
      ).toHaveLength(288);
      const invalid = await client.callTool({
        name: "web_search",
        arguments: { query: " " },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("搜索内容");
      const legacy = await client.callTool({
        name: "get_token_quota",
        arguments: { provider: "glm" },
      });
      expect(JSON.stringify(legacy)).toContain("参数已更新");
    } finally {
      await client.close();
    }
  }
  await session();
  const token = await createToken(headers);
  await request(
    "PATCH",
    "/api/admin/access-settings",
    { require_apikey: true },
    headers,
  );
  await session(token.apikey);
  await session(token.apikey, false, "APIKEY");
  await session(token.apikey, true);
  const initialized = await fetch(address + "/mcp?apikey=" + token.apikey, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "existing-client", version: "1" },
      },
    }),
  });
  expect(initialized.status).toBe(200);
  expect(((await initialized.json()) as any).result.protocolVersion).toBe(
    "2025-06-18",
  );
  await request(
    "DELETE",
    "/api/admin/access-tokens/" + token.id,
    undefined,
    headers,
  );
  const replacement = await createToken(headers);
  const denied = await fetch(address + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      apikey: token.apikey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(denied.status).toBe(401);
  await session(replacement.apikey);
});
it("routes MCP search by channel and global priority while rejecting removed parameters before billing", async () => {
  const seen: string[] = [];
  let primaryId = "";
  const stub: SearchAdapter = {
    search: async (key) => {
      seen.push(key);
      if (key.endsWith(primaryId)) throw new AdapterError("auth_required");
      return { organic: [] };
    },
  };
  const { app } = await fresh(undefined, { glm: stub, minimax: stub });
  const profiles = [
    account({ provider: "glm", order: 7, search_enabled: true }),
    account({ provider: "minimax", order: 1, search_enabled: true }),
    account({ provider: "glm", order: 0, search_enabled: true }),
  ];
  primaryId = profiles[2].id;
  app.quota.store.saveConfig({ ...app.quota.store.config, accounts: profiles });
  for (const row of profiles)
    app.quota.store.setCredentials(row.id, {
      api_key: "fixture-secret-" + row.id,
    });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "simple-mcp-search-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address + "/mcp")),
  );
  try {
    for (const [name, args] of [
      ["get_token_quota", { channel: "glm", period: "5h" }],
      ["get_tool_quota", { channel: "glm", tool: "mcp" }],
      ["get_history", { channel: "glm", time_range: "24h" }],
      ["list_accounts", { channel: "glm", status: "all" }],
      ["web_search", { query: "q", channel: "glm", account: profiles[0].id }],
      ["web_search", { query: "q", max_results: 10 }],
    ] as const) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("参数已更新");
    }
    expect(seen).toEqual([]);
    const selected = await client.callTool({
      name: "web_search",
      arguments: { query: "q", channel: "glm" },
    });
    expect(selected.isError).toBe(false);
    expect(selected.structuredContent).toMatchObject({
      provider: "glm",
      account_id: profiles[0].id,
    });
    expect(seen).toEqual([
      "fixture-secret-" + profiles[2].id,
      "fixture-secret-" + profiles[0].id,
    ]);
    seen.length = 0;
    const automatic = await client.callTool({
      name: "web_search",
      arguments: { query: "q" },
    });
    expect(automatic.isError).toBe(false);
    expect(automatic.structuredContent).toMatchObject({
      provider: "minimax",
      account_id: profiles[1].id,
    });
    expect(seen).toEqual([
      "fixture-secret-" + profiles[2].id,
      "fixture-secret-" + profiles[1].id,
    ]);
    const quota = await client.callTool({
      name: "get_token_quota",
      arguments: { channel: "glm" },
    });
    expect(quota.structuredContent).toMatchObject({ accountCount: 2 });
    expect(
      (quota.structuredContent as any).accounts.map((row: any) => row.id),
    ).toEqual([profiles[2].id, profiles[0].id]);
  } finally {
    await client.close();
  }
});
