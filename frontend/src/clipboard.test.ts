import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/** Model a user-initiated selection copy without requiring a browser DOM in unit tests. */
function selectionCopy(behavior: boolean | Error = true) {
  const textarea = {
    value: "",
    readOnly: false,
    tabIndex: 0,
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const copied: string[] = [];
  const previousFocus = { focus: vi.fn() };
  const document = {
    activeElement: previousFocus,
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => {
      copied.push(textarea.value);
      if (behavior instanceof Error) throw behavior;
      return behavior;
    }),
  };
  vi.stubGlobal("document", document);
  return { textarea, copied, previousFocus, document };
}

afterEach(() => vi.unstubAllGlobals());

describe("clipboard compatibility", () => {
  it("uses the native clipboard when available without creating temporary secret fields", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fallback = selectionCopy();
    await copyText("sample-token-only");
    expect(writeText).toHaveBeenCalledWith("sample-token-only");
    expect(fallback.document.createElement).not.toHaveBeenCalled();
    expect(fallback.document.execCommand).not.toHaveBeenCalled();
  });

  it("copies the exact URL when Clipboard API is absent on an HTTP origin", async () => {
    vi.stubGlobal("navigator", {});
    const fallback = selectionCopy();
    const url = "http://example.test:8000/info?password=YOUR_PASSWORD";
    await copyText(url);
    expect(fallback.copied).toEqual([url]);
    expect(fallback.document.execCommand).toHaveBeenCalledWith("copy");
    expect(fallback.textarea.readOnly).toBe(true);
    expect(fallback.textarea.setSelectionRange).toHaveBeenCalledWith(
      0,
      url.length,
    );
    expect(fallback.textarea.value).toBe("");
    expect(fallback.textarea.remove).toHaveBeenCalledOnce();
    expect(fallback.previousFocus.focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
  });

  it("falls back when the native Clipboard API rejects access", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("permission denied")),
      },
    });
    const fallback = selectionCopy();
    await copyText("http://example.test/mcp");
    expect(fallback.copied).toEqual(["http://example.test/mcp"]);
    expect(fallback.textarea.remove).toHaveBeenCalledOnce();
  });

  it.each([false, new Error("copy denied")])(
    "reports fallback failure and always clears temporary content and restores focus (%s)",
    async (behavior) => {
      vi.stubGlobal("navigator", {});
      const fallback = selectionCopy(behavior);
      await expect(copyText("sample-private-value")).rejects.toThrow();
      expect(fallback.textarea.value).toBe("");
      expect(fallback.textarea.remove).toHaveBeenCalledOnce();
      expect(fallback.previousFocus.focus).toHaveBeenCalledOnce();
    },
  );
});
