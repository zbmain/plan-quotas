import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverQuotaAlerts } from "./quota-alert-ledger";
import type { AlertReading } from "./quota-alerts";

const reading: AlertReading = {
  key: "account-short",
  observedAt: 100,
  resetAt: null,
  remaining: 20,
  alias: "研发账号",
  label: "短周期",
};

/** Provide shared storage and a queued lock for concurrent tab simulations. */
function installBrowserStorage() {
  const values = new Map<string, string>();
  let previous = Promise.resolve();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, callback: () => Promise<void>) => {
        const current = previous.then(callback);
        previous = current.catch(() => undefined);
        return current;
      },
    },
  });
}

describe("quota alert delivery", () => {
  beforeEach(installBrowserStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("sends once when two tabs process the same observation concurrently", async () => {
    const notify = vi.fn(async () => undefined);
    await Promise.all([
      deliverQuotaAlerts([reading], () => true, notify),
      deliverQuotaAlerts([reading], () => true, notify),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("警告：研发账号短周期额度仅剩：20%");
  });

  it("retains successful deliveries and retries a failed delivery", async () => {
    const second = { ...reading, key: "account-long", label: "长周期" };
    const notify = vi
      .fn<(message: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("通知失败"))
      .mockResolvedValue(undefined);
    await expect(
      deliverQuotaAlerts([reading, second], () => true, notify),
    ).rejects.toThrow("通知失败");
    await deliverQuotaAlerts([reading, second], () => true, notify);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2][0]).toContain("长周期");
  });

  it("does not rewrite an unchanged observation", async () => {
    const notify = vi.fn(async () => undefined);
    await deliverQuotaAlerts([reading], () => true, notify);
    vi.mocked(localStorage.setItem).mockClear();
    await deliverQuotaAlerts([reading], () => true, notify);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("recovers a damaged record without affecting other accounts", async () => {
    const second = { ...reading, key: "account-long", label: "长周期" };
    const notify = vi.fn(async (_message: string) => undefined);
    await deliverQuotaAlerts([reading, second], () => true, notify);
    localStorage.setItem("pq-quota-alert-record-v1:account-long", "{");
    await deliverQuotaAlerts([reading, second], () => true, notify);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2][0]).toContain("长周期");
  });

  it("does not deliver a queued observation after alerts are switched off", async () => {
    let release: () => void = () => undefined;
    const firstNotification = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notify = vi.fn(() => firstNotification);
    let enabled = true;
    const first = deliverQuotaAlerts([reading], () => true, notify);
    const second = deliverQuotaAlerts(
      [{ ...reading, key: "another-account" }],
      () => enabled,
      notify,
    );
    await Promise.resolve();
    enabled = false;
    release();
    await Promise.all([first, second]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
