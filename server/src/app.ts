import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import serveStatic from "@fastify/static";
import { hostHeaderValidation } from "@modelcontextprotocol/fastify";
import { z, ZodError } from "zod";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { Mutex } from "async-mutex";
import {
  PROVIDERS,
  VERIFIED_AUTH_METHODS,
  DEFAULT_PAGE_TITLE,
  ProviderIdSchema,
  AuthTypeSchema,
  StoredAccountSchema,
  type Credentials,
} from "@plan-quotas/shared";
import {
  loadSettings,
  validateCredentials,
  type Settings,
} from "./settings.js";
import { Store, StoreError } from "./storage.js";
import { QuotaService, SAFE_ERRORS } from "./service.js";
import { buildAdapters } from "./adapters/index.js";
import { AdapterError, type Adapter, type Fetcher } from "./adapters/base.js";
import {
  AdminAuth,
  ApiKeyAuth,
  HttpError,
  COOKIE_NAME,
  SESSION_TTL,
  hash,
  extractApiKey,
  INTERFACE_SECRET_HEADERS,
} from "./security.js";
import { SearchService, type SearchAdapter } from "./search.js";
import { mountMCP } from "./mcp.js";
import { now } from "./time.js";

const credentialSchema = z
  .record(z.string(), z.string())
  .refine((value) => Object.keys(value).length <= 16);
const accountFields = {
  provider: ProviderIdSchema,
  alias: z.string().min(1).max(80),
  auth_type: AuthTypeSchema,
  credentials: credentialSchema,
  enabled: z.boolean().default(true),
  search_enabled: z.boolean().default(false),
  order: z.number().int().min(-100000).max(100000).optional(),
};
const addSchema = z.strictObject(accountFields);
const patchSchema = z.strictObject({
  alias: accountFields.alias.nullable().optional(),
  auth_type: AuthTypeSchema.nullable().optional(),
  credentials: credentialSchema.nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  search_enabled: z.boolean().nullable().optional(),
  order: z.number().int().min(-100000).max(100000).nullable().optional(),
});
const testSchema = z.strictObject({
  provider: ProviderIdSchema,
  auth_type: AuthTypeSchema,
  credentials: credentialSchema.default({}),
  account_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .nullable()
    .optional(),
});
const settingsSchema = z.strictObject({
  interval_minutes: z
    .union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(5)])
    .nullable()
    .optional(),
  page_title: z.string().max(120).nullable().optional(),
});
const accessSchema = z.strictObject({ require_apikey: z.boolean() });
type Options = {
  settings?: Partial<Settings>;
  adapters?: Record<string, Adapter>;
  client?: Fetcher;
  poll?: boolean;
  searchAdapters?: Record<string, SearchAdapter>;
  log?: (record: { method: string; path: string; status: number }) => void;
};

