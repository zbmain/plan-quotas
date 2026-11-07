import { Temporal } from "@js-temporal/polyfill";

/** Return UTC with the existing microsecond precision, including original sub-millisecond data. */
export function utc(value: string | number | Date): string {
  let instant: Temporal.Instant;
  if (typeof value === "number")
    instant = Temporal.Instant.fromEpochNanoseconds(
      BigInt(Math.trunc(value)) * 1_000_000n +
        BigInt(Math.round((value - Math.trunc(value)) * 1e6)),
    );
  else if (value instanceof Date)
    instant = Temporal.Instant.fromEpochMilliseconds(value.getTime());
  else instant = Temporal.Instant.from(value);
  return instant
    .toString({ fractionalSecondDigits: 6 })
    .replace(/\.000000Z$/, "Z");
}
/** Obtain the clock through Date.now so scheduling and compatibility tests can inject time. */
export function now(): string {
  return utc(Date.now());
}
/** Compare instants without truncating microseconds stored by earlier versions. */
export function compare(a: string, b: string): number {
  return Temporal.Instant.compare(a, b);
}
/** Read milliseconds only where an interval or timeout needs a numeric duration. */
export function millis(value: string): number {
  return Number(Temporal.Instant.from(value).epochNanoseconds) / 1e6;
}
/** Subtract instants before conversion so adjacent history buckets retain microsecond boundaries. */
export function differenceMillis(later: string, earlier: string): number {
  return (
    Number(
      Temporal.Instant.from(later).epochNanoseconds -
        Temporal.Instant.from(earlier).epochNanoseconds,
    ) / 1e6
  );
}
/** Add a finite duration while retaining the original instant's fractional precision. */
export function addMillis(value: string, delta: number): string {
  return utc(
    Temporal.Instant.from(value)
      .add({ nanoseconds: Math.round(delta * 1e6) })
      .toString(),
  );
}
/** Preserve the public history endpoint's established explicit UTC offset spelling. */
export function historyTime(value: string): string {
  return utc(value).replace(/Z$/, "+00:00");
}
/** Parse optional provider timestamps, preserving an unknown value rather than inventing one. */
export function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (
      typeof value === "number" ||
      (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))
    ) {
      const number = Number(value);
      return utc(number > 1e11 ? number : number * 1000);
    }
    let text = String(value).replace(" ", "T");
    if (!/(Z|[+-]\d\d:\d\d)$/.test(text)) text += "Z";
    return utc(text);
  } catch {
    return null;
  }
}
