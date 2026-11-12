import {
  evaluateQuotaAlert,
  type AlertReading,
  type AlertRecord,
} from "./quota-alerts";

const storagePrefix = "pq-quota-alert-record-v1:";
const lockName = "pq-quota-alert-delivery-v1";

/** Load one observation and recover independently from invalid stored data. */
function loadRecord(key: string): AlertRecord | undefined {
  const stored = localStorage.getItem(storagePrefix + key);
  if (!stored) return undefined;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<AlertRecord>;
    if (
      record.key === key &&
      typeof record.observedAt === "number" &&
      Number.isFinite(record.observedAt) &&
      (record.resetAt === null ||
        (typeof record.resetAt === "number" &&
          Number.isFinite(record.resetAt))) &&
      typeof record.severity === "number" &&
      Number.isInteger(record.severity) &&
      record.severity >= 0 &&
      record.severity <= 3
    )
      return record as AlertRecord;
  } catch {
    // A damaged record can be reconstructed from the next valid observation.
  }
  return undefined;
}

/** Serialize observation and delivery across tabs, storing each successful result. */
export async function deliverQuotaAlerts(
  readings: AlertReading[],
  active: () => boolean,
  notify: (message: string) => Promise<void>,
): Promise<void> {
  if (!readings.length || !active()) return;
  await navigator.locks.request(lockName, async () => {
    if (!active()) return;
    for (const reading of readings) {
      if (!active()) return;
      const previous = loadRecord(reading.key);
      const { record, message } = evaluateQuotaAlert(reading, previous);
      if (message) {
        if (!active()) return;
        await notify(message);
      }
      if (record !== previous)
        localStorage.setItem(
          storagePrefix + reading.key,
          JSON.stringify(record),
        );
    }
  });
}
