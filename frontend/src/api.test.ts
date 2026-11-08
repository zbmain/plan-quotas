import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./App";

afterEach(() => vi.unstubAllGlobals());

describe("API request headers", () => {
  it("omits JSON content type for a bodyless DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/admin/accounts/test", {
      method: "DELETE",
      headers: { "X-CSRF-Token": "fixture" },
    });
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(options.headers);
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("X-CSRF-Token")).toBe("fixture");
  });
  it("sets JSON content type when a request has a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify({ alias: "测试" }),
    });
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get("Content-Type"),
    ).toBe("application/json");
  });
});