/** Normalize route identifiers with the established UUID syntax and safe validation response. */
function accountId(request: FastifyRequest): string {
  const value = (request.params as Record<string, string>).account_id;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new HttpError(422, "请求参数无效，请检查字段和输入格式");
  return value.toLowerCase();
}
/** Render the saved browser title as text rather than executable markup. */
function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[char]!,
  );
}
/** Construct a compatible single-instance application with injectable collectors and transports. */
export function createApp(options: Options = {}) {
  const settings = loadSettings(options.settings),
    app = Fastify({
      logger: false,
      bodyLimit: 131072,
      trustProxy: false,
    });
  const store = new Store(settings.dataDir, () => {
      process.exitCode = 1;
      search.stop();
      void service.stop().finally(() => app.close());
    }),
    auth = new AdminAuth(settings.adminPassword),
    apiKeyAuth = new ApiKeyAuth();
  const client: Fetcher = options.client ?? ((url, init) => fetch(url, init)),
    adapters = options.adapters ?? buildAdapters(),
    service = new QuotaService(store, client, adapters),
    search = new SearchService(store, client, options.searchAdapters);
  const rotations = new Map<
    string,
    { expires: number; credentials: Credentials }
  >();
  const infoStates = new WeakMap<
    FastifyRequest,
    ReturnType<typeof extractApiKey>
  >();
  const credentialKey = (
    request: FastifyRequest,
    provider: string,
    authType: string,
    credentials: Credentials,
  ) =>
    hash(
      JSON.stringify([
        request.cookies[COOKIE_NAME],
        provider,
        authType,
        Object.fromEntries(
          Object.keys(credentials)
            .sort()
            .map((key) => [key, credentials[key]]),
        ),
      ]),
    ).toString("hex");
  /** Reuse a five-minute test rotation only for the same administrator and original input. */
  function resolved(
    request: FastifyRequest,
    provider: string,
    authType: string,
    credentials: Credentials,
  ): Credentials {
    for (const [key, row] of rotations)
      if (row.expires < Date.now()) rotations.delete(key);
    return (
      rotations.get(credentialKey(request, provider, authType, credentials))
        ?.credentials ?? credentials
    );
  }
  /** Retain a rotated credential internally so testing before saving never consumes a refresh token twice. */
  function remember(
    request: FastifyRequest,
    provider: string,
    authType: string,
    original: Credentials,
    rotated: Credentials | null | undefined,
  ): void {
    if (!rotated) return;
    if (rotations.size >= 100) rotations.delete(rotations.keys().next().value!);
    rotations.set(credentialKey(request, provider, authType, original), {
      expires: Date.now() + 300000,
      credentials: rotated,
    });
  }
  /** Return current configuration without exposing filesystem paths or authentication values. */
  function getSettings() {
    return {
      page_title: store.config.page_title,
      interval_minutes: store.config.interval_minutes,
    };
  }
  /** Resolve current membership before any account read or write. */
  function find(id: string) {
    const account = service.find(id);
    if (!account) throw new HttpError(404, "账号不存在");
    return account;
  }
  app.decorate("quota", { store, service, search, auth, settings });
  app.register(cookie);
  app.addHook("onRequest", async (request, reply) => {
    const extracted = extractApiKey(
      request.raw.url ?? request.url,
      request.raw.rawHeaders,
    );
    infoStates.set(request, extracted);
    if (extracted.protected) {
      request.raw.url = extracted.url;
      request.query = {};
      for (const header of INTERFACE_SECRET_HEADERS)
        delete request.headers[header];
      for (let i = request.raw.rawHeaders.length - 2; i >= 0; i -= 2)
        if (
          INTERFACE_SECRET_HEADERS.includes(
            request.raw.rawHeaders[i].toLowerCase(),
          )
        )
          request.raw.rawHeaders.splice(i, 2);
      reply.header("Cache-Control", "no-store");
    }
    reply.headers({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    const pathname = (request.raw.url ?? request.url).split("?")[0];
    if (pathname.startsWith("/api/") || pathname.startsWith("/mcp"))
      reply.header("Cache-Control", "no-store");
    let host: string;
    try {
      host = new URL(`http://${request.headers.host}`).hostname;
    } catch {
      throw new HttpError(400, "Invalid host header");
    }
    if (
      !settings.allowedHosts.some(
        (pattern) =>
          pattern === "*" ||
          host === pattern ||
          (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))),
      )
    )
      throw new HttpError(400, "Invalid host header");
    const expected =
        settings.publicOrigin.replace(/\/$/, "") ||
        `${request.protocol}://${request.headers.host}`,
      origin = request.headers.origin;
    if (origin && origin !== expected)
      throw new HttpError(403, "请求来源不受信任");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new HttpError(403, "请求来源不受信任");
    if (pathname.startsWith("/api/admin/") && pathname !== "/api/admin/login")
      auth.require(
        request.cookies[COOKIE_NAME] ?? "",
        String(request.headers["x-csrf-token"] ?? ""),
        !["GET", "HEAD", "OPTIONS"].includes(request.method),
      );
    if (extracted.protected) {
      if (extracted.invalid) throw new HttpError(401, "接口密钥参数无效");
      if (
        store.getAccessSettings().require_apikey &&
        !apiKeyAuth.verify(store.getApiKeys(), extracted.apikey, request.ip)
      )
        throw new HttpError(401, "无效或缺少接口密钥");
    }
  });
  const sdkHostCheck = hostHeaderValidation(settings.allowedHosts);
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.split("?")[0] === "/mcp" &&
      settings.allowedHosts.every((host) => !host.includes("*"))
    )
      await sdkHostCheck(request, reply);
  });
  app.addHook("onResponse", async (request, reply) => {
    options.log?.({
      method: request.method,
      path: (request.raw.url ?? request.url).split("?")[0],
      status: reply.statusCode,
    });
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ detail: error.detail });
    if (
      error instanceof ZodError ||
      error.validation ||
      ["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"].includes(
        error.code,
      )
    )
      return reply
        .code(422)
        .send({ detail: "请求参数无效，请检查字段和输入格式" });
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply.code(413).send({ detail: "请求内容过大" });
    if (error instanceof AdapterError) {
      const code = SAFE_ERRORS.has(error.code)
        ? error.code
        : "invalid_response";
      return reply
        .code(code === "invalid_credentials" ? 400 : 502)
        .send({ detail: code });
    }
    if (error instanceof StoreError)
      return reply
        .code(503)
        .send({ detail: "存储异常，请检查数据目录权限与备份" });
    return reply.code(500).send({ detail: "服务暂时无法处理请求" });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ detail: "Not Found" }),
  );
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/public/providers", async () => PROVIDERS);
  app.get("/api/public/settings", async () => ({
    page_title: store.config.page_title,
  }));
  app.get("/api/public/dashboard", async () => service.dashboard());
  for (const url of ["/info", "/info/"])
    app.get(url, async () => service.queryQuotas());
  app.get("/api/public/accounts/:account_id/history", async (request) => {
    const id = accountId(request);
    find(id);
    const range = z
      .enum(["24h", "7d", "30d"])
      .parse((request.query as any).range ?? "24h");
    return service.history(id, range);
  });
  app.post("/api/admin/login", async (request, reply) => {
    const body = z
        .strictObject({ password: z.string().min(1).max(4096) })
        .parse(request.body),
      [token, session] = auth.login(body.password, request.ip);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: settings.cookieSecure,
      sameSite: "strict",
      maxAge: SESSION_TTL,
      path: "/api/admin",
    });
    return {
      csrf_token: session.csrf,
      default_password: settings.adminPassword === "admin",
    };
  });
  app.get("/api/admin/session", async (request) => ({
    csrf_token: auth.require(request.cookies[COOKIE_NAME] ?? "", "", false)
      .csrf,
    default_password: settings.adminPassword === "admin",
  }));
  app.post("/api/admin/logout", async (request, reply) => {
    auth.logout(request.cookies[COOKIE_NAME] ?? "");
    reply.clearCookie(COOKIE_NAME, { path: "/api/admin" });
    return { ok: true };
  });
  app.get("/api/admin/accounts", async () =>
    service.ordered().map((account) => ({
      ...account,
      search_supported:
        ["glm", "minimax"].includes(account.provider) &&
        account.auth_type === "api_key",
      credential_configured:
        Object.keys(store.getCredentials(account.id)).length > 0,
      credential_keys: Object.keys(store.getCredentials(account.id)).sort(),
      verification: VERIFIED_AUTH_METHODS.has(
        `${account.provider}:${account.auth_type}`,
      )
        ? "verified"
        : "not_tested",
    })),
  );
  app.post("/api/admin/accounts", async (request, reply) => {
    const body = addSchema.parse(request.body);
    validateCredentials(body.provider, body.auth_type, body.credentials);
    if (!body.alias.trim()) throw new HttpError(422, "请输入账号别名");
    if (store.config.accounts.length >= 100)
      throw new HttpError(400, "当前实例最多支持 100 个账号");
    if (
      body.search_enabled &&
      (!["glm", "minimax"].includes(body.provider) ||
        body.auth_type !== "api_key")
    )
      throw new HttpError(422, "仅智谱和 MiniMax 套餐 API Key 账号支持搜索");
    const account = StoredAccountSchema.parse({
      ...body,
      order:
        body.order ??
        Math.min(
          100000,
          Math.max(-1, ...store.config.accounts.map((item) => item.order)) + 1,
        ),
      id: randomUUID(),
      created_at: now(),
    });
    await service.accountLock(account.id).runExclusive(async () => {
      store.setCredentials(
        account.id,
        resolved(request, body.provider, body.auth_type, body.credentials),
      );
      store.saveConfig({
        ...store.config,
        accounts: [...store.config.accounts, account],
      });
    });
    reply.code(201);
    return account;
  });
  app.patch("/api/admin/accounts/:account_id", async (request) => {
    const id = accountId(request),
      body = patchSchema.parse(request.body);
    return service.accountLock(id).runExclusive(async () => {
      const current = find(id),
        { credentials: provided, ...changes } = body;
      if (Object.values(changes).some((value) => value === null))
        throw new HttpError(422, "字段不能为 null");
      if (typeof changes.alias === "string" && !changes.alias.trim())
        throw new HttpError(422, "请输入账号别名");
      const updated = StoredAccountSchema.parse({ ...current, ...changes }),
        credentials = provided ?? store.getCredentials(id);
      validateCredentials(updated.provider, updated.auth_type, credentials);
      if (
        updated.search_enabled &&
        (!["glm", "minimax"].includes(updated.provider) ||
          updated.auth_type !== "api_key")
      ) {
        if (changes.search_enabled)
          throw new HttpError(422, "该认证方式不支持搜索");
        updated.search_enabled = false;
      }
      if (provided != null) {
        store.setCredentials(
          id,
          resolved(request, updated.provider, updated.auth_type, credentials),
        );
        service.resetAccount(id);
      }
      store.saveConfig({
        ...store.config,
        accounts: store.config.accounts.map((row) =>
          row.id === id ? updated : row,
        ),
      });
      return updated;
    });
  });
  app.delete("/api/admin/accounts/:account_id", async (request) => {
    const id = accountId(request);
    await service.accountLock(id).runExclusive(async () => {
      find(id);
      store.saveConfig({
        ...store.config,
        accounts: store.config.accounts.filter((row) => row.id !== id),
      });
      store.deleteAccountData(id);
    });
    return { ok: true };
  });
  app.post("/api/admin/test", async (request) => {
    const body = testSchema.parse(request.body),
      id = body.account_id?.toLowerCase();
    const lock = id ? service.accountLock(id) : new Mutex();
    return lock.runExclusive(async () => {
      let credentials = body.credentials;
      if (id) {
        const account = find(id);
        if (account.provider !== body.provider)
          throw new HttpError(400, "渠道与账号不匹配");
        if (!Object.keys(credentials).length)
          credentials = store.getCredentials(id);
      }
      validateCredentials(body.provider, body.auth_type, credentials);
      const original = credentials;
      credentials = resolved(request, body.provider, body.auth_type, original);
      return service.withCollection(async () => {
        let data,
          rotated: Credentials | null = null;
        try {
          [data, rotated] = await adapters[body.provider].fetch(
            credentials,
            body.auth_type,
            client,
          );
        } catch (error) {
          if (error instanceof AdapterError) {
            rotated = error.rotated_credentials ?? null;
            remember(request, body.provider, body.auth_type, original, rotated);
            if (
              rotated &&
              id &&
              JSON.stringify(store.getCredentials(id)) ===
                JSON.stringify(original)
            )
              store.setCredentials(id, rotated);
            throw error;
          }
          throw new AdapterError("invalid_response");
        }
        remember(request, body.provider, body.auth_type, original, rotated);
        if (
          rotated &&
          id &&
          JSON.stringify(store.getCredentials(id)) === JSON.stringify(original)
        )
          store.setCredentials(id, rotated);
        return {
          ok: true,
          data: QuotaService.sanitize(data, { ...credentials, ...rotated }),
        };
      });
    });
  });
  app.post("/api/admin/accounts/:account_id/refresh", async (request) => {
    const id = accountId(request);
    find(id);
    const result = await service.refresh(id, true);
    return { ok: result.status === "ok", status: result.status };
  });
  app.get("/api/admin/settings", async () => getSettings());
  app.patch("/api/admin/settings", async (request) => {
    const body = settingsSchema.parse(request.body),
      updates: any = {};
    if (body.interval_minutes != null)
      updates.interval_minutes = body.interval_minutes;
    if (body.page_title != null)
      updates.page_title = body.page_title.trim() || DEFAULT_PAGE_TITLE;
    store.saveConfig({ ...store.config, ...updates });
    return getSettings();
  });
  /** List only access mode and safe token metadata for the authenticated administrator. */
  app.get("/api/admin/access-settings", async () => store.getAccessSettings());
  /** Apply an explicitly saved mode without changing the active token set. */
  app.patch("/api/admin/access-settings", async (request) => {
    const body = accessSchema.parse(request.body);
    return store.setAccessMode(body.require_apikey);
  });
  /** Issue a bounded server-generated token without returning its plaintext in the creation response. */
  app.post("/api/admin/access-tokens", async (request, reply) => {
    z.strictObject({}).parse(request.body ?? {});
    const token = store.createAccessToken();
    reply.code(201);
    return token;
  });
  /** Reveal one existing token through a no-store, session- and CSRF-protected request. */
  app.post("/api/admin/access-tokens/:id/reveal", async (request) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    z.strictObject({}).parse(request.body ?? {});
    return { apikey: store.revealAccessToken(id) };
  });
  /** Revoke one token immediately while preserving the saved access mode. */
  app.delete("/api/admin/access-tokens/:id", async (request) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    store.deleteAccessToken(id);
    return { ok: true };
  });
  /** Serve only the fixed entry page; no data-directory or arbitrary-file fallback exists. */
  const frontend = async (_request: FastifyRequest, reply: FastifyReply) => {
    const file = path.resolve(settings.staticDir, "index.html");
    if (!fs.existsSync(file))
      return reply
        .code(503)
        .send({ detail: "前端尚未构建，请先运行 npm run build" });
    const html = fs
      .readFileSync(file, "utf8")
      .replace(
        /<title>[\s\S]*?<\/title>/i,
        `<title>${escapeHTML(store.config.page_title)}</title>`,
      );
    return reply.type("text/html; charset=utf-8").send(html);
  };
  for (const url of ["/", "/admin", "/admin/"]) app.get(url, frontend);
  const assets = path.resolve(settings.staticDir, "assets");
  if (fs.existsSync(assets))
    app.register(serveStatic, {
      root: assets,
      prefix: "/assets/",
      dotfiles: "deny",
      index: false,
    });
  mountMCP(app, service, search);
  app.addHook("onReady", async () => {
    await store.open();
    if (options.poll !== false) service.start();
  });
  app.addHook("onClose", async () => {
    search.stop();
    await service.stop();
    await store.close();
    rotations.clear();
  });
  return app as typeof app & {
    quota: {
      store: Store;
      service: QuotaService;
      search: SearchService;
      auth: AdminAuth;
      settings: Settings;
    };
  };
}
