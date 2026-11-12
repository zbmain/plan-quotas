import { useCallback, useEffect, useRef, useState } from "react";
import { quotaAlertReadings } from "./quota-alerts";
import { deliverQuotaAlerts } from "./quota-alert-ledger";
import type { Dashboard } from "./types";

const preferenceKey = "pq-quota-alerts-enabled";
const permissionHint = "请在浏览器的网站设置中允许通知";
type Notify = (message: string) => Promise<void>;
let sender: Promise<Notify> | undefined;

/** Read the opt-in shared by all public tabs of the same origin. */
function optedIn(): boolean {
  try {
    return localStorage.getItem(preferenceKey) === "true";
  } catch {
    return false;
  }
}

/** Explain browser requirements before requesting permission from a user click. */
function capabilityHint(): string {
  if (!window.isSecureContext) return "请使用 HTTPS 或本机地址开启额度预警";
  if (typeof Notification === "undefined" || !navigator.locks?.request)
    return "当前浏览器不支持额度预警";
  return "";
}

/** Report whether previously authorized monitoring can still send a notification. */
function accessHint(): string {
  return (
    capabilityHint() ||
    (Notification.permission === "granted" ? "" : permissionHint)
  );
}

/** Ask directly from the switch's click and explain a denied or dismissed prompt. */
export async function requestQuotaAlertPermission(
  onPrompt: () => void,
): Promise<string> {
  const unavailable = capabilityHint();
  if (unavailable) return unavailable;
  let permission = Notification.permission;
  if (permission === "default") {
    onPrompt();
    permission = await Notification.requestPermission();
  }
  if (permission === "granted") return "";
  return permission === "denied"
    ? permissionHint
    : "尚未授权，再次开启即可允许通知";
}

/** Keep queued work from sending after navigation, opt-out, or permission revocation. */
function alertsActive(): boolean {
  return !location.pathname.startsWith("/admin") && optedIn() && !accessHint();
}

/** Wait for the notification worker itself, whose narrow scope excludes the dashboard. */
async function prepareSender(): Promise<Notify> {
  if (
    !navigator.serviceWorker ||
    typeof ServiceWorkerRegistration === "undefined" ||
    !ServiceWorkerRegistration.prototype.showNotification
  ) {
    return async (message) => {
      new Notification(message);
    };
  }
  const registration = await navigator.serviceWorker.register(
    "/assets/quota-alert-worker.js",
  );
  const worker =
    registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw new Error("无法启动浏览器通知");
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      /** Resolve only when the registration can actually display notifications. */
      const checkState = () => {
        if (worker.state !== "activated" && worker.state !== "redundant")
          return;
        worker.removeEventListener("statechange", checkState);
        if (worker.state === "activated") resolve();
        else reject(new Error("无法启动浏览器通知"));
      };
      worker.addEventListener("statechange", checkState);
      checkState();
    });
  }
  return (message) => registration.showNotification(message);
}

/** Reuse the active notification channel and allow a failed setup to be retried. */
function notificationSender(): Promise<Notify> {
  sender ??= prepareSender().catch((error) => {
    sender = undefined;
    throw error;
  });
  return sender;
}

/** Manage user-initiated permission and deliver alerts from successful public refreshes. */
export function useQuotaAlerts() {
  const [enabled, setEnabled] = useState(false);
  const [hint, setHint] = useState("");
  const [pending, setPending] = useState(false);
  const requesting = useRef(false);

  useEffect(() => {
    /** Reflect preference changes from another tab and permission changes on return. */
    function sync() {
      const wanted = optedIn();
      const unavailable = wanted ? accessHint() : "";
      setEnabled(wanted && !unavailable);
      if (wanted) setHint(unavailable);
    }
    /** Ignore unrelated local settings and per-metric delivery records. */
    function syncStorage(event: StorageEvent) {
      if (event.key === preferenceKey || event.key === null) {
        setHint("");
        sync();
      }
    }
    sync();
    window.addEventListener("storage", syncStorage);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", syncStorage);
      window.removeEventListener("focus", sync);
    };
  }, []);

  /** Return true when a newly authorized switch needs a fresh dashboard immediately. */
  async function toggle(): Promise<boolean> {
    if (requesting.current) return false;
    requesting.current = true;
    setPending(true);
    try {
      if (enabled) {
        localStorage.removeItem(preferenceKey);
        setEnabled(false);
        setHint("");
        return false;
      }
      const unavailable = await requestQuotaAlertPermission(() =>
        setHint("请在浏览器弹窗中选择“允许”"),
      );
      if (unavailable) {
        setHint(unavailable);
        return false;
      }
      await notificationSender();
      if (location.pathname.startsWith("/admin")) return false;
      localStorage.setItem(preferenceKey, "true");
      setEnabled(true);
      setHint("");
      return true;
    } catch {
      setHint("无法更改额度预警，请检查浏览器的通知和网站存储设置");
      return false;
    } finally {
      requesting.current = false;
      setPending(false);
    }
  }

  /** Use fresh, unfiltered data and serialize actual delivery with other public tabs. */
  const checkDashboard = useCallback(async (dashboard: Dashboard) => {
    if (location.pathname.startsWith("/admin") || !optedIn()) return;
    const unavailable = accessHint();
    setEnabled(!unavailable);
    if (unavailable) {
      setHint(unavailable);
      return;
    }
    try {
      const notify = await notificationSender();
      await deliverQuotaAlerts(
        quotaAlertReadings(dashboard),
        alertsActive,
        notify,
      );
      if (alertsActive()) setHint("");
    } catch {
      if (alertsActive()) setHint("额度预警暂时无法发送，将在下次刷新时重试");
    }
  }, []);

  return { enabled, pending, hint, toggle, checkDashboard };
}
