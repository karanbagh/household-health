// Household-local time handling with no extra dependencies.
// The LLM reads and writes household-local wall-clock times; the database stores UTC.

function parts(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour), min: Number(p.minute), s: Number(p.second),
  };
}

/** Offset of timeZone from UTC at the given instant, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

/** "2026-10-11T08:10" or "2026-10-11" (midnight) in timeZone → UTC Date. Returns null if malformed. */
export function localToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? "00", m[5] ?? "00"].map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(naive)) return null;
  // Two passes handle instants near a DST change.
  let utc = naive - offsetMs(new Date(naive), timeZone);
  utc = naive - offsetMs(new Date(utc), timeZone);
  const check = parts(new Date(utc), timeZone);
  if (check.y !== y || check.m !== mo || check.d !== d) return null; // e.g. Feb 30
  return new Date(utc);
}

/** Today's date in timeZone as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  const p = parts(now, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "Sunday, 2026-10-11 09:05" — given to the LLM so "this morning" and "next Tuesday" resolve correctly. */
export function nowDescription(timeZone: string, now = new Date()): string {
  const p = parts(now, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${weekday}, ${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)} (${timeZone})`;
}

/** Human display in the household's zone, e.g. "Oct 11, 2026, 8:10 AM". */
export function formatLocal(date: Date, timeZone: string, withTime = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "short", day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}
