// The cash engine — Treasury Cockpit v2's ONE source of truth for every number on
// screen. `computeCash(input)` turns a scenario (runs, burn, capital, bills, manual
// adjustments) into per-sprint rows, per-week splits, hover breakdowns and the
// order-ahead / overdue / per-run views. Pure ESM, no React, no deps, and NEVER reads
// the clock: "today" is `input.today` (ISO). Shapes and rules are pinned in
// src/treasury/CONTRACT.md §4; intent in docs/TREASURY_COCKPIT_V2_SPEC.md §5, §1.3,
// §2.3, §2.4.
//
// Invariants carried from v1:
//   - Hidden runs contribute nothing to the rows (but `perRun` still reports them).
//   - Linked bills REPLACE the material estimate they cover: only
//     max(0, amount − Σ linked included bills) projects at the order date; the bills
//     themselves flow at their own pay date in `bills`. Never sum both.
//   - Flows dated before the view origin are not counted but are reported
//     (perRun.pastPayments, overdue, droppedCapital). Exception: included bills with a
//     pre-origin pay date are pulled INTO the origin sprint — they are cash owed now.
//   - out-rows (materials, taxes, burn, bills) are positive magnitudes; adjust / net /
//     closing are signed. Nothing here ever yields NaN.

import { sprintColumns, sprintIndex, sprintStart, weekInSprint, parseLocalDate, isoLocal } from "./sprints.js";
import { runEndDate, materialOrderDate, paymentDate, runCoverage } from "./runs.js";
import { burnBySprint } from "./burn.js";
import { defaultInclude } from "./xero.js";

/* ------------------------------------------------------------------ helpers */

/** Finite number or 0 — the engine's universal coercion (never NaN / ±Infinity). */
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Integer window parameters. */
function windowOf(input) {
  const origin = Math.floor(num(input && input.origin));
  const horizon = Math.max(0, Math.floor(num(input && input.horizon)));
  return { origin, horizon };
}

const ROW_KEYS = ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills", "adjust", "net", "closing"];
const BREAKDOWN_KEYS = ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills"];
const TOTAL_KEYS = ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills", "adjust"];
const CATEGORIES = ["hard", "soft", "outsourced"];

function zeros(n) { return new Array(n).fill(0); }
function lists(n) { return Array.from({ length: n }, () => []); }

function mapCols(epoch, origin, horizon) {
  return sprintColumns(epoch, origin, horizon).map((c, i) => ({
    k: c.k,
    i,
    start: c.start,
    end: c.end,
    range: c.range,
    ordinal: c.ordinal,
  }));
}

/** Is a bill counted in cash? Explicit `include` wins; else the Xero-status default. */
function billIncluded(bill) {
  return !!(bill && (bill.include ?? defaultInclude(bill.status)));
}

/**
 * Locate the material line a bill links to: `bill.lineId` matched inside the run named
 * by `bill.runId` when given, else anywhere. Returns `{ run, line }` or null.
 */
function linkedLine(bill, runs) {
  if (!bill || bill.lineId == null) return null;
  const lineId = String(bill.lineId);
  const pool = bill.runId != null ? (runs || []).filter((r) => r && String(r.id) === String(bill.runId)) : runs || [];
  for (const run of pool) {
    const line = (run.materials || []).find((l) => l && String(l.id) === lineId);
    if (line) return { run, line };
  }
  if (bill.runId != null) {
    // runId stale but the line still exists elsewhere → follow the line
    for (const run of runs || []) {
      if (!run) continue;
      const line = (run.materials || []).find((l) => l && String(l.id) === lineId);
      if (line) return { run, line };
    }
  }
  return null;
}

/** Later of two ISO dates (by calendar day); a missing side yields the other. */
function laterIso(a, b) {
  const da = parseLocalDate(a), db = parseLocalDate(b);
  if (!da) return db ? isoLocal(db) : "";
  if (!db) return isoLocal(da);
  return isoLocal(db > da ? db : da);
}

/**
 * The effective pay date of a bill (ISO), with the v1 precedence:
 *   1. `bill.payDate` (explicit override)
 *   2. the order date of the material line it is linked to (`bill.lineId`)
 *   3. `max(today, dueDate)` — an overdue bill is assumed to be paid today
 * `ctx = { runs, epoch, today }`. Returns "" only when nothing at all is dated.
 * @param {Bill} bill
 * @param {{runs?: Run[], epoch?: string, today?: string}} ctx
 * @returns {string}
 */
export function billPayDate(bill, ctx = {}) {
  if (!bill) return "";
  if (bill.payDate) {
    const d = parseLocalDate(bill.payDate);
    if (d) return isoLocal(d);
  }
  const link = linkedLine(bill, ctx.runs);
  if (link) return isoLocal(materialOrderDate(link.run, link.line, ctx.epoch));
  return laterIso(ctx.today, bill.dueDate);
}

/* ------------------------------------------------------------------ empty result */

/**
 * A zeroed Result for the same window — what the UI renders before hydration.
 * @param {object} input  { epoch, origin, horizon, openingCash }
 */
