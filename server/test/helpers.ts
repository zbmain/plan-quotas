import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  metric,
  usage,
  StoredAccountSchema,
  type StoredAccount,
} from "@plan-quotas/shared";
import { now } from "../src/time.js";

/** Allocate an isolated web/data pair without reading the deployment's actual credential volume. */
export function tempRoot(): { root: string; data: string; web: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-quotas-ts-test-")),
    web = path.join(root, "web");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(web, "index.html"),
    "<html><title>plan-quotas</title><div id='root'></div></html>",
  );
  fs.writeFileSync(
    path.join(web, "assets", "test.js"),
    "export const test=true",
  );
  return { root, data: path.join(root, "data"), web };
}
/** Create a canonical profile using synthetic identity and no real authentication material. */
export function account(changes: Partial<StoredAccount> = {}): StoredAccount {
  return StoredAccountSchema.parse({
    id: randomUUID(),
    provider: "glm",
    alias: "工作账号",
    auth_type: "api_key",
    created_at: now(),
    ...changes,
  });
}
/** Build a complete known observation for collection and storage compatibility checks. */
export function result(remaining = 10, label = "额度") {
  return usage(
    {
      source: "test-source",
      plan: "Pro",
      metrics: [
        metric({
          id: "weekly",
          label,
          used: 90 - remaining,
          limit: 100,
          remaining,
        }),
      ],
    },
    now(),
  );
}
