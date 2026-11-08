import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { API_KEY_PATTERN } from "./access.js";
export const COOKIE_NAME = "pq_session",
  SESSION_TTL = 8 * 60 * 60;
export const INTERFACE_SECRET_HEADERS: readonly string[] = [
  "x-api-key",
  "apikey",
  "password",
  "x-api-password",
];
export class HttpError extends Error {
  /** Carry only a safe public detail and the established HTTP status code. */
  constructor(
    public statusCode: number,
    public detail: string,
  ) {
    super(detail);
  }
}
/** Hash secrets to fixed-length buffers before comparing them in constant time. */
export function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
/** Compare UTF-8 strings without exposing a length-dependent comparison branch. */
export function equal(a: string, b: string): boolean {
  return timingSafeEqual(hash(a), hash(b));
}
/** Maintain a bounded fifteen-minute rolling failure window for each peer. */
export class Attempts {
  private peers = new Map<string, number[]>();
  /** Customize the safe throttle message without changing the shared rolling-window rules. */
  constructor(private message = "登录尝试过多，请在 15 分钟后重试") {}
  /** Reject before expensive password work once five failures remain in the active window. */
  check(peer: string): void {
    for (const [address, rows] of this.peers) {
      const current = rows.filter((stamp) => stamp >= Date.now() - 900000);
      if (current.length) this.peers.set(address, current);
      else this.peers.delete(address);
    }
    if ((this.peers.get(peer)?.length ?? 0) >= 5)
      throw new HttpError(429, this.message);
  }
  /** Record a failure only after an actual password comparison has failed. */
  fail(peer: string): void {
    this.peers.set(peer, [...(this.peers.get(peer) ?? []), Date.now()]);
  }
  /** Clear failures after a successful authenticated login or interface request. */
  clear(peer: string): void {
    this.peers.delete(peer);
  }
}
type Session = { csrf: string; expires: number };
export class AdminAuth {
  private sessions = new Map<string, Session>();
  private attempts = new Attempts();
  private password: Buffer;
  /** Keep only a fixed digest of the environment-configured administrator password. */
  constructor(password: string) {
    this.password = hash(password);
  }
  /** Create an eight-hour in-memory session after successful constant-time authentication. */
  login(password: string, peer: string): [string, Session] {
    this.attempts.check(peer);
    if (!timingSafeEqual(hash(password), this.password)) {
      this.attempts.fail(peer);
      throw new HttpError(401, "管理密码不正确");
    }
    this.attempts.clear(peer);
    for (const [key, row] of this.sessions)
      if (row.expires <= Date.now()) this.sessions.delete(key);
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url"),
      session = {
        csrf: randomBytes(32).toString("base64url"),
        expires: Date.now() + SESSION_TTL * 1000,
      };
    this.sessions.set(hash(token).toString("hex"), session);
    return [token, session];
  }
  /** Validate the opaque cookie and synchronizer token before an administrator operation. */
  require(token: string, csrf: string, write = false): Session {
    const session = this.sessions.get(hash(token).toString("hex"));
    if (!session || session.expires <= Date.now())
      throw new HttpError(401, "请先登录管理后台");
    if (write && !equal(csrf, session.csrf))
      throw new HttpError(403, "请求验证失败，请刷新页面后重试");
    return session;
  }
  /** Revoke the current session immediately. */
  logout(token: string): void {
    this.sessions.delete(hash(token).toString("hex"));
  }
}
export class ApiKeyAuth {
  private attempts = new Attempts("密钥尝试过多，请在 15 分钟后重试");
  /** Compare fixed-size digests of every active key without an early match-dependent exit. */
  verify(keys: string[], apikey: string | null, peer: string): boolean {
    this.attempts.check(peer);
    const candidate = hash(apikey ?? "");
    let matched = 0;
    for (const key of keys)
      matched |= Number(timingSafeEqual(candidate, hash(key)));
    if (matched) this.attempts.clear(peer);
    else this.attempts.fail(peer);
    return matched === 1;
  }
}
/** Extract the x-api-key credential and remove query/header material before routing or access logging. */
export function extractApiKey(
  rawURL: string,
  rawHeaders: string[],
): {
  url: string;
  apikey: string | null;
  invalid: boolean;
  protected: boolean;
} {
  const path = rawURL.split("?", 1)[0],
    protectedPath = ["/info", "/mcp"].some(
      (base) => path === base || path.startsWith(base + "/"),
    );
  if (!protectedPath)
    return { url: rawURL, apikey: null, invalid: false, protected: false };
  const query = rawURL.includes("?")
      ? rawURL.slice(rawURL.indexOf("?") + 1)
      : "",
    params = new URLSearchParams(query),
    apikeys = params.getAll("x-api-key"),
    headers = new Map<string, string>();
  let duplicatedHeader = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (name !== "x-api-key") continue;
    if (headers.has(name)) duplicatedHeader = true;
    headers.set(name, rawHeaders[i + 1]);
  }
  let invalid =
      query.length > 16384 ||
      [...params].length > 64 ||
      apikeys.length > 1 ||
      duplicatedHeader,
    apikey = apikeys[0] ?? null;
  for (const value of headers.values()) {
    if (apikey !== null && !equal(apikey, value)) invalid = true;
    apikey = value;
  }
  if (apikey !== null && !API_KEY_PATTERN.test(apikey)) invalid = true;
  return {
    url: path,
    apikey: invalid ? null : apikey,
    invalid,
    protected: true,
  };
}
