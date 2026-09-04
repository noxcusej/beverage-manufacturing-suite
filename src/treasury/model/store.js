// Store — the v3 persisted shape for Treasury Cockpit v2: ids, canonical signature,
// legacy (v1 flat / v2 scenarios) → v3 migration, defaults normalisation and the
// per-scenario save-merge.
//
// Pure ESM, no React, no external deps. Nothing here reads the clock except
// `newId` (allowed: ids only need to be unique, not reproducible). Migrations take
// `ctx.today` so they are deterministic and testable. Every function returns NEW
// objects and never mutates its inputs. Shapes: src/treasury/CONTRACT.md §1/§5;
// intent: docs/TREASURY_COCKPIT_V2_SPEC.md §7.

import { DEFAULT_EPOCH, sprintIndex, addDays, mondayOf, parseLocalDate, isoLocal } from "./sprints.js";
import { migrateRunFromV2, ensureStandardMaterials, ensureCompletion } from "./runs.js";
import { migrateFixedToBurn, defaultBurnLines } from "./burn.js";

/* ------------------------------------------------------------------ keys */

/** The ONLY key v2 writes to (Supabase app_data / storage namespace). */
export const STORE_KEY = "treasury_cockpit_v3";
/** The v1/v2 blob. READ-ONLY — consulted once, for first-load migration. */
export const LEGACY_KEY = "treasury_cockpit";

/** Defaults shared by migration and normalisation. */
export const DEFAULT_HORIZON_SPRINTS = 13;
export const DEFAULT_OPENING_CASH = 60000;
export const DEFAULT_FLOOR = 25000;

/* ------------------------------------------------------------------ ids */

let _counter = 0;

/**
 * A new string id: `${prefix}_${time36}${counter36}${4 random chars}`.
 * The module-level counter makes ids created in the same millisecond differ; the
 * prefix guarantees an id is never numeric-only, so it can't collide with legacy
 * numeric ids (which migration stringifies as-is).
 * @param {string} [prefix='id']
 * @returns {string}
 */
