// Runs — materials table, client payment schedule, suite (quote) mapping and the
// v2 → v3 run migration for Treasury Cockpit v2.
//
// Pure ESM, no React, no external deps. Every function returns NEW objects and
// never mutates its inputs. Nothing here calls Date.now(): callers pass `today`
// or a `ctx`. Ids are never invented here — creators take a `newId(prefix)`
// callback (see store.js). All date/sprint math comes from ./sprints.js.
//
// Shapes are pinned in src/treasury/CONTRACT.md §1; the product intent is in
// docs/TREASURY_COCKPIT_V2_SPEC.md §2 (runs/materials), §3 (payments), §7 (migration).

import {
  sprintStart,
  sprintEnd,
  sprintIndex,
  addDays,
  parseLocalDate,
  isoLocal,
  daysBetween,
} from "./sprints.js";

/* ------------------------------------------------------------------ constants */

/**
 * The five standard material lines, in canonical display order, with their
 * default lead times (weeks before the sprint they feed) and category tags.
 * @type {ReadonlyArray<{label: string, leadWeeks: number, category: 'hard'|'soft'|'outsourced'}>}
 */
export const STANDARD_MATERIALS = Object.freeze([
  Object.freeze({ label: "Soft goods", leadWeeks: 3, category: "soft" }),
  Object.freeze({ label: "Cans", leadWeeks: 4, category: "hard" }),
  Object.freeze({ label: "Cartons", leadWeeks: 3, category: "hard" }),
  Object.freeze({ label: "Imported spirits", leadWeeks: 4, category: "soft" }),
  Object.freeze({ label: "Domestic spirits", leadWeeks: 2, category: "soft" }),
]);

/** Default lead time (weeks) for non-standard ("extra") material lines. */
export const DEFAULT_EXTRA_LEAD = 1;

/**
 * Run colours (muted, 8 distinct hex values). `quoteToRun` cycles through it.
 * @type {ReadonlyArray<string>}
 */
export const PALETTE = Object.freeze([
  "#586A8C", // slate blue
  "#8A6D5B", // clay
  "#5E7A70", // eucalyptus
  "#7E6A86", // dusk violet
  "#6E7F66", // moss
  "#8A7B4F", // ochre
  "#5F7F8C", // teal grey
  "#8C5F6A", // plum
]);

/** Label of the extra line that carries the suite's batching / cartoning fees. */
const BATCHING_LABEL = "Batching / cartoning";

/* ------------------------------------------------------------------ helpers */

/** Coerce anything numeric-ish to a finite number; everything else → 0. */
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Positive integer with a floor of 1 (for sprint counts / feedsSprint). */
function posInt(x, fallback = 1) {
  const n = Math.floor(num(x));
  return n >= 1 ? n : fallback;
}

