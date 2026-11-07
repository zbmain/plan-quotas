import * as fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import lockfile from "proper-lockfile";
import {
  ConfigSchema,
  SnapshotSchema,
  UsageSchema,
  pending,
  type AppConfig,
  type Snapshot,
  type UsageResult,
  type Credentials,
  ACCESS_TOKEN_LIMIT,
  type ApiAccessSettings,
  type AccessToken,
} from "@plan-quotas/shared";
import { decryptAccess, encryptAccess, type StoredAccess } from "./access.js";
import { HttpError } from "./security.js";
import {
  now,
  utc,
  compare,
  millis,
  addMillis,
  historyTime,
  differenceMillis,
} from "./time.js";

export class StoreError extends Error {}
const AAD = Buffer.from("plan-quotas-secrets-v1");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the existing AES-GCM envelope, whose last sixteen ciphertext bytes are the tag. */
export function decryptCredentials(
  key: Buffer,
  envelope: Buffer,
): Record<string, Credentials> {
  const value = JSON.parse(envelope.toString());
  if (
    value.v !== 1 ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string"
  )
    throw new StoreError("unsupported credentials version");
  const nonce = Buffer.from(value.nonce, "hex"),
    bytes = Buffer.from(value.ciphertext, "hex");
  if (nonce.length !== 12 || bytes.length < 16)
    throw new StoreError("invalid encrypted credentials");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(-16));
  const result = JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(0, -16)),
      decipher.final(),
    ]).toString(),
  );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new StoreError("invalid credentials payload");
  return result;
}
/** Produce the same version-one envelope for both old and new deployments. */
export function encryptCredentials(
  key: Buffer,
  records: Record<string, Credentials>,
  nonce = randomBytes(12),
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(records), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      nonce: nonce.toString("hex"),
      ciphertext: encrypted.toString("hex"),
    }),
  );
}
/** Detect a directory entry even when it is a dangling symbolic link. */
function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export class Store {
  config: AppConfig = ConfigSchema.parse({});
  readonly dataDir: string;
  private key: Buffer | null = null;
  private access: StoredAccess | null = null;
  private release: (() => Promise<void>) | null = null;
  private compromised = false;
  /** Retain a private absolute data root without reading credentials during construction. */
  constructor(
    directory: string,
    private onLost: () => void = () => {},
  ) {
    this.dataDir = path.resolve(directory);
  }
  /** Acquire the Node-only lease before opening any mutable persisted state. */
  async open(): Promise<void> {
    if (this.release) return;
    if (exists(this.dataDir)) this.directory(this.dataDir);
    else fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    try {
      this.release = await lockfile.lock(this.dataDir, {
        lockfilePath: path.join(this.dataDir, ".node-lock"),
        stale: 30000,
        update: 5000,
        retries: 0,
        onCompromised: () => {
          this.compromised = true;
          this.onLost();
        },
      });
    } catch {
      throw new StoreError("data directory is already in use");
    }
    try {
      this.config = this.loadConfig();
      const keyPath = path.join(this.dataDir, "master.key"),
        secret = path.join(this.dataDir, "secrets.enc"),
        access = path.join(this.dataDir, "api-access.enc");
      if (
        !exists(keyPath) &&
        (exists(secret) ||
          exists(secret + ".bak") ||
          exists(access) ||
          this.config.api_access_version)
      )
        throw new StoreError(
          "encrypted credentials or access settings exist but master.key is missing",
        );
      if (!exists(keyPath)) this.atomicWrite(keyPath, randomBytes(32), false);
      this.key = this.readRegular(keyPath);
      if (this.key.length !== 32)
        throw new StoreError("master.key has an invalid length");
      this.initializeAccess();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  /** Release the process lease without modifying credentials or creating another key. */
  async close(): Promise<void> {
    const release = this.release;
    this.release = null;
    this.key = null;
    this.access = null;
    if (release)
      try {
        await release();
      } catch {
        /* A compromised lease must not remove another process's lock. */
      }
  }
  /** Reject every write once the lease has been lost. */
  private writable(): void {
    if (this.compromised) throw new StoreError("data lock compromised");
    if (!this.release) throw new StoreError("store is not open");
  }
  /** Refuse symbolic links and special files at every persistent-file boundary. */
  private regular(file: string): void {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new StoreError("unsafe file");
  }
  /** Refuse symbolic links before traversing a persistent directory. */
  private directory(folder: string): void {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StoreError("unsafe directory");
  }
  /** Open through O_NOFOLLOW and inspect the descriptor to avoid symlink races. */
  private openRegular(file: string, flags: number): number {
    const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
    if (!fs.fstatSync(fd).isFile()) {
      fs.closeSync(fd);
      throw new StoreError("unsafe non-regular file");
    }
    fs.fchmodSync(fd, 0o600);
    return fd;
  }
  /** Read a regular private file through its checked descriptor. */
  private readRegular(file: string): Buffer {
    const fd = this.openRegular(file, fs.constants.O_RDONLY);
    try {
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Write and fsync an exclusive temporary file, then atomically replace the target. */
  private atomicWrite(file: string, payload: Buffer, backup: boolean): void {
    this.writable();
    const parent = path.dirname(file);
    this.directory(parent);
    const resolved = fs.realpathSync(parent),
      root = fs.realpathSync(this.dataDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      throw new StoreError("file path escaped data directory");
    if (exists(file)) this.regular(file);
    const temp = path.join(
      parent,
      `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      const fd = this.openRegular(
        temp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (backup && exists(file))
        this.atomicWrite(file + ".bak", this.readRegular(file), false);
      fs.renameSync(temp, file);
      fs.chmodSync(file, 0o600);
      const directory = fs.openSync(
        parent,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
      );
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (exists(temp)) fs.unlinkSync(temp);
    }
  }
  /** Recover only from the immediately previous known-valid configuration. */
  private loadConfig(): AppConfig {
    const file = path.join(this.dataDir, "config.json");
    if (!exists(file) && !exists(file + ".bak")) return ConfigSchema.parse({});
    if (exists(file))
      try {
        return ConfigSchema.parse(
          JSON.parse(this.readRegular(file).toString()),
        );
      } catch {
        /* Try the previous atomic version. */
      }
    try {
      const bytes = this.readRegular(file + ".bak"),
        value = ConfigSchema.parse(JSON.parse(bytes.toString()));
      this.atomicWrite(file, bytes, false);
      return value;
    } catch {
      throw new StoreError("configuration and backup are unreadable");
    }
  }
  /** Persist compatible snake-case settings and strip retired fields from subsequent writes. */
  saveConfig(config: AppConfig): void {
    const parsed = ConfigSchema.parse({
      ...config,
      ...(this.access ? { api_access_version: 1 } : {}),
    });
    const persisted: Record<string, unknown> = { ...parsed };
    delete persisted.info_require_password;
    delete persisted.info_password_hash;
    this.atomicWrite(
      path.join(this.dataDir, "config.json"),
      Buffer.from(JSON.stringify(persisted)),
      true,
    );
    this.config = parsed;
  }
  /** Migrate once without converting a legacy password hash or ever restoring revoked keys. */
  private initializeAccess(): void {
    const file = path.join(this.dataDir, "api-access.enc");
    if (!exists(file)) {
      if (this.config.api_access_version)
        throw new StoreError("encrypted access settings are missing");
      this.writeAccess({
        version: 1,
        require_apikey: this.config.info_require_password,
        tokens: [],
      });
    } else {
      try {
        this.access = decryptAccess(this.key!, this.readRegular(file));
      } catch {
        throw new StoreError("encrypted access settings are unreadable");
      }
    }
    if (!this.config.api_access_version) {
      this.config = {
        ...this.config,
        api_access_version: 1,
        info_require_password: false,
        info_password_hash: null,
      };
      const persisted: Record<string, unknown> = { ...this.config };
      delete persisted.info_require_password;
      delete persisted.info_password_hash;
      const bytes = Buffer.from(JSON.stringify(persisted));
      // Both config generations carry the marker; normal config recovery cannot undo migration.
      this.atomicWrite(
        path.join(this.dataDir, "config.json.bak"),
        bytes,
        false,
      );
      this.atomicWrite(path.join(this.dataDir, "config.json"), bytes, false);
    }
  }
  /** Commit the complete security state atomically, with no stale-key backup fallback. */
  private writeAccess(access: StoredAccess): void {
    this.atomicWrite(
      path.join(this.dataDir, "api-access.enc"),
      encryptAccess(this.key!, access),
      false,
    );
    this.access = access;
  }
  /** Require an open leased store before accessing the in-memory decrypted security state. */
  private accessState(): StoredAccess {
    this.writable();
    if (!this.key || !this.access)
      throw new StoreError("access settings are not open");
    return this.access;
  }
  /** Return metadata only, never the full key or a recoverable key fragment. */
  getAccessSettings(): ApiAccessSettings {
    const access = this.accessState();
    return {
      require_apikey: access.require_apikey,
      limit: ACCESS_TOKEN_LIMIT,
      tokens: access.tokens.map(({ id, created_at }) => ({ id, created_at })),
    };
  }
  /** Expose active keys only to the internal constant-time authenticator. */
  getApiKeys(): string[] {
    return this.accessState().tokens.map((row) => row.apikey);
  }
  /** Save an explicit access mode while preventing a new empty-key protected configuration. */
  setAccessMode(required: boolean): ApiAccessSettings {
    const access = this.accessState();
    if (required && !access.require_apikey && !access.tokens.length)
      throw new HttpError(400, "请先申请 Token，再启用密钥访问");
    this.writeAccess({ ...access, require_apikey: required });
    return this.getAccessSettings();
  }
  /** Generate and persist at most five keys synchronously under the single-process store lease. */
  createAccessToken(): AccessToken {
    const access = this.accessState();
    if (access.tokens.length >= ACCESS_TOKEN_LIMIT)
      throw new HttpError(409, "最多允许创建 5 个 Token，请先撤销一个");
    let apikey: string;
    do {
      apikey = "sk-" + randomBytes(32).toString("base64url");
    } while (access.tokens.some((row) => row.apikey === apikey));
    const token = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      apikey,
    };
    this.writeAccess({ ...access, tokens: [...access.tokens, token] });
    return { id: token.id, created_at: token.created_at };
  }
  /** Reveal one key only after the caller has passed administrator authentication and CSRF. */
  revealAccessToken(id: string): string {
    const token = this.accessState().tokens.find((row) => row.id === id);
    if (!token) throw new HttpError(404, "Token 不存在或已撤销");
    return token.apikey;
  }
  /** Revoke immediately without switching a protected instance back to public access. */
  deleteAccessToken(id: string): void {
    const access = this.accessState();
    if (!access.tokens.some((row) => row.id === id))
      throw new HttpError(404, "Token 不存在或已撤销");
    this.writeAccess({
      ...access,
      tokens: access.tokens.filter((row) => row.id !== id),
    });
  }
  /** Decode the complete encrypted map, with recovery restricted to its authenticated backup. */
  private secrets(): Record<string, Credentials> {
    if (!this.key) throw new StoreError("store is not open");
    const file = path.join(this.dataDir, "secrets.enc");
    if (!exists(file) && !exists(file + ".bak")) return {};
    if (exists(file))
      try {
        return decryptCredentials(this.key, this.readRegular(file));
      } catch {
        /* Try the previous authenticated envelope. */
      }
    try {
      const bytes = this.readRegular(file + ".bak"),
        value = decryptCredentials(this.key, bytes);
      this.atomicWrite(file, bytes, false);
      return value;
    } catch {
      throw new StoreError("encrypted credentials and backup are unreadable");
    }
  }
  /** Read one decrypted record without exposing the map itself to a caller. */
  getCredentials(id: string): Credentials {
    return { ...this.secrets()[this.validateId(id)] };
  }
  /** Encrypt one credential update atomically while preserving the prior envelope. */
  setCredentials(id: string, credentials: Credentials): void {
    id = this.validateId(id);
    const records = this.secrets();
    records[id] = { ...credentials };
    this.atomicWrite(
      path.join(this.dataDir, "secrets.enc"),
      encryptCredentials(this.key!, records),
      true,
    );
  }
  /** Require the established canonical UUID spelling before constructing filesystem paths. */
  private validateId(id: string): string {
    if (typeof id !== "string" || !uuid.test(id))
      throw new Error("account_id must be a canonical UUID");
    return id.toLowerCase();
  }
  /** Resolve account storage through checked real directories only. */
  private accountDir(id: string): string {
    id = this.validateId(id);
    const root = path.join(this.dataDir, "accounts");
    if (exists(root)) this.directory(root);
    else fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const target = path.join(root, id);
    if (exists(target)) this.directory(target);
    return target;
  }
  /** Create a private account directory when a new observation is persisted. */
  private ensureAccount(id: string): string {
    const folder = this.accountDir(id);
    if (!exists(folder)) fs.mkdirSync(folder, { mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    return folder;
  }
  /** Preserve the last successful data and its latest collection status together. */
  saveSnapshot(snapshot: Snapshot): void {
    const parsed = SnapshotSchema.parse(snapshot),
      folder = this.ensureAccount(parsed.account_id);
    this.atomicWrite(
      path.join(folder, "snapshot.json"),
      Buffer.from(JSON.stringify(parsed)),
      false,
    );
  }
  /** Return an explicit pending snapshot for accounts without an observation. */
  getSnapshot(id: string): Snapshot {
    id = this.validateId(id);
    const file = path.join(this.accountDir(id), "snapshot.json");
    if (!exists(file)) return pending(id);
    try {
      const snapshot = SnapshotSchema.parse(
        JSON.parse(this.readRegular(file).toString()),
      );
      if (snapshot.account_id !== id) throw new Error();
      return snapshot;
    } catch {
      throw new StoreError("snapshot is unreadable");
    }
  }
  /** Repair only a torn final JSONL line before appending the next complete observation. */
  appendHistory(id: string, data: UsageResult): void {
    this.writable();
    const folder = path.join(this.ensureAccount(id), "history");
    if (exists(folder)) this.directory(folder);
    else fs.mkdirSync(folder, { mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    const file = path.join(
      folder,
      utc(data.fetched_at).slice(0, 10) + ".jsonl",
    );
    if (exists(file)) {
      const bytes = this.readRegular(file);
      if (bytes.length && bytes.at(-1) !== 10) {
        const fd = this.openRegular(file, fs.constants.O_WRONLY);
        try {
          fs.ftruncateSync(fd, bytes.lastIndexOf(10) + 1);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const fd = this.openRegular(
      file,
      fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(UsageSchema.parse(data)) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Bucket actual observations while retaining gaps and reset boundaries. */
  history(id: string, range: string, hiddenPrefixes: string[] = []): any {
    const ranges: Record<string, [number, number]> = {
      "24h": [86400000, 300000],
      "7d": [604800000, 3600000],
      "30d": [2592000000, 21600000],
    };
    if (!ranges[range]) throw new Error("range_name must be 24h, 7d, or 30d");
    const [span, bucket] = ranges[range],
      end = now(),
      start = addMillis(end, -span),
      folder = path.join(this.accountDir(id), "history");
    const observations: UsageResult[] = [];
    if (exists(folder)) {
      this.directory(folder);
      for (const name of fs.readdirSync(folder).sort()) {
        if (
          !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) ||
          name.slice(0, 10) < start.slice(0, 10) ||
          name.slice(0, 10) > end.slice(0, 10)
        )
          continue;
        const bytes = this.readRegular(path.join(folder, name)).toString(),
          lines = bytes.split("\n");
        lines.pop();
        for (const line of lines)
          try {
            const data = UsageSchema.parse(JSON.parse(line));
            if (
              compare(data.fetched_at, start) >= 0 &&
              compare(data.fetched_at, end) <= 0
            ) {
              data.metrics = data.metrics.filter(
                (row) =>
                  !hiddenPrefixes.some((prefix) => row.id.startsWith(prefix)),
              );
              observations.push(data);
            }
          } catch {
            /* Invalid complete lines do not hide other observations. */
          }
      }
    }
    observations.sort((a, b) => compare(a.fetched_at, b.fetched_at));
    const buckets: (UsageResult | null)[] = Array(span / bucket).fill(null);
    for (const row of observations) {
      const index = Math.min(
        buckets.length - 1,
        Math.max(
          0,
          Math.floor(differenceMillis(row.fetched_at, start) / bucket),
        ),
      );
      buckets[index] = row;
    }
    let previous: UsageResult | null = null;
    const points = buckets.map((row, index) => {
      if (!row)
        return {
          timestamp: historyTime(addMillis(start, index * bucket)),
          metrics: [],
          gap: true,
          reset: false,
        };
      const reset = Store.isReset(previous, row);
      previous = row;
      return {
        timestamp: historyTime(row.fetched_at),
        metrics: row.metrics,
        gap: false,
        reset,
      };
    });
    return { account_id: id, range, points };
  }
  /** Detect only provider-observed resets and changes in visible quota counters. */
  static isReset(previous: UsageResult | null, current: UsageResult): boolean {
    if (!previous) return false;
    const prior = new Map(
      previous.metrics
        .filter((row) => row.kind === "quota")
        .map((row) => [row.id, row]),
    );
    for (const row of current.metrics) {
      const old = prior.get(row.id);
      if (!old || row.kind !== "quota") continue;
      if (
        old.resets_at &&
        row.resets_at &&
        millis(row.resets_at) - millis(old.resets_at) > 60000 &&
        compare(current.fetched_at, old.resets_at) >= 0
      )
        return true;
      if (
        (old.used !== null && row.used !== null && row.used < old.used) ||
        (old.remaining !== null &&
          row.remaining !== null &&
          row.remaining > old.remaining) ||
        (old.limit !== null && row.limit !== null && row.limit < old.limit)
      )
        return true;
    }
    return false;
  }
  /** Prune files older than thirty UTC dates without traversing symbolic links. */
  cleanupHistory(): void {
    this.writable();
    const root = path.join(this.dataDir, "accounts");
    if (!exists(root)) return;
    this.directory(root);
    const cutoff = addMillis(now(), -30 * 86400000).slice(0, 10);
    for (const account of fs.readdirSync(root)) {
      const folder = path.join(root, account);
      this.directory(folder);
      const history = path.join(folder, "history");
      if (!exists(history)) continue;
      this.directory(history);
      for (const name of fs.readdirSync(history)) {
        const file = path.join(history, name);
        this.regular(file);
        if (
          /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
          name.slice(0, 10) < cutoff
        )
          fs.unlinkSync(file);
      }
    }
  }
  /** Delete credentials from current and backup envelopes, and remove only this account's data. */
  deleteAccountData(id: string): void {
    this.writable();
    id = this.validateId(id);
    for (const name of ["config.json", "config.json.bak"]) {
      const file = path.join(this.dataDir, name);
      if (!exists(file)) continue;
      const config = ConfigSchema.parse(
        JSON.parse(this.readRegular(file).toString()),
      );
      config.accounts = config.accounts.filter((row) => row.id !== id);
      this.atomicWrite(file, Buffer.from(JSON.stringify(config)), false);
    }
    this.config = {
      ...this.config,
      accounts: this.config.accounts.filter((row) => row.id !== id),
    };
    const records = this.secrets();
    delete records[id];
    const envelope = encryptCredentials(this.key!, records),
      secret = path.join(this.dataDir, "secrets.enc");
    this.atomicWrite(secret + ".bak", envelope, false);
    this.atomicWrite(secret, envelope, false);
    const folder = this.accountDir(id);
    if (!exists(folder)) return;
    const snapshot = path.join(folder, "snapshot.json");
    if (exists(snapshot)) {
      this.regular(snapshot);
      fs.unlinkSync(snapshot);
    }
    const history = path.join(folder, "history");
    if (exists(history)) {
      this.directory(history);
      for (const name of fs.readdirSync(history)) {
        const file = path.join(history, name);
        this.regular(file);
        fs.unlinkSync(file);
      }
      fs.rmdirSync(history);
    }
    if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
  }
}