export function newId(prefix = "id") {
  _counter = (_counter + 1) % 0xffffff;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${prefix}_${Date.now().toString(36)}${_counter.toString(36)}${rand}`;
}

/* ------------------------------------------------------------------ signature */

/**
 * Canonical form for dirty-checking: object keys sorted recursively, every
 * `updatedAt` key dropped (at any depth), arrays keep their order.
 * Identical semantics to v1's `canon`.
 * @param {*} v
 * @returns {*}
 */
export function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .filter((k) => k !== "updatedAt")
      .sort()
      .reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
  }
  return v;
}

/**
 * Content signature of a store — key-order independent, ignores `updatedAt`.
 * @param {*} store
 * @returns {string}
 */
export function storeSig(store) {
  return JSON.stringify(canon(store));
}

/* ------------------------------------------------------------------ predicates / small helpers */

/**
 * True when `raw` already is a v3 store with at least one scenario.
 * @param {*} raw
 * @returns {boolean}
 */
export function isV3(raw) {
  return !!(raw && raw.version === 3 && Array.isArray(raw.scenarios) && raw.scenarios.length > 0);
}

function num(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function numOr(x, fallback) {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function deepCopy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function sameLabel(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** v1 tab names → v3. Only 'fixed' was renamed (→ 'burn'). */
function mapTab(tab) {
  if (tab === "fixed") return "burn";
  return typeof tab === "string" && tab ? tab : "plan";
}

function clampDay(d) {
  const n = Math.floor(num(d, 1));
  return Math.min(28, Math.max(1, n));
}

/* ------------------------------------------------------------------ fresh state */

/**
 * A fresh ScenarioState: defaults, no runs, the nine $0 burn lines.
 * @param {{epoch?: string, newId?: (prefix: string) => string}} [ctx]
 * @returns {import('../CONTRACT.md').ScenarioState}
 */
export function emptyScenarioState(ctx = {}) {
  const mk = ctx.newId || newId;
  return {
    version: 3,
    sprintEpoch: ctx.epoch || DEFAULT_EPOCH,
    horizonSprints: DEFAULT_HORIZON_SPRINTS,
    openingCash: DEFAULT_OPENING_CASH,
    floor: DEFAULT_FLOOR,
    runs: [],
    burn: defaultBurnLines(mk),
    capital: [],
    ap: [],
    manualAdj: {},
    tab: "plan",
    selId: null,
  };
}

/**
 * Wrap a state as a named scenario. `updatedAt` defaults to 0 (the page stamps
 * it on save — this module never reads the clock for data).
 * @param {string} name
 * @param {object} state
 * @param {(prefix: string) => string} [mkId]
 * @param {number} [updatedAt=0]
 * @returns {{id: string, name: string, updatedAt: number, state: object}}
 */
export function newScenario(name, state, mkId, updatedAt = 0) {
  const mk = mkId || newId;
  return { id: mk("sc"), name: name || "Scenario", updatedAt: num(updatedAt), state };
}

/* ------------------------------------------------------------------ legacy → v3 */

/**
 * Wrap a legacy v1 flat blob as a v2 store (same as v1's `migrateStore`, minus the
 * clock: the wrapped scenario gets updatedAt 0 and no id — migration assigns one).
 * Returns null for anything that is not a plain object.
 */
function toV2(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version === 2 && Array.isArray(raw.scenarios) && raw.scenarios.length) return raw;
  if (raw.version === 3) return null; // already v3 — not a legacy blob
  const known = ["openingCash", "floor", "projects", "fixed", "ap", "capital", "tab", "selId", "manualAdj"];
  if (!known.some((k) => k in raw)) return null; // garbage
  const state = {};
  for (const k of known) state[k] = raw[k];
  return { version: 2, activeId: null, scenarios: [{ id: null, name: "Base case", updatedAt: 0, state }] };
}

/**
 * Debt servicing of a v2 capital item → Burn 'Debt service' lines. The v2 engine
 * paid month m (1..n) on the funding day-of-month; we reproduce that as a monthly
 * line bounded [first payment, last payment]. The day is clamped to 1–28 for BOTH
 * dayOfMonth and the bounds, so the first/last landings are never clipped by the
 * bounds (a 31st would otherwise land on the 28th, before `from`).
 * - amortizing: level P&I `amt·r / (1 − (1+r)^−n)` (r = 0 → amt/n), rounded.
 * - interest-only: monthly `amt·r`, plus a one-time balloon (the principal) at maturity.
 */
function debtServiceLines(item, mkId) {
  const amt = num(item.amount);
  const n = Math.floor(num(item.termMonths));
  if (item.type !== "debt" || !item.repay || item.repay === "none" || !(n > 0) || !(amt > 0)) return [];
  const fd = parseLocalDate(item.date);
  if (!fd) return [];
  const r = num(item.rate) / 100 / 12;
  const day = clampDay(fd.getDate());
  const at = (m) => new Date(fd.getFullYear(), fd.getMonth() + m, day);
  const from = isoLocal(at(1));
  const to = isoLocal(at(n));
  const name = item.label || "Loan";
  const out = [];
  if (item.repay === "amortizing") {
    const pmt = r > 0 ? (amt * r) / (1 - Math.pow(1 + r, -n)) : amt / n;
    out.push({ id: mkId("burn"), category: "Debt service", label: `${name} — P&I`, monthly: Math.round(pmt), dayOfMonth: day, cadence: "monthly", from, to,
      notes: `Migrated from v2 capital (${item.repay}, ${num(item.rate)}% / ${n} mo)` });
  } else if (item.repay === "interest-only") {
    const interest = Math.round(amt * r);
    if (interest > 0) {
      out.push({ id: mkId("burn"), category: "Debt service", label: `${name} — interest`, monthly: interest, dayOfMonth: day, cadence: "monthly", from, to,
        notes: `Migrated from v2 capital (interest-only, ${num(item.rate)}% / ${n} mo)` });
    }
    out.push({ id: mkId("burn"), category: "Debt service", label: `${name} — balloon principal`, monthly: Math.round(amt), cadence: "one-time", from: to,
      notes: "Migrated from v2 capital (interest-only maturity)" });
  }
  return out;
}

/**
 * Which migrated material line did a v2 event feed? `migrateRunFromV2` keeps no
 * event→line record, so we ask it directly: migrate a copy of the project holding
 * ONLY that event and read off the single line that received the money (runs.js's
 * own label heuristics decide — nothing is duplicated here), then find the line
 * with that label in the real migrated run. Tax events and 'in' events have no
 * line → undefined. A $0 event falls back to a label-equality match.
 * @returns {string|undefined} the MaterialLine id in `migratedRun`
 */
function resolveLineId(project, event, migratedRun, ctx) {
  if (!event || event.dir === "in") return undefined;
  const probe = migrateRunFromV2({ ...project, events: [event] }, { ...ctx, newId: (p) => `probe:${p}` });
  let target = probe.run.materials.find((l) => l.amount !== 0);
  if (!target && probe.run.taxes !== 0) return undefined; // it was a tax event
  if (!target) target = probe.run.materials.find((l) => sameLabel(l.label, event.label)); // $0 event
  if (!target) return undefined;
  const line = migratedRun.materials.find((l) => sameLabel(l.label, target.label));
  return line ? line.id : undefined;
}

/** Locate the project (and event) a bill's eventId points at. */
function findLegacyEvent(projects, bill) {
  const eid = String(bill.eventId);
  const candidates = bill.runId != null ? projects.filter((p) => String(p.id) === String(bill.runId)) : projects;
  for (const p of candidates) {
    const ev = (p.events || []).find((e) => e && String(e.id) === eid);
    if (ev) return { project: p, event: ev };
  }
  if (bill.runId != null) { // stale runId — fall back to a global scan
    for (const p of projects) {
      const ev = (p.events || []).find((e) => e && String(e.id) === eid);
      if (ev) return { project: p, event: ev };
    }
  }
  return null;
}

/**
 * Migrate one legacy scenario `state` (flat v1/v2 shape) to a v3 ScenarioState.
 * @returns {{ state: object, unmapped: Array<{label: string, dir: string, amount: number, run: string}> }}
 */
function migrateScenarioState(state, ctx) {
  const st = state && typeof state === "object" ? state : {};
  const { epoch, base } = ctx;
  const mkId = ctx.newId;
  const runCtx = { base, epoch, newId: mkId };
  const projects = Array.isArray(st.projects) ? st.projects.filter(Boolean) : [];

  // runs
  const unmapped = [];
  const runs = [];
  const runByProjectId = new Map();
  for (const p of projects) {
    const { run, unmapped: u } = migrateRunFromV2(p, runCtx);
    runs.push(run);
    runByProjectId.set(String(p.id), run);
    for (const x of u) unmapped.push({ ...x, run: run.name });
  }

  // burn = fixed costs + debt servicing lifted out of capital
  const burn = migrateFixedToBurn(Array.isArray(st.fixed) ? st.fixed.filter(Boolean) : [], mkId, { base });
  const capitalSrc = Array.isArray(st.capital) ? st.capital.filter(Boolean) : [];
  for (const c of capitalSrc) burn.push(...debtServiceLines(c, mkId));

  // capital = injections only
  const capital = capitalSrc.map((c) => ({
    id: c.id != null ? String(c.id) : mkId("cap"),
    type: c.type === "debt" ? "debt" : "equity",
    label: c.label || "",
    amount: num(c.amount),
    date: c.date,
  }));

  // bills: eventId → lineId
  const ap = (Array.isArray(st.ap) ? st.ap.filter(Boolean) : []).map((b) => {
    const { eventId, ...rest } = b;
    const bill = { ...rest, id: b.id != null ? String(b.id) : mkId("bill"), runId: b.runId != null ? String(b.runId) : undefined, lineId: undefined };
    if (eventId != null) {
      const hit = findLegacyEvent(projects, b);
      if (hit) {
        const run = runByProjectId.get(String(hit.project.id));
        const lineId = run ? resolveLineId(hit.project, hit.event, run, runCtx) : undefined;
        if (lineId) {
          bill.lineId = lineId;
          if (bill.runId == null || bill.runId !== run.id) bill.runId = run.id; // keep runId consistent with the line's run
        }
      }
    }
    if (bill.runId === undefined) delete bill.runId;
    if (bill.lineId === undefined) delete bill.lineId;
    return bill;
  });

  // manual adjustments: week index (relative to base) → absolute sprint k; sum on collision
  const manualAdj = {};
  for (const [wk, v] of Object.entries(st.manualAdj || {})) {
    const w = Number(wk);
    const amt = num(v);
    if (!Number.isFinite(w) || amt === 0) continue;
    const k = String(sprintIndex(addDays(base, 7 * Math.floor(w)), epoch));
    manualAdj[k] = (manualAdj[k] || 0) + amt;
  }

  return {
    state: {
      version: 3,
      sprintEpoch: epoch,
      horizonSprints: DEFAULT_HORIZON_SPRINTS,
      openingCash: numOr(st.openingCash, DEFAULT_OPENING_CASH),
      floor: numOr(st.floor, DEFAULT_FLOOR),
      runs,
      burn,
      capital,
      ap,
      manualAdj,
      tab: mapTab(st.tab),
      selId: st.selId != null ? String(st.selId) : null,
    },
    unmapped,
  };
}

/**
 * Read-time, non-destructive migration of the legacy blob to a v3 store.
 *
 * Accepts (a) a v2 store `{version:2, activeId, scenarios:[{id,name,group?,notes?,updatedAt,state}]}`,
 * (b) a v1 flat blob `{openingCash, floor, projects, fixed, ap, capital, tab, selId, manualAdj}`
 * (wrapped as one "Base case" scenario first, exactly like v1's `migrateStore`), or
 * (c) null / garbage → `{ store: null, report: [] }`.
 *
 * Per scenario:
 * - `base = mondayOf(ctx.today)`. The v1/v2 week-0 Monday was never persisted: it was
 *   "the Monday of the week the plan was being viewed", recomputed on every load. Using
 *   today's Monday is therefore the documented approximation — a plan last saved N
 *   weeks ago will have its week-indexed dates (run starts, fixed from/to, manualAdj)
 *   shifted forward by N weeks, which is exactly what the legacy app itself did on reload.
 * - runs via `migrateRunFromV2`; its `unmapped` entries are collected into the report.
 * - burn via `migrateFixedToBurn`, plus v2 debt servicing (repay !== 'none') converted
 *   into bounded 'Debt service' lines (level P&I, or interest + one-time balloon).
 *   No default $0 lines are added here (that is for brand-new scenarios).
 * - capital keeps injections only (rate/term/repay dropped — servicing lives in burn now).
 * - bills: `eventId` → `lineId` of the migrated material line (see `resolveLineId`);
 *   unmatched bills stay, unlinked. `eventId` is removed.
 * - manualAdj: week index → absolute sprint k (two weeks per sprint → amounts summed).
 * - the untouched scenario object is kept under `legacyV2` for recovery.
 *
 * @param {*} legacyRaw
 * @param {{epoch: string, today: string, newId?: (prefix: string) => string}} ctx
 * @returns {{store: object|null, report: Array<{scenarioId: string, scenarioName: string, unmapped: Array<{label: string, dir: string, amount: number, run: string}>}>}}
 */
export function migrateLegacyToV3(legacyRaw, ctx = {}) {
  const v2 = toV2(legacyRaw);
  if (!v2) return { store: null, report: [] };
  const epoch = ctx.epoch || DEFAULT_EPOCH;
  const mkId = ctx.newId || newId;
  const today = parseLocalDate(ctx.today) || parseLocalDate(epoch);
  const base = mondayOf(today);
  const sctx = { epoch, base, newId: mkId };

  const report = [];
  const scenarios = [];
  for (const s of v2.scenarios) {
    if (!s || typeof s !== "object") continue;
    const id = s.id != null ? String(s.id) : mkId("sc");
    const { state, unmapped } = migrateScenarioState(s.state, sctx);
    const scenario = { id, name: s.name || "Base case", updatedAt: num(s.updatedAt), state, legacyV2: deepCopy(s) };
    if (s.group != null) scenario.group = s.group;
    if (s.notes != null) scenario.notes = s.notes;
    scenarios.push(scenario);
    report.push({ scenarioId: id, scenarioName: scenario.name, unmapped });
  }
  if (!scenarios.length) return { store: null, report: [] };

  const wanted = v2.activeId != null ? String(v2.activeId) : null;
  const activeId = wanted && scenarios.some((s) => s.id === wanted) ? wanted : scenarios[0].id;
  return { store: { version: 3, activeId, scenarios }, report };
}

/* ------------------------------------------------------------------ normalise */

function normalizeRun(run, mkId) {
  const r = run && typeof run === "object" ? run : {};
  const next = {
    ...r,
    id: r.id != null ? String(r.id) : mkId("run"),
    name: r.name ?? "Run",
    color: r.color || "#586A8C",
    startSprint: Math.floor(num(r.startSprint)),
    sprints: Math.max(1, Math.floor(num(r.sprints, 1)) || 1),
    value: num(r.value),
    tolling: num(r.tolling),
    taxes: num(r.taxes),
    materials: ensureStandardMaterials(r.materials, mkId).map((l) => ({
      ...l,
      status: l.status || "planned",
      feedsSprint: Math.max(1, Math.floor(num(l.feedsSprint, 1)) || 1),
      leadWeeks: Math.max(0, num(l.leadWeeks)),
      amount: num(l.amount),
    })),
    payments: (Array.isArray(r.payments) ? r.payments : []).filter(Boolean).map((p) => ({
      ...p,
      id: p.id != null ? String(p.id) : mkId("p"),
      amount: num(p.amount),
      timing: p.timing && typeof p.timing === "object" ? { ...p.timing } : { mode: "runEnd" },
    })),
  };
  return ensureCompletion(next, mkId);
}

function normalizeState(state, ctx, mkId) {
  const st = state && typeof state === "object" ? state : {};
  const manualAdj = {};
  for (const [k, v] of Object.entries(st.manualAdj || {})) { const n = num(v); if (n) manualAdj[String(k)] = n; }
  return {
    ...st,
    version: 3,
    sprintEpoch: st.sprintEpoch || ctx.epoch || DEFAULT_EPOCH,
    horizonSprints: Math.max(1, Math.floor(num(st.horizonSprints, DEFAULT_HORIZON_SPRINTS)) || DEFAULT_HORIZON_SPRINTS),
    openingCash: numOr(st.openingCash, DEFAULT_OPENING_CASH),
    floor: numOr(st.floor, DEFAULT_FLOOR),
    runs: (Array.isArray(st.runs) ? st.runs : []).filter(Boolean).map((r) => normalizeRun(r, mkId)),
    burn: (Array.isArray(st.burn) ? st.burn : []).filter(Boolean).map((b) => ({ ...b, id: b.id != null ? String(b.id) : mkId("burn"), monthly: num(b.monthly) })),
    capital: (Array.isArray(st.capital) ? st.capital : []).filter(Boolean).map((c) => ({ ...c, id: c.id != null ? String(c.id) : mkId("cap"), amount: num(c.amount) })),
    ap: (Array.isArray(st.ap) ? st.ap : []).filter(Boolean).map((b) => ({ ...b, id: b.id != null ? String(b.id) : mkId("bill"), amount: num(b.amount) })),
    manualAdj,
    tab: typeof st.tab === "string" && st.tab ? st.tab : "plan",
    selId: st.selId != null ? String(st.selId) : null,
  };
}

/**
 * v3 → v3 with every default filled: state version/epoch/horizon, arrays, manualAdj,
 * numeric coercion, the five standard material lines and exactly one completion per
 * run, and a valid activeId. Returns a NEW store; the input is not mutated.
 * Non-v3 input (or an empty scenario list) → `{version:3, activeId:null, scenarios:[]}`.
 * @param {*} raw
 * @param {{epoch?: string, newId?: (prefix: string) => string}} [ctx]
 * @returns {{version: 3, activeId: string|null, scenarios: object[]}}
 */
export function normalizeStore(raw, ctx = {}) {
  const mkId = ctx.newId || newId;
  if (!raw || raw.version !== 3 || !Array.isArray(raw.scenarios)) return { version: 3, activeId: null, scenarios: [] };
  const scenarios = raw.scenarios.filter((s) => s && typeof s === "object").map((s) => {
    const sc = { ...s, id: s.id != null ? String(s.id) : mkId("sc"), name: s.name || "Scenario", updatedAt: num(s.updatedAt), state: normalizeState(s.state, ctx, mkId) };
    if (s.legacyV2 !== undefined) sc.legacyV2 = deepCopy(s.legacyV2);
    return sc;
  });
  const wanted = raw.activeId != null ? String(raw.activeId) : null;
  const activeId = wanted && scenarios.some((s) => s.id === wanted) ? wanted : scenarios.length ? scenarios[0].id : null;
  return { version: 3, activeId, scenarios };
}

/* ------------------------------------------------------------------ save-merge */

/**
 * v1 save-merge semantics, per scenario. Start from `local.scenarios` in local order:
 * the scenario being edited here (`activeId`) is authoritative; every other scenario
 * takes the remote copy when its `updatedAt` is strictly newer, else the local one.
 * Remote-only scenarios (created in another window) are appended. If `remote` is not
 * a v3 store, local is returned unchanged (as a new object).
 * @param {{version: 3, activeId: string, scenarios: object[]}} localStore
 * @param {*} remoteStore
 * @param {string} activeId
 * @returns {{version: 3, activeId: string, scenarios: object[]}}
 */
export function mergeScenarios(localStore, remoteStore, activeId) {
  const local = Array.isArray(localStore && localStore.scenarios) ? localStore.scenarios : [];
  const active = activeId != null ? String(activeId) : localStore && localStore.activeId != null ? String(localStore.activeId) : null;
  if (!isV3(remoteStore)) return { version: 3, activeId: active, scenarios: local.slice() };
  const remoteById = new Map(remoteStore.scenarios.filter(Boolean).map((s) => [String(s.id), s]));
  const localIds = new Set(local.map((s) => String(s.id)));
  const scenarios = local.map((s) => {
    if (String(s.id) === active) return s;
    const r = remoteById.get(String(s.id));
    return r && (r.updatedAt || 0) > (s.updatedAt || 0) ? r : s;
  });
  for (const r of remoteStore.scenarios) if (r && !localIds.has(String(r.id))) scenarios.push(r);
  return { version: 3, activeId: active, scenarios };
}