/** Case-insensitive, whitespace-trimmed label equality. */
function sameLabel(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** The STANDARD_MATERIALS entry whose label matches, or undefined. */
function standardDef(label) {
  return STANDARD_MATERIALS.find((s) => sameLabel(s.label, label));
}

/** Deterministic id fallback when a creator is called without `newId`. */
function fallbackIdFactory(runId) {
  let n = 0;
  return (prefix) => `${runId ?? "run"}:${prefix}${++n}`;
}

function sumBy(arr, f) {
  let t = 0;
  for (const x of arr || []) t += num(f(x));
  return t;
}

/* ------------------------------------------------------------------ materials */

/**
 * Build a material line, filling defaults. `standard` is false unless given.
 * If the label matches a standard line, its default lead/category are used
 * unless the partial specifies them; otherwise DEFAULT_EXTRA_LEAD / 'outsourced'.
 * @param {Partial<import('./types').MaterialLine> & {label?: string}} partial
 * @param {(prefix: string) => string} newId
 * @returns {MaterialLine}
 */
export function newMaterialLine(partial = {}, newId) {
  const def = standardDef(partial.label);
  const line = {
    id: partial.id != null ? String(partial.id) : newId("m"),
    label: String(partial.label ?? ""),
    standard: partial.standard != null ? !!partial.standard : false,
    amount: num(partial.amount),
    leadWeeks: partial.leadWeeks != null ? Math.max(0, num(partial.leadWeeks)) : def ? def.leadWeeks : DEFAULT_EXTRA_LEAD,
    feedsSprint: posInt(partial.feedsSprint, 1),
    category: partial.category ?? (def ? def.category : "outsourced"),
    status: partial.status ?? "planned",
  };
  if (partial.orderedOn != null) line.orderedOn = partial.orderedOn;
  if (partial.source != null) line.source = partial.source;
  return line;
}

/**
 * The five standard lines (amount 0, feedsSprint 1, default leads) in canonical order.
 * @param {(prefix: string) => string} newId
 * @returns {MaterialLine[]}
 */
export function standardMaterials(newId) {
  return STANDARD_MATERIALS.map((s) => newMaterialLine({ ...s, standard: true, amount: 0, feedsSprint: 1 }, newId));
}

/**
 * Guarantee the five standard lines exist (idempotent). Existing standard lines
 * (matched by label, case-insensitive) keep their values; missing ones are added
 * at $0. Result order: standard lines in canonical order, then extras in their
 * existing order. Duplicate matches for one standard label stay as extras.
 * @param {MaterialLine[]} lines
 * @param {(prefix: string) => string} newId
 * @returns {MaterialLine[]}
 */
export function ensureStandardMaterials(lines, newId) {
  const src = Array.isArray(lines) ? lines : [];
  const used = new Set();
  const standard = STANDARD_MATERIALS.map((s) => {
    const idx = src.findIndex((l, i) => !used.has(i) && sameLabel(l && l.label, s.label));
    if (idx === -1) return newMaterialLine({ ...s, standard: true, amount: 0, feedsSprint: 1 }, newId);
    used.add(idx);
    const l = src[idx];
    return newMaterialLine({ ...l, label: s.label, standard: true, category: l.category ?? s.category, leadWeeks: l.leadWeeks ?? s.leadWeeks }, newId);
  });
  const extras = src
    .map((l, i) => (used.has(i) ? null : l))
    .filter(Boolean)
    .map((l) => newMaterialLine({ ...l, standard: false }, newId));
  return [...standard, ...extras];
}

/**
 * Σ material amounts.
 * @param {Run} run
 * @returns {number}
 */
export function materialsTotal(run) {
  return sumBy(run && run.materials, (l) => l.amount);
}

/* ------------------------------------------------------------------ dates */

/**
 * Monday the run starts (first day of `startSprint`).
 * @param {Run} run @param {string} epoch @returns {Date}
 */
export function runStartDate(run, epoch) {
  return sprintStart(num(run.startSprint), epoch);
}

/**
 * Sunday the run ends (last day of sprint `startSprint + sprints − 1`).
 * @param {Run} run @param {string} epoch @returns {Date}
 */
export function runEndDate(run, epoch) {
  return sprintEnd(num(run.startSprint) + posInt(run.sprints, 1) - 1, epoch);
}

/**
 * The day a material line's cash goes out ("paid on order"):
 * start of the sprint it feeds, minus `leadWeeks` weeks.
 * @param {Run} run @param {MaterialLine} line @param {string} epoch @returns {Date}
 */
export function materialOrderDate(run, line, epoch) {
  const feeds = posInt(line && line.feedsSprint, 1);
  const lead = Math.max(0, num(line && line.leadWeeks));
  return addDays(sprintStart(num(run.startSprint) + feeds - 1, epoch), -7 * lead);
}

/**
 * The day a client payment lands: 'date' → that date; 'runEnd' → runEndDate;
 * 'beforeStart' → runStartDate − 7·weeks. Unknown/invalid → runEndDate.
 * @param {Run} run @param {PaymentLine} line @param {string} epoch @returns {Date}
 */
export function paymentDate(run, line, epoch) {
  const t = (line && line.timing) || { mode: "runEnd" };
  if (t.mode === "date") {
    const d = parseLocalDate(t.date);
    if (d) return d;
    return runEndDate(run, epoch);
  }
  if (t.mode === "beforeStart") return addDays(runStartDate(run, epoch), -7 * Math.max(0, num(t.weeks)));
  return runEndDate(run, epoch);
}

/* ------------------------------------------------------------------ payments */

export function paymentsTotal(payments) {
  return sumBy(payments, (p) => p.amount);
}

function nonCompletionTotal(payments) {
  return sumBy((payments || []).filter((p) => p.kind !== "completion"), (p) => p.amount);
}

/**
 * The default client schedule (spec §3.2): Deposit = 50% of tolling @ 4 weeks
 * before start · BOM funding = 100% of the materials table @ 4 weeks before
 * start · Completion = value − deposit − bom @ run end. Completion is NOT
 * clamped — a negative remainder is the UI's warning to show.
 * @param {Run} run @param {(prefix: string) => string} newId
 * @returns {PaymentLine[]}
 */
export function defaultPayments(run, newId) {
  const value = num(run.value);
  const deposit = Math.round(0.5 * num(run.tolling));
  const bom = Math.round(materialsTotal(run));
  return [
    { id: newId("p"), kind: "deposit", label: "Deposit", amount: deposit, timing: { mode: "beforeStart", weeks: 4 } },
    { id: newId("p"), kind: "bom", label: "BOM funding", amount: bom, timing: { mode: "beforeStart", weeks: 4 } },
    { id: newId("p"), kind: "completion", label: "Completion", amount: value - deposit - bom, timing: { mode: "runEnd" } },
  ];
}

/**
 * A NEW payments array whose (first) completion line carries
 * `value − Σ non-completion amounts`. Never mutates. If there is no completion
 * line the array is returned as a shallow copy (use ensureCompletion first).
 * @param {Run} run @returns {PaymentLine[]}
 */
export function balancePayments(run) {
  const payments = Array.isArray(run.payments) ? run.payments : [];
  const remainder = num(run.value) - nonCompletionTotal(payments);
  let done = false;
  return payments.map((p) => {
    if (!done && p.kind === "completion") {
      done = true;
      return { ...p, amount: remainder, timing: { mode: "runEnd" } };
    }
    return { ...p };
  });
}

/**
 * Guarantee exactly one completion payment with timing {mode:'runEnd'}.
 * Missing → append one, balanced to `value − Σ others`. Several → keep the
 * first (its amount untouched), drop the rest. Returns a NEW run.
 * @param {Run} run @param {(prefix: string) => string} newId @returns {Run}
 */
export function ensureCompletion(run, newId) {
  const mk = newId || fallbackIdFactory(run.id);
  const payments = Array.isArray(run.payments) ? run.payments : [];
  const out = [];
  let seen = false;
  for (const p of payments) {
    if (p.kind === "completion") {
      if (seen) continue;
      seen = true;
      out.push({ ...p, timing: { mode: "runEnd" } });
    } else out.push({ ...p });
  }
  if (!seen) {
    out.push({
      id: mk("p"),
      kind: "completion",
      label: "Completion",
      amount: num(run.value) - nonCompletionTotal(out),
      timing: { mode: "runEnd" },
    });
  }
  return { ...run, payments: out };
}

/* ------------------------------------------------------------------ run creation */

/**
 * A new run with defaults: startSprint = ctx.originSprint + 1 (unless given),
 * sprints 1, the five standard materials, and the default payment schedule
 * (unless `partial.payments` is supplied, in which case it is only normalised).
 * @param {Partial<Run>} partial
 * @param {(prefix: string) => string} newId
 * @param {{epoch?: string, originSprint: number}} ctx
 * @returns {Run}
 */
export function newRun(partial = {}, newId, ctx = {}) {
  const origin = num(ctx.originSprint);
  const run = {
    id: partial.id != null ? String(partial.id) : newId("run"),
    name: partial.name ?? "New run",
    client: partial.client ?? "",
    color: partial.color ?? PALETTE[0],
    startSprint: partial.startSprint != null ? Math.floor(num(partial.startSprint)) : origin + 1,
    sprints: posInt(partial.sprints, 1),
    value: Math.round(num(partial.value)),
    tolling: Math.round(num(partial.tolling)),
    taxes: Math.round(num(partial.taxes)),
    materials: ensureStandardMaterials(partial.materials || [], newId),
    payments: [],
  };
  if (partial.suiteRunId != null) run.suiteRunId = String(partial.suiteRunId);
  if (partial.hidden != null) run.hidden = !!partial.hidden;
  if (partial.notes != null) run.notes = partial.notes;
  const supplied = Array.isArray(partial.payments) && partial.payments.length > 0;
  run.payments = supplied ? partial.payments.map((p) => ({ ...p })) : defaultPayments(run, newId);
  return ensureCompletion(run, newId);
}

/* ------------------------------------------------------------------ suite (quote) mapping */

/**
 * Pull cost figures from the suite quote into a run WITHOUT clobbering manual
 * edits. Sets value/tolling/taxes; fills Soft goods ← totalIngredientCost,
 * Cans ← rawPackagingCost, Cartons ← bomCost; upserts an extra
 * "Batching / cartoning" line when totalBatchingFees > 0. Lines with
 * source === 'manual' are never overwritten; lines this fills get source 'suite'.
 * Imported/Domestic spirits are left alone. Payments are NOT rebalanced unless
 * the run has none yet (then the default schedule is created). Returns a NEW run.
 *
 * `newId` is optional (the contract signature is two-argument); without it a
 * deterministic `${run.id}:<prefix>N` id is used for any line/payment created.
 * @param {Run} run
 * @param {{totalCost?: number, rawPackagingCost?: number, totalIngredientCost?: number, bomCost?: number, taxCost?: number, totalBatchingFees?: number, tollingCost?: number}} costs
 * @param {(prefix: string) => string} [newId]
 * @returns {Run}
 */
export function applySuiteCosts(run, costs, newId) {
  const c = costs || {};
  const mk = newId || fallbackIdFactory(run.id);
  const fills = {
    "Soft goods": Math.round(num(c.totalIngredientCost)),
    Cans: Math.round(num(c.rawPackagingCost)),
    Cartons: Math.round(num(c.bomCost)),
  };
  const batching = Math.round(num(c.totalBatchingFees));

  let materials = ensureStandardMaterials(run.materials || [], mk).map((l) => {
    const key = Object.keys(fills).find((k) => sameLabel(k, l.label));
    if (key == null || l.source === "manual") return l;
    return { ...l, amount: fills[key], source: "suite" };
  });

  const bIdx = materials.findIndex((l) => !l.standard && sameLabel(l.label, BATCHING_LABEL));
  if (batching > 0) {
    if (bIdx === -1) {
      materials = [
        ...materials,
        newMaterialLine({ label: BATCHING_LABEL, category: "outsourced", leadWeeks: DEFAULT_EXTRA_LEAD, feedsSprint: 1, amount: batching, source: "suite" }, mk),
      ];
    } else if (materials[bIdx].source !== "manual") {
      materials = materials.map((l, i) => (i === bIdx ? { ...l, amount: batching, source: "suite" } : l));
    }
  } else if (bIdx !== -1 && materials[bIdx].source !== "manual") {
    // refresh: the quote no longer carries batching fees — zero the suite-sourced line
    materials = materials.map((l, i) => (i === bIdx ? { ...l, amount: 0, source: "suite" } : l));
  }

  let next = {
    ...run,
    value: Math.round(num(c.totalCost)),
    tolling: Math.round(num(c.tollingCost)),
    taxes: Math.round(num(c.taxCost)),
    materials,
  };
  if (!Array.isArray(run.payments) || run.payments.length === 0) next.payments = defaultPayments(next, mk);
  return ensureCompletion(next, mk);
}

/**
 * A new v3 run from a suite quote. Id = String(suiteRun.id) (stable so
 * re-imports match), colour from PALETTE, staggered start
 * `ctx.originSprint + 1 + (idx % 6)`, one sprint, costs from `applySuiteCosts`,
 * default payment schedule.
 * @param {{id: string|number, name?: string, client?: string}} suiteRun
 * @param {object} costs  computeRunResults(suiteRun).costs
 * @param {number} idx    position in the import batch (stagger + colour)
 * @param {(prefix: string) => string} newId
 * @param {{epoch?: string, originSprint: number}} ctx
 * @returns {Run}
 */
export function quoteToRun(suiteRun, costs, idx, newId, ctx = {}) {
  const i = Math.max(0, Math.floor(num(idx)));
  const id = String(suiteRun.id);
  const base = newRun(
    {
      id,
      suiteRunId: id,
      name: suiteRun.name || suiteRun.client || "Run",
      client: suiteRun.client || "",
      color: PALETTE[i % PALETTE.length],
      startSprint: num(ctx.originSprint) + 1 + (i % 6),
      sprints: 1,
      payments: [],
    },
    newId,
    ctx,
  );
  // applySuiteCosts builds the default schedule (and the completion) when the run has no payments
  return applySuiteCosts({ ...base, payments: [] }, costs, newId);
}

/* ------------------------------------------------------------------ v2 → v3 migration */

/** Label heuristics (spec §7). Case-insensitive substring, first match wins. */
// Label heuristics for v1/v2 events (first match wins). Every 'in' event becomes a
// payment of SOME kind, so those are never reported; only 'out' events that land in a
// generic extra line are reported for review.
const IN_RULES = [
  { re: /deposit|kickoff|kick-off|start receivable|upfront|up-front|signing/i, kind: "deposit" },
  { re: /balance|end receivable|completion|final|end of run/i, kind: "completion" },
  { re: /\bbom\b|material|ingredient|\bcans?\b|tequila|mezcal|\bgns\b|spirit|procure|order|packag|freight/i, kind: "bom" },
];
const OUT_RULES = [
  { re: /\btax|ttb|excise|regulat/i, to: "taxes" },
  { re: /ingredient|flavou?r|concentrate|juice|soft goods/i, to: "Soft goods" },
  { re: /\bcans?\b|packag|closure|\blids?\b/i, to: "Cans" },
  { re: /carton|\bcases?\b|tray|shrink|corrugat/i, to: "Cartons" },
  { re: /tequila|mezcal|\brum\b|import/i, to: "Imported spirits" },
  { re: /\bgns\b|vodka|whisk|bourbon|domestic|neutral spirit/i, to: "Domestic spirits" },
  { re: /freight|shipping|\bbom\b/i, to: "Freight & BOM", extra: true },
  { re: /cartoning|co-?pack|batching|service/i, to: "Batching / cartoning", extra: true },
];

/**
 * Migrate one v1/v2 run (week-indexed Gantt run with `events`) to the v3 shape.
 *
 * - `startSprint = sprintIndex(base + 7·startWeek)`; `sprints = max(1, ceil(duration/2))`.
 * - Event date = `base + 7·((anchor==='start' ? startWeek : startWeek+duration) + offset)`,
 *   or the event's pinned `date` if it carries one.
 * - 'in' events → payments: /deposit/ → deposit @ date; /balance|end receivable|completion|final/
 *   → completion @ runEnd (summed); anything else → progress @ date (reported in `unmapped`).
 * - 'out' events → materials: /ingredient/ → Soft goods; /packag/ → Cans; /carton/ → Cartons;
 *   /freight|bom/ → extra "Freight & BOM"; /tax/ → taxes; anything else → extra line with the
 *   event's label (reported in `unmapped`). Lead weeks are derived so the order date lands on
 *   the event's date (clamped to 0 if the event is after run start), feedsSprint 1, source 'manual'.
 * - `value = Σ in`; `tolling = value − Σ materials − taxes` (may be ≤ 0; kept).
 *
 * Invariant (NO MONEY LOST): Σ in amounts == Σ payment amounts and
 * Σ out amounts == Σ material amounts + taxes.
 * @param {{id: string|number, name?: string, color?: string, startWeek?: number, duration?: number, hidden?: boolean, client?: string, fromQuote?: boolean, suiteRunId?: string, events?: Array<{id?: any, label?: string, dir: 'in'|'out', amount: number, anchor?: 'start'|'end', offset?: number, date?: string}>}} v2run
 * @param {{base: Date, epoch: string, newId: (prefix: string) => string}} ctx
 * @returns {{run: Run, unmapped: Array<{label: string, dir: 'in'|'out', amount: number}>}}
 */
export function migrateRunFromV2(v2run, ctx) {
  const { epoch } = ctx;
  const newId = ctx.newId || fallbackIdFactory(v2run && v2run.id);
  const base = ctx.base instanceof Date ? ctx.base : parseLocalDate(ctx.base);
  const startWeek = Math.floor(num(v2run.startWeek));
  const duration = Math.max(1, Math.floor(num(v2run.duration)) || 1);
  const startSprint = sprintIndex(addDays(base, 7 * startWeek), epoch);
  const sprints = Math.max(1, Math.ceil(duration / 2));
  const runStart = sprintStart(startSprint, epoch);

  const eventDate = (e) => {
    if (e.date) {
      const d = parseLocalDate(e.date);
      if (d) return d;
    }
    const wk = (e.anchor === "end" ? startWeek + duration : startWeek) + Math.floor(num(e.offset));
    return addDays(base, 7 * wk);
  };
  const leadFor = (d) => Math.max(0, Math.round(daysBetween(d, runStart) / 7));

  const materials = standardMaterials(newId);
  const extras = []; // { line }
  const payments = [];
  const unmapped = [];
  let taxes = 0;
  let completionAmt = 0;
  let completionLabel = null;
  let sawCompletion = false;

  // These lines were created inside this function, so mutating them is safe.
  const bumpMaterial = (line, amount, lead) => {
    line.amount += amount;
    // first hit sets the lead; later hits keep whichever orders earliest
    line.leadWeeks = line.source === "manual" ? Math.max(line.leadWeeks, lead) : lead;
    line.source = "manual";
  };
  const upsertExtra = (label, amount, lead) => {
    let line = extras.find((l) => sameLabel(l.label, label));
    if (!line) {
      line = newMaterialLine({ label, standard: false, category: "outsourced", leadWeeks: lead, feedsSprint: 1, amount: 0 }, newId);
      extras.push(line);
    }
    bumpMaterial(line, amount, lead);
  };

  for (const e of v2run.events || []) {
    const amount = Math.round(num(e.amount));
    const label = String(e.label ?? "");
    const d = eventDate(e);
    if (amount === 0) continue; // a $0 event carries no information (v1 placeholders like "Start receivable $0")
    if (e.dir === "in") {
      const rule = IN_RULES.find((r) => r.re.test(label));
      if (rule && rule.kind === "deposit") {
        payments.push({ id: newId("p"), kind: "deposit", label: label || "Deposit", amount, timing: { mode: "date", date: isoLocal(d) } });
      } else if (rule && rule.kind === "completion") {
        sawCompletion = true;
        completionAmt += amount;
        if (completionLabel == null) completionLabel = label || "Completion";
      } else {
        payments.push({ id: newId("p"), kind: rule ? rule.kind : "progress", label: label || "Progress payment", amount, timing: { mode: "date", date: isoLocal(d) } });
      }
    } else {
      const rule = OUT_RULES.find((r) => r.re.test(label));
      const lead = leadFor(d);
      if (rule && rule.to === "taxes") {
        taxes += amount;
      } else if (rule && rule.extra) {
        upsertExtra(rule.to, amount, lead);
      } else if (rule) {
        const std = materials.find((l) => sameLabel(l.label, rule.to));
        bumpMaterial(std, amount, lead);
      } else {
        upsertExtra(label || "Other", amount, lead);
        unmapped.push({ label, dir: "out", amount });
      }
    }
  }
  if (sawCompletion) {
    payments.push({ id: newId("p"), kind: "completion", label: completionLabel || "Completion", amount: completionAmt, timing: { mode: "runEnd" } });
  }

  const allMaterials = [...materials, ...extras];
  const value = sumBy((v2run.events || []).filter((e) => e.dir === "in"), (e) => Math.round(num(e.amount)));
  const tolling = value - sumBy(allMaterials, (l) => l.amount) - taxes;

  const id = String(v2run.id);
  let run = {
    id,
    name: v2run.name ?? "Run",
    client: v2run.client ?? "",
    color: v2run.color || PALETTE[0],
    startSprint,
    sprints,
    value,
    tolling,
    taxes,
    materials: ensureStandardMaterials(allMaterials, newId),
    payments,
  };
  if (v2run.hidden != null) run.hidden = !!v2run.hidden;
  if (v2run.fromQuote) run.suiteRunId = id;
  else if (v2run.suiteRunId != null) run.suiteRunId = String(v2run.suiteRunId);
  if (v2run.notes != null) run.notes = v2run.notes;

  run = ensureCompletion(run, newId); // adds a balanced completion when none was mapped
  return { run, unmapped };
}

/* ------------------------------------------------------------------ coverage */

/**
 * Ordering coverage for a run over material lines with amount > 0:
 * `total` (count), `overdue` (order date before today and status not
 * ordered/linked) and `firstDue` (earliest order date among lines not yet
 * ordered/linked, or null).
 * @param {Run} run @param {string} epoch @param {string} todayIso
 * @returns {{total: number, overdue: MaterialLine[], firstDue: Date|null}}
 */
export function runCoverage(run, epoch, todayIso) {
  const today = parseLocalDate(todayIso);
  const lines = (run.materials || []).filter((l) => num(l.amount) > 0);
  const pending = lines.filter((l) => l.status !== "ordered" && l.status !== "linked");
  const overdue = [];
  let firstDue = null;
  for (const l of pending) {
    const d = materialOrderDate(run, l, epoch);
    if (today && d < today) overdue.push(l);
    if (!firstDue || d < firstDue) firstDue = d;
  }
  return { total: lines.length, overdue, firstDue };
}
