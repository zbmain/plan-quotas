import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
import {
  ConfigSchema,
  SnapshotSchema,
  metric,
  usage,
} from "@plan-quotas/shared";
import {
  Store,
  decryptCredentials,
  encryptCredentials,
} from "../src/storage.js";
import {
  ApiKeyAuth,
  AdminAuth,
  extractApiKey,
  COOKIE_NAME,
} from "../src/security.js";
import { loadSettings } from "../src/settings.js";
import { tempRoot, result, account } from "./helpers.js";
import { now, addMillis, utc, compare } from "../src/time.js";
const crypto = JSON.parse(
  fs.readFileSync(new URL("./fixtures/crypto.json", import.meta.url), "utf8"),
);
const roots: string[] = [],
  stores: Store[] = [];

/** Open a fresh store and register cleanup so failed assertions cannot retain a file lease. */
async function fresh() {
  const root = tempRoot();
  roots.push(root.root);
  const store = new Store(root.data);
  stores.push(store);
  await store.open();
  return { store, ...root };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
it("decrypts the previous runtime's exact synthetic AES-GCM vector and writes the same bytes", () => {
  const key = Buffer.from(crypto.key, "hex"),
    envelope = Buffer.from(JSON.stringify(crypto.envelope));
  expect(decryptCredentials(key, envelope)).toEqual(crypto.plaintext);
  expect(
    JSON.parse(
      encryptCredentials(
        key,
        crypto.plaintext,
        Buffer.from(crypto.envelope.nonce, "hex"),
      ).toString(),
    ),
  ).toEqual(crypto.envelope);
});
it("keeps directory/key private and rejects another live instance", async () => {
  const { store, data } = await fresh();
  expect(fs.statSync(data).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(data, "master.key")).mode & 0o777).toBe(0o600);
  const other = new Store(data);
  await expect(other.open()).rejects.toThrow("already in use");
  await store.close();
  await other.open();
  await other.close();
});
it("recovers the immediately previous atomic configuration after corruption", async () => {
  const { store, data } = await fresh();
  store.saveConfig(ConfigSchema.parse({ interval_minutes: 7 }));
  store.saveConfig(ConfigSchema.parse({ interval_minutes: 9 }));
  await store.close();
  fs.writeFileSync(path.join(data, "config.json"), "broken");
  await store.open();
  expect(store.config.interval_minutes).toBe(7);
});
it("recovers a missing config from its backup and retires obsolete token fields", async () => {
  const { store, data } = await fresh();
  store.saveConfig(
    ConfigSchema.parse({ interval_minutes: 2, mcp_token_hash: "retired" }),
  );
  store.saveConfig({ ...store.config, interval_minutes: 5 });
  await store.close();
  fs.unlinkSync(path.join(data, "config.json"));
  await store.open();
  expect(store.config.interval_minutes).toBe(2);
  expect(fs.readFileSync(path.join(data, "config.json"), "utf8")).not.toContain(
    "retired",
  );
});
it("never regenerates the key when encrypted data survives", async () => {
  const { store, data } = await fresh();
  store.setCredentials(randomUUID(), { api_key: "fixture-secret" });
  await store.close();
  fs.unlinkSync(path.join(data, "master.key"));
  await expect(store.open()).rejects.toThrow("master.key is missing");
  expect(fs.existsSync(path.join(data, "master.key"))).toBe(false);
});
it("also refuses a missing key when only the encrypted backup survives", async () => {
  const { store, data } = await fresh();
  const id = randomUUID();
  store.setCredentials(id, { api_key: "one" });
  store.setCredentials(id, { api_key: "two" });
  await store.close();
  fs.unlinkSync(path.join(data, "master.key"));
  fs.unlinkSync(path.join(data, "secrets.enc"));
  await expect(store.open()).rejects.toThrow("master.key is missing");
});
it("recovers authenticated credentials from a corrupt primary envelope", async () => {
  const { store, data } = await fresh();
  const id = randomUUID();
  store.setCredentials(id, { api_key: "first-secret" });
  store.setCredentials(id, { api_key: "second-secret" });
  fs.writeFileSync(path.join(data, "secrets.enc"), "broken");
  expect(store.getCredentials(id)).toEqual({ api_key: "first-secret" });
  expect(fs.readFileSync(path.join(data, "secrets.enc"), "utf8")).not.toContain(
    "first-secret",
  );
});
it("rejects a truncated or incorrect master key", async () => {
  const { store, data } = await fresh();
  await store.close();
  fs.writeFileSync(path.join(data, "master.key"), "short");
  await expect(store.open()).rejects.toThrow("invalid length");
});
for (const id of [
  "../../outside",
  "../x",
  "not-uuid",
  "0000",
  "a/b",
  "%2e%2e",
  "",
]) {
  it(`rejects unsafe account path ${JSON.stringify(id)}`, async () => {
    const { store } = await fresh();
    expect(() => store.getCredentials(id)).toThrow("UUID");
    expect(() => store.getSnapshot(id)).toThrow("UUID");
  });
}
for (const target of ["master.key", "config.json", "secrets.enc", "accounts"]) {
  it(`rejects a symlink at ${target}`, async () => {
    const { store, data, root } = await fresh();
    const outside = path.join(root, "outside");
    if (target === "accounts") fs.mkdirSync(outside);
    else fs.writeFileSync(outside, "{}");
    if (target === "master.key") {
      await store.close();
      fs.unlinkSync(path.join(data, target));
      fs.symlinkSync(outside, path.join(data, target));
      await expect(store.open()).rejects.toThrow();
    } else if (target === "config.json") {
      await store.close();
      fs.unlinkSync(path.join(data, target));
      fs.symlinkSync(outside, path.join(data, target));
      await expect(store.open()).rejects.toThrow();
    } else {
      fs.symlinkSync(outside, path.join(data, target));
      if (target === "accounts")
        expect(() => store.getSnapshot(randomUUID())).toThrow();
      else expect(() => store.getCredentials(randomUUID())).toThrow();
    }
  });
}
it("repairs a torn history tail and preserves gap/reset markers", async () => {
  const { store, data } = await fresh(),
    id = randomUUID(),
    first = { ...result(2), fetched_at: addMillis(now(), -600000) },
    second = { ...result(9), fetched_at: addMillis(now(), -300000) };
  store.appendHistory(id, first);
  const file = path.join(
    data,
    "accounts",
    id,
    "history",
    now().slice(0, 10) + ".jsonl",
  );
  fs.appendFileSync(file, '{"partial":');
  store.appendHistory(id, second);
  expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  const history = store.history(id, "24h");
  expect(history.points).toHaveLength(288);
  expect(history.points.some((point: any) => point.gap)).toBe(true);
  expect(history.points.some((point: any) => point.reset)).toBe(true);
});
for (const [range, size] of [
  ["24h", 288],
  ["7d", 168],
  ["30d", 120],
] as const) {
  it(`keeps explicit missing buckets for ${range}`, async () => {
    const { store } = await fresh();
    expect(store.history(randomUUID(), range).points).toHaveLength(size);
  });
}
it("ignores invalid complete history rows and an incomplete last row", async () => {
  const { store, data } = await fresh(),
    id = randomUUID();
  store.appendHistory(id, result());
  const file = path.join(
    data,
    "accounts",
    id,
    "history",
    now().slice(0, 10) + ".jsonl",
  );
  fs.appendFileSync(file, 'bad\n{"unfinished":');
  expect(
    store.history(id, "24h").points.filter((point: any) => !point.gap),
  ).toHaveLength(1);
});
for (const [offset, expected] of [
  [30000, false],
  [300000, false],
  [900000, true],
] as const) {
  it(`detects reset boundary only after it has passed (${offset})`, () => {
    const stamp = now(),
      reset = addMillis(stamp, 600000),
      old = usage(
        {
          source: "test",
          metrics: [
            metric({ id: "q", label: "q", used: 10, resets_at: reset }),
          ],
        },
        stamp,
      ),
      next = usage(
        {
          source: "test",
          metrics: [
            metric({
              id: "q",
              label: "q",
              used: 10,
              resets_at: addMillis(reset, offset === 30000 ? 30000 : 300000),
            }),
          ],
        },
        addMillis(stamp, offset),
      );
    expect(Store.isReset(old, next)).toBe(expected);
  });
}
it("preserves microseconds in normalization, comparisons and stored observations", async () => {
  const { store } = await fresh(),
    id = randomUUID(),
    stamp = "2026-11-07T12:00:00.123456Z";
  expect(utc(stamp)).toBe(stamp);
  expect(compare(stamp, "2026-11-07T12:00:00.123455Z")).toBe(1);
  store.saveSnapshot(
    SnapshotSchema.parse({
      account_id: id,
      status: "ok",
      data: { ...result(), fetched_at: stamp },
    }),
  );
  expect(store.getSnapshot(id).data!.fetched_at).toBe(stamp);
});
it("prunes only history files older than the thirty-day cutoff", async () => {
  const { store, data } = await fresh(),
    id = randomUUID();
  store.appendHistory(id, {
    ...result(),
    fetched_at: addMillis(now(), -31 * 86400000),
  });
  store.appendHistory(id, result());
  store.cleanupHistory();
  expect(
    fs.readdirSync(path.join(data, "accounts", id, "history")),
  ).toHaveLength(1);
});
it("deletes one account from current files, backups, encrypted map and history", async () => {
  const { store, data } = await fresh(),
    one = account(),
    two = account({ alias: "other" });
  store.saveConfig({ ...store.config, accounts: [one, two] });
  store.saveConfig({ ...store.config, page_title: "updated" });
  store.setCredentials(one.id, { api_key: "deleted" });
  store.setCredentials(two.id, { api_key: "retained" });
  store.saveSnapshot(
    SnapshotSchema.parse({ account_id: one.id, status: "ok", data: result() }),
  );
  store.appendHistory(one.id, result());
  store.deleteAccountData(one.id);
  expect(store.getCredentials(one.id)).toEqual({});
  expect(store.getCredentials(two.id)).toEqual({ api_key: "retained" });
  expect(fs.existsSync(path.join(data, "accounts", one.id))).toBe(false);
  expect(
    fs.readFileSync(path.join(data, "config.json.bak"), "utf8"),
  ).not.toContain(one.id);
  expect(
    decryptCredentials(
      fs.readFileSync(path.join(data, "master.key")),
      fs.readFileSync(path.join(data, "secrets.enc.bak")),
    ),
  ).not.toHaveProperty(one.id);
});
it("restores a complete copied data directory with its original master key", async () => {
  const { store, data, root } = await fresh(),
    id = randomUUID();
  store.setCredentials(id, { api_key: "fixture-only" });
  await store.close();
  const target = path.join(root, "restored");
  fs.cpSync(data, target, { recursive: true });
  const restored = new Store(target);
  stores.push(restored);
  await restored.open();
  expect(restored.getCredentials(id)).toEqual({ api_key: "fixture-only" });
});
for (const kind of ["same", "nested-data", "nested-static", "alias"]) {
  it(`rejects overlapping public/private directories (${kind})`, () => {
    const root = tempRoot();
    roots.push(root.root);
    let data = root.data,
      web = root.web;
    if (kind === "same") web = data;
    if (kind === "nested-data") data = path.join(web, "private");
    if (kind === "nested-static") web = path.join(data, "public");
    if (kind === "alias") {
      fs.mkdirSync(data);
      web = path.join(root.root, "alias");
      fs.symlinkSync(data, web);
    }
    expect(() => loadSettings({ dataDir: data, staticDir: web })).toThrow(
      "non-overlapping",
    );
  });
}
it("creates, validates and revokes an opaque CSRF-protected administrator session", () => {
  const auth = new AdminAuth("fixture-admin"),
    [token, session] = auth.login("fixture-admin", "peer");
  expect(auth.require(token, session.csrf, true)).toEqual(session);
  expect(() => auth.require(token, "wrong", true)).toThrow("请求验证失败");
  auth.logout(token);
  expect(() => auth.require(token, "", false)).toThrow("请先登录");
  expect(COOKIE_NAME).toBe("pq_session");
});
it("expires an admin session after eight hours and limits consecutive failed logins", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const auth = new AdminAuth("fixture-admin"),
    [token] = auth.login("fixture-admin", "peer");
  vi.setSystemTime(Date.now() + 28800001);
  expect(() => auth.require(token, "", false)).toThrow("请先登录");
  for (let i = 0; i < 5; i++)
    expect(() => auth.login("wrong", "peer")).toThrow("不正确");
  expect(() => auth.login("fixture-admin", "peer")).toThrow("尝试过多");
});
const fixtureKey = "sk-" + "A".repeat(43),
  otherKey = "sk-" + "B".repeat(43);
