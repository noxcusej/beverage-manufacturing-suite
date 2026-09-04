// Baseline burn — the overhead heartbeat for Treasury Cockpit v2.
// A BurnLine is a flat monthly P&L figure (with optional step-change bounds and an
// exceptional cadence). `burnBySprint` lands each line on calendar dates and buckets
// them into the planner's sprint columns. Pure ESM: no React, no deps, no Date.now().
// See src/treasury/CONTRACT.md §1 (BurnLine) and §3, and the spec §4.

import { sprintIndex, sprintStart, sprintEnd, weekInSprint, parseLocalDate, isoLocal, addDays } from "./sprints.js";

/**
 * @typedef {'Payroll & benefits'|'Rent & facilities'|'Utilities'|'Insurance'
 *   |'Software & subscriptions'|'Professional services'|'Marketing'|'Debt service'|'Other G&A'} BurnCategory
 */

/**
 * @typedef {Object} BurnLine
 * @property {string} id
 * @property {BurnCategory} category
 * @property {string} [label]          optional detail, e.g. "Facility lease — 123 Main"
 * @property {number} monthly          flat $ per month (magnitude; cash OUT). For 'one-time' it is the one-off amount.
 * @property {number} [dayOfMonth]     1–28, default 1 — the calendar day the line hits
 * @property {string} [from]           ISO date, inclusive lower bound (step change / one-time date)
 * @property {string} [to]             ISO date, inclusive upper bound
 * @property {'monthly'|'quarterly'|'annual'|'one-time'} [cadence]  default 'monthly'
 * @property {string} [notes]
 */

/**
 * @typedef {Object} BurnItem
 * @property {string} label
 * @property {number} amount
 * @property {BurnCategory} category
 */

/** The nine burn categories, in P&L order. */
export const BURN_CATEGORIES = Object.freeze([
  "Payroll & benefits",
  "Rent & facilities",
  "Utilities",
  "Insurance",
  "Software & subscriptions",
  "Professional services",
  "Marketing",
  "Debt service",
  "Other G&A",
]);

/**
 * One $0 monthly line per category, in BURN_CATEGORIES order — the pre-created
 * P&L form the Burn tab presents on first use.
 * @param {(prefix: string) => string} newId  id factory (from store.js)
 * @returns {BurnLine[]}
 */
export function defaultBurnLines(newId) {
  return BURN_CATEGORIES.map((category) => ({
    id: newId("burn"),
    category,
    monthly: 0,
    dayOfMonth: 1,
    cadence: "monthly",
  }));
}

/** Clamp a dayOfMonth to the 1–28 range the contract allows (default 1). */
function clampDay(day) {
  const n = Math.floor(Number(day));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 28);
}

/** Zero-based month ordinal (year*12 + month) for stepping through calendar months. */
function monthOrdinal(d) { return d.getFullYear() * 12 + d.getMonth(); }

/**
 * Bucket burn lines into the sprint window [origin, origin+horizon).
 *
 * Index `i` corresponds to sprint `k = origin + i`. `weekly[2*i + w]` splits each
 * sprint into its two weeks (`w` = weekInSprint of the landing date).
 *
 * Landing rules:
 * - Calendar months are scanned from the month of `sprintStart(origin)` through the
 *   month of `sprintEnd(origin + horizon − 1)`, inclusive.
 * - 'monthly' (default): lands on (year, month, min(dayOfMonth || 1, 28)) each month,
 *   counted only when that date is inside [from, to] (inclusive; missing = unbounded)
 *   and inside the sprint window.
 * - 'quarterly' / 'annual': same, stepping 3 / 12 months from the month of `from` if
 *   given, else from the origin month.
 * - 'one-time': lands once on `from` (skipped when `from` is missing).
 * - Item label = line.label || line.category; amounts are magnitudes (cash OUT).
 *   $0 landings are not listed in `items`.
 *
 * @param {BurnLine[]} lines
 * @param {string} epoch      ISO date of a known sprint start
 * @param {number} origin     absolute sprint k of column 0
 * @param {number} horizon    number of sprint columns
 * @returns {{ arr: number[], items: BurnItem[][], weekly: number[] }}
 */
export function burnBySprint(lines, epoch, origin, horizon) {
  const H = Math.max(0, Math.floor(Number(horizon)) || 0);
  const arr = new Array(H).fill(0);
  const items = Array.from({ length: H }, () => []);
  const weekly = new Array(2 * H).fill(0);
  if (H === 0) return { arr, items, weekly };

  const firstMonth = monthOrdinal(sprintStart(origin, epoch));
  const lastMonth = monthOrdinal(sprintEnd(origin + H - 1, epoch));

  for (const line of lines || []) {
    if (!line) continue;
    const amount = Number(line.monthly) || 0;
    const cadence = line.cadence || "monthly";
    const from = parseLocalDate(line.from);
    const to = parseLocalDate(line.to);
    const label = line.label || line.category;
    const category = line.category;

    const land = (d) => {
      if (from && d < from) return;
      if (to && d > to) return;
      const i = sprintIndex(d, epoch) - origin;
      if (i < 0 || i >= H) return;
      arr[i] += amount;
      weekly[2 * i + weekInSprint(d, epoch)] += amount;
      if (amount) items[i].push({ label, amount, category });
    };

    if (cadence === "one-time") {
      if (from) land(from);
      continue;
    }

    const day = clampDay(line.dayOfMonth);
    const step = cadence === "quarterly" ? 3 : cadence === "annual" ? 12 : 1;

    // Monthly scans every month in the window. Quarterly/annual step from the `from`
    // month when given (so the phase is anchored to the line), else the origin month.
    let m = firstMonth;
    if (step > 1 && from) {
      const anchor = monthOrdinal(from);
      m = anchor >= firstMonth ? anchor : anchor + Math.ceil((firstMonth - anchor) / step) * step;
    }
    for (; m <= lastMonth; m += step) {
      land(new Date(Math.floor(m / 12), m % 12, day));
    }
  }

  return { arr, items, weekly };
}

