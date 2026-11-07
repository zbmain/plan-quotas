import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAdapters } from "../src/adapters/index.js";
import { AdapterError, type Fetcher } from "../src/adapters/base.js";
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/adapters.json", import.meta.url), "utf8"),
);

/** Compare normalized outputs recursively while allowing only elapsed-clock reset drift. */
function equivalent(actual: any, expected: any, path = ""): void {
  if (path.endsWith("fetched_at")) return;
  if (path.endsWith("expires_at") && typeof expected === "string") {
    expect(Math.abs(Number(actual) - Number(expected))).toBeLessThan(2);
    return;
  }
  if (path.endsWith("resets_at") && actual && expected) {
    expect(Math.abs(Date.parse(actual) - Date.parse(expected))).toBeLessThan(
      1000,
    );
    return;
  }
  if (typeof expected === "number") {
    expect(actual).toBeTypeOf("number");
    expect(actual).toBeCloseTo(expected, 9);
    return;
  }
  if (Array.isArray(expected)) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) =>
      equivalent(actual[index], value, `${path}.${index}`),
    );
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected))
      equivalent(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  expect(actual).toEqual(expected);
}
afterEach(() => vi.useRealTimers());
describe("synthetic reference adapter contracts", () => {
  for (const [index, row] of fixtures.entries())
    it(`${index} ${row.channel} ${row.case.split("::").at(-1)}`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(row.now));
      let position = 0;
      const client: Fetcher = async (url, init) => {
        const response = row.requests[position++];
        expect(response, `Unexpected request ${url}`).toBeDefined();
        expect(String(url)).toEqual(response.url);
        expect(init?.method ?? "GET").toBe(response.method);
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(response.headers)) {
          if (
            [
              "host",
              "accept",
              "accept-encoding",
              "connection",
              "content-length",
            ].includes(name)
          )
            continue;
          if (
            name === "user-agent" &&
            String(value).startsWith("python-httpx/")
          )
            continue;
          expect(
            headers.get(name),
            `${row.channel} request header ${name}`,
          ).toBe(value);
        }
        const sentBody = String(init?.body ?? "");
        if (response.body) {
          if (
            String(response.headers["content-type"]).startsWith(
              "application/json",
            )
          )
            expect(JSON.parse(sentBody)).toEqual(JSON.parse(response.body));
          else if (
            String(response.headers["content-type"]).startsWith(
              "application/x-www-form-urlencoded",
            )
          )
            expect(Object.fromEntries(new URLSearchParams(sentBody))).toEqual(
              Object.fromEntries(new URLSearchParams(response.body)),
            );
          else expect(sentBody).toBe(response.body);
        } else expect(sentBody).toBe("");
        if (response.network_error)
          throw new TypeError("synthetic network error");
        return new Response(response.response, {
          status: response.status,
          headers: response.response_headers,
        });
      };
      try {
        const [result, rotated] = await buildAdapters()[row.channel].fetch(
          row.credentials,
          row.auth_type,
          client,
        );
        expect(row.error).toBeUndefined();
        equivalent(result, row.result);
        equivalent(rotated, row.rotated);
      } catch (error) {
        if (!row.error) throw error;
        expect(error).toBeInstanceOf(AdapterError);
        expect((error as AdapterError).code).toBe(row.error);
        if (row.retry_after !== null)
          expect((error as AdapterError).retry_after).toBe(row.retry_after);
      }
      expect(position).toBe(row.requests.length);
    });
});
