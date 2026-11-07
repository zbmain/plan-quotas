import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/storage.js";
import { tempRoot } from "./helpers.js";
const execute = promisify(execFile),
  roots: string[] = [],
  stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
for (const kind of ["missing-key", "invalid-key", "live-lock"])
  it(`exits with a recoverable safe explanation for ${kind}`, async () => {
    const root = tempRoot();
    roots.push(root.root);
    fs.mkdirSync(root.data, { mode: 0o700 });
    if (kind === "live-lock") {
      const store = new Store(root.data);
      stores.push(store);
      await store.open();
    } else {
      fs.writeFileSync(path.join(root.data, "secrets.enc"), "{}");
      if (kind === "invalid-key")
        fs.writeFileSync(path.join(root.data, "master.key"), "invalid");
    }
    try {
      await execute(
        process.execPath,
        [
          path.resolve("node_modules/tsx/dist/cli.mjs"),
          "server/src/cli.ts",
          "serve",
        ],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            DATA_DIR: root.data,
            STATIC_DIR: root.web,
            ADMIN_PASSWORD: "fixture-admin-must-not-appear",
          },
          timeout: 5000,
        },
      );
      throw new Error("expected startup rejection");
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain(
        kind === "live-lock" ? "锁定" : "master.key",
      );
      expect(error.stderr).not.toContain(root.data);
      expect(error.stderr).not.toContain("fixture-admin-must-not-appear");
      expect(error.stderr).not.toContain("at main");
    }
    if (kind === "missing-key")
      expect(fs.existsSync(path.join(root.data, "master.key"))).toBe(false);
  });