export function emptyResult(input = {}) {
  const { origin, horizon } = windowOf(input);
  const epoch = input.epoch;
  const openingCash = num(input.openingCash);
  const rows = {}, weekly = {}, breakdown = {}, totals = {};
  for (const key of ROW_KEYS) { rows[key] = zeros(horizon); weekly[key] = zeros(2 * horizon); }
  for (const key of BREAKDOWN_KEYS) breakdown[key] = lists(horizon);
  for (const key of TOTAL_KEYS) totals[key] = 0;
  rows.closing.fill(openingCash);
  weekly.closing.fill(openingCash);
  const cols = mapCols(epoch, origin, horizon);
  return {
    origin,
    horizon,
    cols,
    rows,
    weekly,
    breakdown,
    materialsByCategory: { hard: zeros(horizon), soft: zeros(horizon), outsourced: zeros(horizon) },
    orderAhead: cols.map((c) => ({ k: c.k, i: c.i, total: 0, count: 0, lines: [] })),
    overdue: [],
    droppedCapital: [],
    perRun: {},
    totals,
    trough: openingCash,
    troughI: 0,
    ending: openingCash,
    firstBreach: horizon,
  };
}

/* ------------------------------------------------------------------ the engine */

/**
 * Compute the cash position for one scenario over the window [origin, origin+horizon).
 *
 * Arrays are indexed `i = k − origin`; `weekly` arrays are `2·horizon` long and a flow
 * lands at `2·i + weekInSprint(date)` (manual adjustments in week 0 of their sprint;
 * bills pulled forward to the origin land in its week 0).
 *
 * @param {{
 *   epoch: string, origin: number, horizon: number, openingCash: number, floor: number,
 *   runs?: Run[], burn?: BurnLine[], capital?: Injection[], ap?: Bill[],
 *   manualAdj?: {[k: string]: number}, today: string
 * }} input
 * @returns {Result}  see CONTRACT.md §4
 */
