// Sprint calendar — the unit of time for Treasury Cockpit v2.
// A sprint is exactly 14 days, Monday → Sunday, anchored to `epoch` (an ISO date of
// a known sprint start; default Mon 2026-09-07). Sprint index `k` is an integer
// relative to the epoch (negative = earlier). All math is done on LOCAL calendar
// days (never raw ms across DST) so a sprint never gains or loses an hour.

export const SPRINT_DAYS = 14;
export const DEFAULT_EPOCH = "2026-09-07";
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MS_DAY = 86400000;

/** "YYYY-MM-DD" → local Date at 00:00. Invalid/empty → null. */
export function parseLocalDate(iso) {
  if (iso instanceof Date) return new Date(iso.getFullYear(), iso.getMonth(), iso.getDate());
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) { const d = new Date(iso); return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** local Date → "YYYY-MM-DD" */
export function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday 00:00 (local) of the week containing d. */
export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  x.setDate(x.getDate() - dow);
  return x;
}

/** Whole calendar days from a to b (DST-safe). */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / MS_DAY);
}

function epochMonday(epoch) { return mondayOf(parseLocalDate(epoch || DEFAULT_EPOCH)); }

/** Sprint index k (may be negative) of the sprint containing `date`. */
export function sprintIndex(date, epoch) {
  const d = date instanceof Date ? date : parseLocalDate(date);
  if (!d) return null;
  return Math.floor(daysBetween(epochMonday(epoch), mondayOf(d)) / SPRINT_DAYS);
}

/** Monday that starts sprint k. */
export function sprintStart(k, epoch) { return addDays(epochMonday(epoch), k * SPRINT_DAYS); }

/** Sunday that ends sprint k. */
export function sprintEnd(k, epoch) { return addDays(sprintStart(k, epoch), SPRINT_DAYS - 1); }

/** 0 for the first week of the sprint containing `date`, 1 for the second. */
export function weekInSprint(date, epoch) {
  const d = date instanceof Date ? date : parseLocalDate(date);
  const k = sprintIndex(d, epoch);
  return daysBetween(sprintStart(k, epoch), mondayOf(d)) >= 7 ? 1 : 0;
}

/** The sprint containing today (the planner's view origin). */
export function sprintOfToday(epoch, today = new Date()) { return sprintIndex(today, epoch); }

export function fmtMD(d) { return MON[d.getMonth()] + " " + d.getDate(); }

/** "Sep 7 – 20", "Sep 21 – Oct 4", "Dec 28 – Jan 10" */
export function rangeLabel(start, end) {
  return start.getMonth() === end.getMonth() ? `${fmtMD(start)} – ${end.getDate()}` : `${fmtMD(start)} – ${fmtMD(end)}`;
}

/** Display info for sprint k relative to the view origin `origin`. */
export function sprintLabel(k, epoch, origin = 0) {
  const start = sprintStart(k, epoch), end = sprintEnd(k, epoch);
  return { k, ordinal: k - origin, start, end, range: rangeLabel(start, end), short: fmtMD(start) };
}

/** Sprints [origin, origin+horizon) with labels — the planner's columns. */
export function sprintColumns(epoch, origin, horizon) {
  return Array.from({ length: horizon }, (_, i) => sprintLabel(origin + i, epoch, origin));
}
