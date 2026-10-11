const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Sep 18", with the year when it isn't this one. */
export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "2m ago", "5h ago", "Yesterday", "3d ago", then a date. */
export function relativeTime(iso: string, now = new Date()): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 2 * DAY) return "Yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return shortDate(iso, now);
}

/** "Today, 9:14 AM" or "Sep 24". */
export function eventTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() !== now.toDateString()) return shortDate(iso, now);
  return `Today, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** The local calendar day of a timestamp, as a date input wants it (yyyy-mm-dd). */
export function toDateInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A date input's value as a timestamp. Noon, so the day survives a timezone change. */
export function fromDateInput(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

/** People paste "stripe.com/jobs/123"; the API wants a full http(s) URL. */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
