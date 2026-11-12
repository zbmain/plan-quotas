import { afterEach, describe, expect, it, vi } from "vitest";
import { requestQuotaAlertPermission } from "./useQuotaAlerts";

/** Provide only the browser capabilities needed by a click on the alert switch. */
function browserPermission(
  current: NotificationPermission,
  decision = current,
) {
  const request = vi.fn().mockResolvedValue(decision);
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { locks: { request: vi.fn() } });
  vi.stubGlobal("Notification", {
    permission: current,
    requestPermission: request,
  });
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe("配额预警通知权限", () => {
  it.each([
    ["granted", ""],
    ["denied", "请在浏览器的网站设置中允许通知"],
    ["default", "尚未授权，再次开启即可允许通知"],
  ] as const)("处理首次弹窗的 %s 结果", async (decision, hint) => {
    const request = browserPermission("default", decision);
    const onPrompt = vi.fn();
    const result = requestQuotaAlertPermission(onPrompt);
    expect(request).toHaveBeenCalledOnce();
    expect(onPrompt).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe(hint);
  });

  it.each(["granted", "denied"] as const)(
    "已有 %s 决定时直接使用",
    async (current) => {
      const request = browserPermission(current);
      const hint = await requestQuotaAlertPermission(vi.fn());
      expect(hint).toBe(
        current === "granted" ? "" : "请在浏览器的网站设置中允许通知",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("普通 HTTP 页面提示访问方式", async () => {
    const request = browserPermission("default");
    vi.stubGlobal("window", { isSecureContext: false });
    await expect(requestQuotaAlertPermission(vi.fn())).resolves.toContain(
      "HTTPS",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
