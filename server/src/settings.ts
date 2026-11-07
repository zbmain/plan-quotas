import * as fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { CATALOG, type Credentials } from "@plan-quotas/shared";
import { AdapterError } from "./adapters/base.js";
import { StoreError } from "./storage.js";
export type Settings = {
  adminPassword: string;
  dataDir: string;
  staticDir: string;
  cookieSecure: boolean;
  allowedHosts: string[];
  publicOrigin: string;
};

/** Resolve existing ancestors so symlink aliases cannot place private data below public assets. */
function resolved(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute
    ? absolute
    : path.join(resolved(parent), path.basename(absolute));
}
/** Read the same environment keys, with actual environment values overriding the optional file. */
export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const file = path.resolve(".env"),
    values = {
      ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}),
      ...process.env,
    };
  const settings: Settings = {
    adminPassword: values.ADMIN_PASSWORD ?? "admin",
    dataDir: values.DATA_DIR ?? "data",
    staticDir: values.STATIC_DIR ?? "frontend/dist",
    cookieSecure: ["true", "1", "yes", "on"].includes(
      (values.COOKIE_SECURE ?? "false").toLowerCase(),
    ),
    allowedHosts: (values.ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    publicOrigin: values.PUBLIC_ORIGIN ?? "",
    ...overrides,
  };
  const data = resolved(settings.dataDir),
    web = resolved(settings.staticDir);
  if (
    data === web ||
    data.startsWith(web + path.sep) ||
    web.startsWith(data + path.sep)
  )
    throw new StoreError(
      "DATA_DIR and STATIC_DIR must be separate, non-overlapping directories",
    );
  return settings;
}
/** Validate exactly the fields declared for an allowed channel and authentication type. */
export function validateCredentials(
  provider: string,
  authType: string,
  credentials: Credentials,
): void {
  const item = CATALOG[provider],
    fields = item?.fields[authType];
  if (!fields) throw new AdapterError("invalid_credentials");
  const allowed = new Set(fields.map((row) => row.key));
  if (Object.keys(credentials).some((key) => !allowed.has(key)))
    throw new AdapterError("invalid_credentials");
  for (const field of fields) {
    const value = credentials[field.key] ?? "";
    if (
      typeof value !== "string" ||
      (field.required && !value.trim()) ||
      value.length > 32768 ||
      /[\r\n]/.test(value)
    )
      throw new AdapterError("invalid_credentials");
  }
}