export function computeCash(input = {}) {
  const { origin, horizon: H } = windowOf(input);
  const epoch = input.epoch;
  const openingCash = num(input.openingCash);
  const floor = num(input.floor);
  const runs = Array.isArray(input.runs) ? input.runs.filter(Boolean) : [];
  const burnLines = Array.isArray(input.burn) ? input.burn : [];
  const capital = Array.isArray(input.capital) ? input.capital.filter(Boolean) : [];
  const ap = Array.isArray(input.ap) ? input.ap.filter(Boolean) : [];
  const manualAdj = input.manualAdj && typeof input.manualAdj === "object" ? input.manualAdj : {};
  // Deterministic "today": the caller's ISO date; without one, the origin sprint's Monday.
  const todayDate = parseLocalDate(input.today) || sprintStart(origin, epoch);
  const todayIso = isoLocal(todayDate);
  const end = origin + H; // exclusive

  const res = emptyResult({ epoch, origin, horizon: H, openingCash });
  const { rows, weekly, breakdown, materialsByCategory, orderAhead, overdue, droppedCapital, perRun, totals } = res;

  const inWindow = (k) => k != null && k >= origin && k < end;
  /** Add a dated flow to a row (sprint + week bucket). Caller guarantees k is in window. */
  const land = (row, k, date, amount) => {
    const i = k - origin;
    rows[row][i] += amount;
    weekly[row][2 * i + weekInSprint(date, epoch)] += amount;
    return i;
  };

  /* ---- linked bills per material line: Σ included bill amounts keyed by lineId ---- */
  const billedByLine = new Map();
  for (const bill of ap) {
    if (bill.lineId == null || !billIncluded(bill)) continue;
    const key = String(bill.lineId);
    billedByLine.set(key, (billedByLine.get(key) || 0) + num(bill.amount));
  }

  /* ---- runs: payments, materials, taxes ---- */
  for (const run of runs) {
    const counted = !run.hidden;
    const runId = run.id;
    const runName = run.name ?? "";
    let inTotal = 0, pastPayments = 0, futurePayments = 0;

    for (const line of run.payments || []) {
      if (!line) continue;
      const amount = num(line.amount);
      inTotal += amount;
      const date = paymentDate(run, line, epoch);
      const k = sprintIndex(date, epoch);
      if (k < origin) { pastPayments += amount; continue; }
      if (k >= end) { futurePayments += amount; continue; }
      if (!counted) continue;
      const i = land("clientIn", k, date, amount);
      if (amount !== 0) breakdown.clientIn[i].push({ label: `${runName} — ${line.label ?? line.kind ?? "Payment"}`, amount, runId, kind: line.kind });
    }

    let materialsGross = 0;
    for (const line of run.materials || []) {
      if (!line) continue;
      const amount = num(line.amount);
      materialsGross += amount;
      if (amount <= 0) continue;
      const orderDate = materialOrderDate(run, line, epoch);
      const billed = billedByLine.get(String(line.id)) || 0;
      const remaining = Math.max(0, amount - billed);
      const k = sprintIndex(orderDate, epoch);
      const category = CATEGORIES.includes(line.category) ? line.category : "outsourced";
      const status = line.status || "planned";
      const feedsK = num(run.startSprint) + (num(line.feedsSprint) || 1) - 1;

      if (counted && inWindow(k)) {
        const i = land("materials", k, orderDate, remaining);
        breakdown.materials[i].push({
          label: `${runName} — ${line.label ?? ""}${billed > 0 ? " (net of linked bills)" : ""}`,
          amount: remaining,
          runId,
          lineId: line.id,
          category,
        });
        materialsByCategory[category][i] += remaining;
        const cell = orderAhead[i];
        cell.lines.push({ runId, runName, lineId: line.id, label: line.label ?? "", amount: remaining, orderDate, feedsK, status, category });
        if (remaining > 0) { cell.total += remaining; cell.count += 1; }
      }
      if (counted && orderDate < todayDate && status !== "ordered" && status !== "linked" && remaining > 0) {
        overdue.push({ runId, runName, lineId: line.id, label: line.label ?? "", amount: remaining, orderDate });
      }
    }

    const taxes = num(run.taxes);
    if (counted && taxes !== 0) {
      const endDate = runEndDate(run, epoch);
      const k = sprintIndex(endDate, epoch);
      if (inWindow(k)) {
        const i = land("taxes", k, endDate, taxes);
        breakdown.taxes[i].push({ label: `${runName} — taxes & regulatory`, amount: taxes, runId });
      }
    }

    const cov = runCoverage(run, epoch, todayIso);
    perRun[runId] = {
      net: inTotal - materialsGross - taxes,
      inTotal,
      outTotal: materialsGross + taxes,
      coverage: { total: cov.total, overdue: cov.overdue.length, firstDue: cov.firstDue },
      pastPayments,
      futurePayments,
    };
  }

  /* ---- burn ---- */
  const b = burnBySprint(burnLines, epoch, origin, H);
  rows.burn = b.arr.map(num);
  weekly.burn = b.weekly.map(num);
  breakdown.burn = b.items.map((items) => items.map((it) => ({ ...it, amount: num(it.amount) })));

  /* ---- bills ---- */
  const billCtx = { runs, epoch, today: todayIso };
  for (const bill of ap) {
    if (!billIncluded(bill)) continue;
    const amount = num(bill.amount);
    const payIso = billPayDate(bill, billCtx);
    const payDate = parseLocalDate(payIso) || todayDate;
    const rawK = sprintIndex(payDate, epoch);
    const k = Math.max(origin, rawK);
    if (k >= end) continue;
    const i = k - origin;
    rows.bills[i] += amount;
    // pulled-forward bills land in week 0 of the origin sprint; others in their own week
    weekly.bills[2 * i + (rawK < origin ? 0 : weekInSprint(payDate, epoch))] += amount;
    breakdown.bills[i].push({ label: `${bill.vendor ?? ""}${bill.ref ? " · " + bill.ref : ""}`, amount, billId: bill.id });
  }

  /* ---- capital ---- */
  for (const inj of capital) {
    const date = parseLocalDate(inj.date);
    const k = date ? sprintIndex(date, epoch) : null;
    if (!inWindow(k)) { droppedCapital.push(inj); continue; }
    const amount = num(inj.amount);
    const i = land("capitalIn", k, date, amount);
    breakdown.capitalIn[i].push({ label: inj.label ?? inj.type ?? "Capital", amount });
  }

  /* ---- manual adjustments (keys are ABSOLUTE k) ---- */
  for (let i = 0; i < H; i++) {
    const v = num(manualAdj[String(origin + i)]);
    rows.adjust[i] = v;
    weekly.adjust[2 * i] = v;
  }

  /* ---- net / closing / totals ---- */
  let running = openingCash;
  for (let i = 0; i < H; i++) {
    rows.net[i] = rows.clientIn[i] + rows.capitalIn[i] - rows.materials[i] - rows.taxes[i] - rows.burn[i] - rows.bills[i] + rows.adjust[i];
    running += rows.net[i];
    rows.closing[i] = running;
  }
  running = openingCash;
  for (let w = 0; w < 2 * H; w++) {
    weekly.net[w] = weekly.clientIn[w] + weekly.capitalIn[w] - weekly.materials[w] - weekly.taxes[w] - weekly.burn[w] - weekly.bills[w] + weekly.adjust[w];
    running += weekly.net[w];
    weekly.closing[w] = running;
  }
  for (const key of TOTAL_KEYS) totals[key] = rows[key].reduce((t, x) => t + x, 0);

  let trough = openingCash, troughI = 0, firstBreach = H;
  for (let i = 0; i < H; i++) {
    if (i === 0 || rows.closing[i] < trough) { trough = rows.closing[i]; troughI = i; }
    if (firstBreach === H && rows.closing[i] < floor) firstBreach = i;
  }
  res.trough = trough;
  res.troughI = troughI;
  res.ending = H > 0 ? rows.closing[H - 1] : openingCash;
  res.firstBreach = firstBreach;

  return res;
}