it("counts failures synchronously and resets the rolling limit after successful key authentication", () => {
  const auth = new ApiKeyAuth();
  for (let i = 0; i < 4; i++)
    expect(auth.verify([fixtureKey], otherKey, "peer")).toBe(false);
  expect(auth.verify([fixtureKey], fixtureKey, "peer")).toBe(true);
  for (let i = 0; i < 5; i++)
    expect(auth.verify([fixtureKey], otherKey, "peer")).toBe(false);
  expect(() => auth.verify([fixtureKey], fixtureKey, "peer")).toThrow(
    "尝试过多",
  );
});
it.each(["/info", "/info/", "/info/private", "/mcp", "/mcp/", "/mcp/private"])(
  "extracts keys and redacts the entire query at %s",
  (route) => {
    expect(
      extractApiKey(route + "?x-api-key=" + fixtureKey + "&private=hidden", [
        "X-API-KEY",
        fixtureKey,
      ]),
    ).toEqual({
      url: route,
      apikey: fixtureKey,
      invalid: false,
      protected: true,
    });
  },
);
it.each(["x-api-key", "X-Api-Key", "X-API-KEY"])(
  "accepts only canonical %s authentication",
  (name) => {
    expect(extractApiKey("/mcp", [name, fixtureKey]).apikey).toBe(fixtureKey);
  },
);
it.each(["apikey", "password", "X-API-Password"])(
  "never authenticates a retired %s field",
  (name) => {
    expect(
      extractApiKey("/mcp?password=" + fixtureKey, [name, fixtureKey]).apikey,
    ).toBeNull();
  },
);
it("does not authenticate the former apikey query parameter", () => {
  const result = extractApiKey("/info?apikey=" + fixtureKey, []);
  expect(result).toMatchObject({ url: "/info", apikey: null, protected: true });
});
it.each([
  ["?x-api-key=" + fixtureKey + "&x-api-key=" + fixtureKey, []],
  ["?x-api-key=" + fixtureKey, ["x-api-key", otherKey]],
  ["", ["x-api-key", fixtureKey, "X-API-KEY", fixtureKey]],
  ["?x-api-key=", []],
  ["?x-api-key=sk-short", []],
  ["?x-api-key=" + "x".repeat(16385), []],
] as [string, string[]][])(
  "rejects ambiguous or malformed API credentials (%#)",
  (query, headers) => {
    expect(extractApiKey("/mcp" + query, headers).invalid).toBe(true);
  },
);
it("keeps an observation one microsecond before a history boundary in the earlier bucket", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T12:00:00.123Z"));
  const { store } = await fresh(),
    id = randomUUID(),
    start = addMillis(now(), -86400000),
    boundary = addMillis(start, 300000);
  store.appendHistory(id, {
    ...result(),
    fetched_at: boundary.replace(".123000Z", ".122999Z"),
  });
  const history = store.history(id, "24h");
  expect(history.points[0].gap).toBe(false);
  expect(history.points[1].gap).toBe(true);
});
it("does not introduce a microsecond rounding error when normalizing the millisecond clock", () => {
  expect(utc(Date.UTC(2026, 10, 7, 3, 57, 57, 21))).toBe(
    "2026-11-07T03:57:57.021000Z",
  );
  expect(utc(Date.UTC(2026, 10, 7, 3, 57, 57, 185))).toBe(
    "2026-11-07T03:57:57.185000Z",
  );
});
