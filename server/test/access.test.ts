import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/storage.js";
import { tempRoot } from "./helpers.js";
import { decryptAccess } from "../src/access.js";

const roots: string[] = [],
  stores: Store[] = [];
/** Open isolated state, optionally emulating a pre-migration configuration. */
async function fresh(legacy?: boolean) {
  const root = tempRoot();
  roots.push(root.root);
  if (legacy !== undefined) {
    fs.mkdirSync(root.data);
    fs.writeFileSync(
      path.join(root.data, "config.json"),
      JSON.stringify({
        info_require_password: legacy,
        info_password_hash: "old-one-way-hash",
      }),
    );
  }
  const store = new Store(root.data);
  stores.push(store);
  await store.open();
  return { ...root, store };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
it("encrypts unique 256-bit keys and returns metadata only with a hard five-key cap", async () => {
  const { store, data } = await fresh();
  expect(() => store.setAccessMode(true)).toThrow("请先申请");
  const tokens = Array.from({ length: 5 }, () => store.createAccessToken());
  const keys = tokens.map((row) => store.revealAccessToken(row.id));
  expect(new Set(keys).size).toBe(5);
  for (const key of keys) expect(key).toMatch(/^sk-[A-Za-z0-9_-]{43}$/);
  expect(() => store.createAccessToken()).toThrow("最多允许");
  expect(store.getAccessSettings().tokens).toEqual(tokens);
  const file = path.join(data, "api-access.enc"),
    encrypted = fs.readFileSync(file);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const payload = decryptAccess(
    fs.readFileSync(path.join(data, "master.key")),
    encrypted,
  );
  expect(payload.tokens.map((row) => row.apikey)).toEqual(keys);
  for (const key of keys) {
    expect(encrypted.toString()).not.toContain(key);
    expect(
      fs.readFileSync(path.join(data, "config.json"), "utf8"),
    ).not.toContain(key);
    expect(JSON.stringify(store.getAccessSettings())).not.toContain(key);
  }
});
it("keeps revoked keys revoked after restart and after recovering ordinary configuration", async () => {
  const { store, data } = await fresh();
  const token = store.createAccessToken();
  store.setAccessMode(true);
  store.deleteAccessToken(token.id);
  expect(store.getAccessSettings()).toMatchObject({
    require_apikey: true,
    tokens: [],
  });
  expect(() => store.revealAccessToken(token.id)).toThrow("已撤销");
  store.saveConfig({ ...store.config, page_title: "Changed" });
  await store.close();
  fs.writeFileSync(path.join(data, "config.json"), "broken");
  await store.open();
  expect(store.getAccessSettings()).toMatchObject({
    require_apikey: true,
    tokens: [],
  });
  expect(fs.existsSync(path.join(data, "api-access.enc.bak"))).toBe(false);
});
it.each([true, false])(
  "migrates legacy protection %s idempotently without retaining password hashes",
  async (legacy) => {
    const { store, data } = await fresh(legacy);
    expect(store.getAccessSettings()).toMatchObject({
      require_apikey: legacy,
      tokens: [],
    });
    for (const name of ["config.json", "config.json.bak"]) {
      const config = JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
      expect(config.api_access_version).toBe(1);
      expect(config).not.toHaveProperty("info_password_hash");
      expect(config).not.toHaveProperty("info_require_password");
    }
    const token = store.createAccessToken(),
      key = store.revealAccessToken(token.id);
    await store.close();
    await store.open();
    expect(store.revealAccessToken(token.id)).toBe(key);
    expect(store.getAccessSettings().require_apikey).toBe(legacy);
  },
);
it.each(["missing", "corrupt", "key-missing", "symlink"])(
  "fails closed for %s migrated security state",
  async (kind) => {
    const { store, data } = await fresh();
    store.createAccessToken();
    store.setAccessMode(true);
    await store.close();
    const file = path.join(data, "api-access.enc");
    if (kind === "missing") fs.unlinkSync(file);
    if (kind === "corrupt") fs.writeFileSync(file, "broken");
    if (kind === "key-missing") fs.unlinkSync(path.join(data, "master.key"));
    if (kind === "symlink") {
      fs.renameSync(file, file + ".other");
      fs.symlinkSync(file + ".other", file);
    }
    await expect(store.open()).rejects.toThrow();
  },
);
it("does not change active state when an atomic access write fails", async () => {
  const { store, data } = await fresh();
  const token = store.createAccessToken();
  store.setAccessMode(true);
  const file = path.join(data, "api-access.enc");
  fs.renameSync(file, file + ".other");
  fs.symlinkSync(file + ".other", file);
  expect(() => store.deleteAccessToken(token.id)).toThrow();
  expect(store.getAccessSettings()).toMatchObject({
    require_apikey: true,
    tokens: [token],
  });
});