/**
 * Monthly burn run-rate: Σ over lines active on `todayIso` (from ≤ today ≤ to when
 * given), normalized to a monthly figure — monthly counts in full, quarterly ÷ 3,
 * annual ÷ 12, one-time contributes 0.
 *
 * NOTE: the contract lists `monthlyTotal(lines)`; the "today" is taken as an explicit
 * parameter so the module never reads the clock. When `todayIso` is omitted the
 * from/to window is not applied (every line counts).
 *
 * @param {BurnLine[]} lines
 * @param {string} [todayIso]  ISO date used to evaluate the active window
 * @returns {number}
 */
export function monthlyTotal(lines, todayIso) {
  const today = parseLocalDate(todayIso);
  let total = 0;
  for (const line of lines || []) {
    if (!line) continue;
    const cadence = line.cadence || "monthly";
    if (cadence === "one-time") continue;
    if (today) {
      const from = parseLocalDate(line.from);
      const to = parseLocalDate(line.to);
      if (from && today < from) continue;
      if (to && today > to) continue;
    }
    const monthly = Number(line.monthly) || 0;
    total += cadence === "quarterly" ? monthly / 3 : cadence === "annual" ? monthly / 12 : monthly;
  }
  return total;
}

/** v1 fixed-cost `cat` → v2 BurnCategory. Anything unknown → 'Other G&A'. */
const V1_CAT_MAP = {
  "Payroll": "Payroll & benefits",
  "Facilities": "Rent & facilities",
  "Debt service": "Debt service",
  "Insurance": "Insurance",
  "Software": "Software & subscriptions",
  "Utilities": "Utilities",
};

/**
 * Convert v1 fixed-cost items into v2 BurnLines.
 *
 * v1 item: `{ id, label, cat, cadence: 'weekly'|'biweekly'|'monthly'|'quarterly'|'annual'|'one-time',
 * amount, day?, anchorWeek?, week?, from?, to? }` where `from`/`to` are WEEK INDICES
 * (relative to `ctx.base`, the v1 week-0 Monday) and `week` is the week index of a
 * one-time item.
 *
 * Conversion:
 * - weekly → monthly amount × 52/12; biweekly → × 26/12 (cadence 'monthly', dayOfMonth 1)
 * - monthly → as-is (dayOfMonth = day || 1); quarterly/annual → same cadence, amount as-is
 * - one-time → cadence 'one-time', `from` = base + 7·(week || 0) days
 * - `from` week > 0 → ISO of base + 7·from days; `to` finite → ISO of base + 7·to + 6 days
 *   (the Sunday closing that week). Without `ctx.base` week bounds cannot be dated and
 *   are dropped (one-time items then have no `from` and will not land).
 * - `monthly` is rounded to whole dollars; the v1 label is kept.
 *
 * @param {Array<Object>} fixedItems
 * @param {(prefix: string) => string} newId
 * @param {{ base?: Date }} [ctx]   base = v1 week-0 Monday (local Date)
 * @returns {BurnLine[]}
 */
export function migrateFixedToBurn(fixedItems, newId, ctx = {}) {
  const base = ctx.base instanceof Date && !isNaN(ctx.base) ? ctx.base : null;
  const weekIso = (w) => (base ? isoLocal(addDays(base, 7 * w)) : undefined);
  const out = [];

  for (const it of fixedItems || []) {
    if (!it) continue;
    const amount = Number(it.amount) || 0;
    const category = V1_CAT_MAP[it.cat] || "Other G&A";
    const line = {
      id: newId("burn"),
      category,
      label: it.label || undefined,
      monthly: amount,
      dayOfMonth: 1,
      cadence: "monthly",
    };

    switch (it.cadence) {
      case "weekly":
        line.monthly = amount * 52 / 12;
        line.notes = `Migrated from v1 weekly $${amount.toLocaleString("en-US")}`;
        break;
      case "biweekly":
        line.monthly = amount * 26 / 12;
        line.notes = `Migrated from v1 biweekly $${amount.toLocaleString("en-US")}`;
        break;
      case "quarterly":
      case "annual":
        line.cadence = it.cadence;
        line.dayOfMonth = clampDay(it.day);
        break;
      case "one-time": {
        line.cadence = "one-time";
        const f = weekIso(Number(it.week) || 0);
        if (f) line.from = f;
        break;
      }
      case "monthly":
      default:
        line.dayOfMonth = clampDay(it.day);
        break;
    }
    line.monthly = Math.round(line.monthly);

    if (line.cadence !== "one-time") {
      const fromW = Number(it.from) || 0;
      if (fromW > 0) { const f = weekIso(fromW); if (f) line.from = f; }
      const rawTo = it.to;
      const toW = rawTo === null || rawTo === undefined || rawTo === "" ? NaN : Number(rawTo);
      if (Number.isFinite(toW) && base) line.to = isoLocal(addDays(base, 7 * toW + 6));
    }

    out.push(line);
  }
  return out;
}
