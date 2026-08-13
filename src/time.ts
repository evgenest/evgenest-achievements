/** Offset of `timeZone` from UTC at the given instant, in milliseconds (DST-aware). */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // "24" is how some locales render midnight in hour12: false
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/** Local wall-clock time in `timeZone` (e.g. 2026-08-07 09:00) converted to a UTC instant. */
export function zonedTimeToUtc(day: string, timeOfDay: string, timeZone: string): Date {
  const naive = new Date(`${day}T${timeOfDay}Z`);
  if (Number.isNaN(naive.getTime())) return naive;
  return new Date(naive.getTime() - offsetMs(naive, timeZone));
}

/** Hour of day (0-23) of the given instant as seen in `timeZone`. */
export function hourInZone(iso: string, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(new Date(iso));
  return Number(hour) % 24;
}

export function formatDate(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium" }).format(new Date(iso));
}
