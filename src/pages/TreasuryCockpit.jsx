import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { loadAppData, saveAppData } from "../data/supabase";
import { computeRunResults } from "../utils/runResults";
import { exportTreasuryToExcel } from "../utils/exportTreasury";

/* ------------------------------------------------------------------ *
 * Treasury Cockpit
 *  Tab 1 — Run planner: drag production runs, watch the cash floor.
 *  Tab 2 — Fixed costs: recurring weekly burn, with active windows.
 *  Tab 3 — Accounts payable: Xero-bill-shaped sample data.
 *  Tabs 2 & 3 both flow into Tab 1's cash position.
 * ------------------------------------------------------------------ */

const WEEK_W = 46;
const HEADER_H = 46;
const ROW_H = 46;
const NET_H = 104;
const LANE_H = 40;
const CUM_H = 168;
const RAIL_W = 188;

const PALETTE = ["#586A8C", "#8A6D5B", "#5E7A70", "#7E6A86", "#6E7F66", "#8A7B4F"];
const CATS = ["Payroll", "Facilities", "Debt service", "Insurance", "Software", "Utilities", "Other"];
const AP_STATUS = ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED"];

const fmt = (n) => { const s = n < 0 ? "-" : ""; return s + "$" + Math.abs(Math.round(n)).toLocaleString(); };
const fmtK = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; if (a >= 1000) return s + "$" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k"; return s + "$" + Math.round(a); };

function mondayOf(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }
function addWeeks(d, n) { const x = new Date(d); x.setDate(x.getDate() + n * 7); return x; }
const MS_WK = 604800000;
const wkOfDate = (iso, base) => Math.floor((new Date(iso) - base) / MS_WK);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(iso) { const d = new Date(iso); return MON[d.getMonth()] + " " + d.getDate(); }

let _id = 100;
const uid = () => ++_id;

/* ---- sample data builders ---- */
function defaultEvents(rev) {
  return [
    { id: uid(), label: "Start receivable", dir: "in", amount: Math.round(rev * 0.5), anchor: "start", offset: 0 },
    { id: uid(), label: "Packaging", dir: "out", amount: Math.round(rev * 0.18), anchor: "start", offset: 1 },
    { id: uid(), label: "COGS", dir: "out", amount: Math.round(rev * 0.22), anchor: "end", offset: -1 },
    { id: uid(), label: "Cartoning", dir: "out", amount: Math.round(rev * 0.06), anchor: "end", offset: 0 },
    { id: uid(), label: "End receivable", dir: "in", amount: Math.round(rev * 0.5), anchor: "end", offset: 2 },
  ];
}
const SEED_RUNS = [
  { id: 1, name: "Chickie's RTD", color: PALETTE[0], startWeek: 1, duration: 3, events: defaultEvents(120000) },
  { id: 2, name: "Hugo's Cocktails", color: PALETTE[1], startWeek: 5, duration: 4, events: defaultEvents(180000) },
  { id: 3, name: "Top Dog", color: PALETTE[2], startWeek: 11, duration: 2, events: defaultEvents(90000) },
];
const SEED_FIXED = [
  { id: uid(), label: "Production payroll", cat: "Payroll", cadence: "biweekly", amount: 22000, anchorWeek: 0, from: 0, to: null },
  { id: uid(), label: "G&A payroll", cat: "Payroll", cadence: "biweekly", amount: 12000, anchorWeek: 1, from: 0, to: null },
  { id: uid(), label: "Facility lease", cat: "Facilities", cadence: "monthly", amount: 16000, day: 1, from: 0, to: null },
  { id: uid(), label: "Equipment loan", cat: "Debt service", cadence: "monthly", amount: 8000, day: 5, from: 0, to: null },
  { id: uid(), label: "Utilities & water", cat: "Utilities", cadence: "monthly", amount: 7000, day: 10, from: 0, to: null },
  { id: uid(), label: "Insurance (GL / product)", cat: "Insurance", cadence: "monthly", amount: 3000, day: 15, from: 0, to: null },
  { id: uid(), label: "Software & tools", cat: "Software", cadence: "monthly", amount: 1500, day: 20, from: 0, to: null },
];

/* Date helpers, relative to today (used by capital seeds and the AP tab). */
const _t = new Date();
const iso = (daysFromNow) => { const d = new Date(_t); d.setDate(d.getDate() + daysFromNow); return d.toISOString().slice(0, 10); };
const defaultInclude = (s) => s === "AUTHORISED" || s === "SUBMITTED";

const SEED_CAPITAL = [
  { id: uid(), type: "equity", label: "Seed bridge", amount: 150000, date: iso(35), rate: 0, termMonths: 0, repay: "none" },
];

function buildCapital(items, base, horizon) {
  const inW = new Array(horizon).fill(0), outW = new Array(horizon).fill(0);
  const wkOf = (d) => Math.floor((d - base) / MS_WK);
  const perItem = {};
  for (const it of items) {
    const amt = Number(it.amount) || 0;
    const fd = new Date(it.date);
    const fw = wkOf(fd);
    if (fw >= 0 && fw < horizon) inW[fw] += amt;
    let svcWindow = 0;
    if (it.type === "debt" && it.repay && it.repay !== "none" && amt > 0 && it.termMonths > 0) {
      const n = it.termMonths, r = (Number(it.rate) || 0) / 100 / 12;
      const day = fd.getDate(), fY = fd.getFullYear(), fM = fd.getMonth();
      if (it.repay === "amortizing") {
        const pmt = r > 0 ? amt * r / (1 - Math.pow(1 + r, -n)) : amt / n;
        for (let m = 1; m <= n; m++) { const w = wkOf(new Date(fY, fM + m, day)); if (w >= 0 && w < horizon) { outW[w] += pmt; svcWindow += pmt; } }
      } else if (it.repay === "interest-only") {
        const interest = amt * r;
        for (let m = 1; m <= n; m++) { const pay = interest + (m === n ? amt : 0); const w = wkOf(new Date(fY, fM + m, day)); if (w >= 0 && w < horizon) { outW[w] += pay; svcWindow += pay; } }
      }
    }
    perItem[it.id] = { in: amt, svcWindow };
  }
  const totalIn = inW.reduce((s, v) => s + v, 0), totalSvc = outW.reduce((s, v) => s + v, 0);
  return { inW, outW, totalIn, totalSvc, perItem };
}

const weeklyEquiv = (it) => {
  const a = Number(it.amount) || 0;
  switch (it.cadence) {
    case "weekly": return a; case "biweekly": return a / 2;
    case "monthly": return (a * 12) / 52; case "quarterly": return (a * 4) / 52;
    case "annual": return a / 52; default: return 0;
  }
};

function buildFixed(items, base, horizon) {
  const arr = new Array(horizon).fill(0);
  const baseY = base.getFullYear(), baseM = base.getMonth();
  const last = addWeeks(base, horizon - 1);
  const monthsSpan = (last.getFullYear() - baseY) * 12 + (last.getMonth() - baseM) + 1;
  const wkOf = (d) => Math.floor((d - base) / MS_WK);
  const inWin = (it, w) => w >= (it.from || 0) && (it.to == null || it.to === "" || w <= it.to);
  for (const it of items) {
    const amt = Number(it.amount) || 0;
    if (it.cadence === "weekly") { for (let i = 0; i < horizon; i++) if (inWin(it, i)) arr[i] += amt; }
    else if (it.cadence === "biweekly") { const a = Math.max(0, it.anchorWeek || 0); for (let i = a; i < horizon; i += 2) if (inWin(it, i)) arr[i] += amt; }
    else if (it.cadence === "one-time") { const w = it.week || 0; if (w >= 0 && w < horizon && inWin(it, w)) arr[w] += amt; }
    else {
      const step = it.cadence === "monthly" ? 1 : it.cadence === "quarterly" ? 3 : 12;
      const day = Math.min(Math.max(1, it.day || 1), 28);
      for (let m = 0; m < monthsSpan; m += step) { const w = wkOf(new Date(baseY, baseM + m, day)); if (w >= 0 && w < horizon && inWin(it, w)) arr[w] += amt; }
    }
  }
  return arr;
}

const defaultPayISO = (b, base) => { const due = new Date(b.dueDate); return (due < base ? base : due).toISOString().slice(0, 10); };
const apPayDate = (b, base, evDates) => b.payDate || (b.eventId && evDates && evDates[b.eventId]) || defaultPayISO(b, base);
const apPayWeek = (b, base, evDates) => Math.max(0, wkOfDate(apPayDate(b, base, evDates), base));
function buildAP(bills, base, horizon, evDates) {
  const arr = new Array(horizon).fill(0);
  let total = 0;
  for (const b of bills) {
    if (!(b.include ?? defaultInclude(b.status))) continue;
    total += b.amount;
    const w = apPayWeek(b, base, evDates);
    if (w >= 0 && w < horizon) arr[w] += b.amount;
  }
  return { arr, total };
}

/* ---- Xero AP import ----
 * Xero owns the bill facts; the cockpit keeps a local planning layer on top
 * (include override, payDate, runId, eventId). Bills are matched across syncs by
 * their Xero InvoiceID so re-importing refreshes the facts without clobbering the
 * user's planning edits. The live feed isn't wired yet — `importXeroBills` reads a
 * mapped snapshot from the Supabase `xero_bills` key (to be populated by the Xero
 * connector / a backend sync); the mapping + merge below are the durable part. */
const XERO_SNAPSHOT_KEY = "xero_bills";
function xeroDate(d) {
  if (!d) return "";
  const m = /\/Date\((\d+)/.exec(String(d)); // Xero sometimes returns /Date(ms+0000)/
  const dt = m ? new Date(Number(m[1])) : new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
}
/* Map one Xero ACCPAY invoice to the cockpit's bill facts (AmountDue, not Total,
   so partial payments are reflected). Returns facts only — no local id. */
function mapXeroBill(inv) {
  return {
    xeroId: inv.InvoiceID || inv.invoiceID || inv.id,
    vendor: inv.Contact?.Name || inv.contact?.name || "(unknown vendor)",
    ref: inv.Reference || inv.InvoiceNumber || inv.reference || "",
    billDate: xeroDate(inv.Date || inv.date),
    dueDate: xeroDate(inv.DueDate || inv.dueDate) || xeroDate(inv.Date || inv.date),
    amount: Number(inv.AmountDue ?? inv.amountDue ?? inv.Total ?? 0),
    status: inv.Status || inv.status || "AUTHORISED",
  };
}
/* Merge mapped Xero facts into the current AP list: refresh facts on bills already
   linked by xeroId (keeping include/payDate/runId/eventId), append the rest. */
function mergeXeroBills(current, facts) {
  const byXero = new Map(facts.map((f) => [f.xeroId, f]));
  const seen = new Set();
  const merged = current.map((b) => {
    if (b.xeroId && byXero.has(b.xeroId)) {
      seen.add(b.xeroId);
      const f = byXero.get(b.xeroId);
      return { ...b, vendor: f.vendor, ref: f.ref, billDate: f.billDate, dueDate: f.dueDate, amount: f.amount, status: f.status };
    }
    return b;
  });
  for (const f of facts) if (f.xeroId && !seen.has(f.xeroId)) merged.push({ id: uid(), include: defaultInclude(f.status), ...f });
  return { merged, added: facts.filter((f) => f.xeroId && !seen.has(f.xeroId)).length, updated: seen.size };
}

/* ---- Quote → cash-timed run (Phase 2) ----
 * A suite "run" is a co-packing quote (no schedule). We roll it up with the suite's
 * own computeRunResults so the numbers match the quoting screen, then itemize it into
 * cash events — the model the user chose ("quote in, pass-throughs out, tolling = margin"):
 *   IN  — Client deposit (50% of the full quote at start) + Client balance (50% on completion)
 *   OUT — each pass-through cost as its own line: Ingredients, Packaging, Freight & BOM,
 *         Taxes & regulatory, Batching (BOM lands 100% at start; taxes at completion)
 * Tolling isn't a separate line — it's the residual margin (net = quote − pass-throughs).
 * Material out-lines are budget; link the real Xero AP bills to them (Budget vs actuals)
 * to retime/replace without double-counting. Schedule is local to the cockpit. */
function quoteEvents(run) {
  let c = { totalCost: 0, rawPackagingCost: 0, totalIngredientCost: 0, bomCost: 0, taxCost: 0, totalBatchingFees: 0 };
  try { c = computeRunResults(run).costs; } catch { /* malformed quote — fall through with zeros */ }
  const total = Math.round(c.totalCost || 0);
  const dep = Math.round(total / 2);
  const out = (key, label, amt, anchor, offset) => ({ id: run.id + ":" + key, label, dir: "out", amount: Math.round(amt || 0), anchor, offset, auto: true });
  const evs = [
    { id: run.id + ":dep", label: "Client deposit", dir: "in", amount: dep, anchor: "start", offset: 0, auto: true },
    { id: run.id + ":bal", label: "Client balance", dir: "in", amount: total - dep, anchor: "end", offset: 0, auto: true },
    out("ingredients", "Ingredients", c.totalIngredientCost, "start", 0),
    out("packaging", "Packaging", c.rawPackagingCost, "start", 1),
    out("bom", "Freight & BOM", c.bomCost, "start", 0),
    out("tax", "Taxes & regulatory", c.taxCost, "end", 0),
    out("batching", "Batching", c.totalBatchingFees, "start", 0),
  ];
  // keep the receivable lines always; drop zero-value cost lines
  return evs.filter((e) => e.dir === "in" || e.amount > 0);
}
/* one-quote rollup for the picker UI (units/cases/total/tolling margin) */
function quoteSummary(run) {
  try { const r = computeRunResults(run); return { units: r.counts.totalUnits || 0, cases: r.counts.totalCases || 0, total: r.costs.totalCost || 0, tolling: r.costs.tollingCost || 0 }; }
  catch { return { units: 0, cases: 0, total: 0, tolling: 0 }; }
}
function quoteToProject(run, idx) {
  return {
    id: run.id, // stable Xero/suite id so re-import matches
    name: run.name || run.client || "Run",
    color: PALETTE[idx % PALETTE.length],
    startWeek: 2 + (idx % 12), // staggered default; quote has no schedule — drag to set
    duration: 3,
    fromQuote: true,
    client: run.client || "",
    events: quoteEvents(run),
  };
}
/* Merge derived quote-runs into the cockpit. Existing runs (matched by id) keep
   their local schedule/color/manual events; only the auto Tolling/BOM amounts are
   refreshed. New runs are appended. */
function mergeQuoteRuns(current, runs) {
  const byId = new Map(runs.map((r, i) => [r.id, { run: r, idx: i }]));
  const seen = new Set();
  const merged = current.map((p) => {
    if (!byId.has(p.id)) return p;
    seen.add(p.id);
    const fresh = quoteEvents(byId.get(p.id).run);
    const freshById = Object.fromEntries(fresh.map((e) => [e.id, e]));
    // refresh auto events in place, keep manual ones, add any new auto events
    const kept = p.events.map((e) => (e.auto && freshById[e.id] ? { ...e, amount: freshById[e.id].amount } : e));
    const keptIds = new Set(kept.map((e) => e.id));
    for (const e of fresh) if (!keptIds.has(e.id)) kept.push(e);
    return { ...p, name: byId.get(p.id).run.name || p.name, fromQuote: true, events: kept };
  });
  let added = 0;
  runs.forEach((r, i) => { if (!seen.has(r.id)) { merged.push(quoteToProject(r, i)); added++; } });
  return { merged, added, updated: seen.size };
}

/* ---- persistence (Supabase app_data) ---- *
 * Phase 1 of the merge into the beverage suite: the cockpit's own plan is stored as
 * a single namespaced JSONB blob through the suite's Supabase store (same generic
 * app_data table every other domain uses). Same data shape as the prior localStorage
 * layer, just async. Runs/events/bills/capital carry numeric ids from the module-level
 * uid() counter (which resets on reload), so after loading we bump `_id` past the
 * highest saved id to keep new ids collision-free. The suite's own `runs` domain is
 * left untouched here — pointing the Gantt at it is Phase 2. */
const STORE_KEY = "treasury_cockpit";
/* AP starts empty — real bills come from Xero via "Import from Xero" on the AP tab. */
function seedAP() { return []; }
/* A scenario = a named full-plan snapshot. We keep ONE Supabase row and evolve its
   shape to v2 { version, activeId, scenarios:[{id,name,updatedAt,state}] } where
   `state` is the exact flat snapshot persisted before. Migration is a read-time wrap:
   a legacy flat blob becomes a single "Base case" scenario, its bytes preserved
   verbatim, so the first v2 save loses nothing. */
function migrateStore(raw) {
  if (raw && raw.version === 2 && Array.isArray(raw.scenarios) && raw.scenarios.length) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const state = { openingCash: raw.openingCash, floor: raw.floor, projects: raw.projects, fixed: raw.fixed, ap: raw.ap, capital: raw.capital, tab: raw.tab, selId: raw.selId };
    return { version: 2, activeId: null, scenarios: [{ id: null, name: "Base case", updatedAt: Date.now(), state }] }; // id assigned after bumpIdsAll
  }
  return null;
}
/* Bump the uid() counter past every id in EVERY scenario (projects/fixed/ap/capital
   and the scenario ids themselves) so new ids never collide across forks. */
function bumpIdsAll(store) {
  let maxId = _id;
  const scan = (arr) => { if (!Array.isArray(arr)) return; for (const x of arr) { if (x && typeof x.id === "number") maxId = Math.max(maxId, x.id); if (x && Array.isArray(x.events)) scan(x.events); } };
  for (const sc of (store.scenarios || [])) {
    if (typeof sc.id === "number") maxId = Math.max(maxId, sc.id);
    const st = sc.state || {};
    scan(st.projects); scan(st.fixed); scan(st.ap); scan(st.capital);
  }
  _id = maxId;
}

export default function TreasuryCockpit() {
  const [base] = useState(() => mondayOf(new Date()));
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState("plan");
  const [openingCash, setOpeningCash] = useState(60000);
  const [floor, setFloor] = useState(25000);
  const [projects, setProjects] = useState(SEED_RUNS);
  const [fixed, setFixed] = useState(SEED_FIXED);
  const [ap, setAp] = useState(seedAP);
  const [selId, setSelId] = useState(1);
  const [drag, setDrag] = useState(null);
  const [capital, setCapital] = useState(SEED_CAPITAL);
  // scenarios: state is authoritative for INACTIVE scenarios; the active scenario's
  // truth is the live flat state above, folded in at save/switch time.
  const [scenarios, setScenarios] = useState([]); // [{id,name,updatedAt,state}]
  const [activeId, setActiveId] = useState(null);
  const [scenarioPickerOpen, setScenarioPickerOpen] = useState(false);

  /* standalone window — give it its own document title */
  useEffect(() => { const prev = document.title; document.title = "Treasury Cockpit"; return () => { document.title = prev; }; }, []);

  /* set the live flat state from a scenario snapshot (same per-field guards as before) */
  const applyState = useCallback((st) => {
    if (!st) return;
    if (Array.isArray(st.projects)) setProjects(st.projects);
    if (Array.isArray(st.fixed)) setFixed(st.fixed);
    if (Array.isArray(st.ap)) setAp(st.ap);
    if (Array.isArray(st.capital)) setCapital(st.capital);
    if (typeof st.openingCash === "number") setOpeningCash(st.openingCash);
    if (typeof st.floor === "number") setFloor(st.floor);
    if (typeof st.tab === "string") setTab(st.tab);
    if (st.selId != null) setSelId(st.selId);
  }, []);

  /* hydrate scenarios from Supabase once on mount; a legacy flat blob → "Base case" */
  useEffect(() => {
    let alive = true;
    (async () => {
      const store = migrateStore(await loadAppData(STORE_KEY));
      if (alive && store) {
        bumpIdsAll(store);
        for (const sc of store.scenarios) if (sc.id == null) sc.id = uid(); // assign Base-case id past all state ids
        if (store.activeId == null || !store.scenarios.some((s) => s.id === store.activeId)) store.activeId = store.scenarios[0].id;
        setScenarios(store.scenarios);
        setActiveId(store.activeId);
        applyState(store.scenarios.find((s) => s.id === store.activeId).state);
      }
      if (alive) setHydrated(true);
    })();
    return () => { alive = false; };
  }, [applyState]);

  /* write-through (debounced): fold the live snapshot into the active scenario and
     persist the whole v2 store as a single row. Never setScenarios here (self-loop). */
  const saveTimer = useRef(null);
  const latest = useRef(null);
  useEffect(() => {
    if (!hydrated || activeId == null) return;
    const state = { openingCash, floor, projects, fixed, ap, capital, tab, selId };
    const list = scenarios.length ? scenarios : [{ id: activeId, name: "Base case", updatedAt: Date.now(), state }];
    const merged = list.map((s) => (s.id === activeId ? { ...s, state, updatedAt: Date.now() } : s));
    latest.current = { version: 2, activeId, scenarios: merged };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveAppData(STORE_KEY, latest.current), 600);
  }, [hydrated, activeId, scenarios, openingCash, floor, projects, fixed, ap, capital, tab, selId]);
  /* flush any pending save when leaving the page so the last edit isn't lost */
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); if (latest.current) saveAppData(STORE_KEY, latest.current); } }, []);

  /* ---- scenario handlers ---- */
  const activeName = (scenarios.find((s) => s.id === activeId) || {}).name || "Base case";
  const switchScenario = (id) => {
    if (id === activeId) return;
    const outgoing = { openingCash, floor, projects, fixed, ap, capital, tab, selId };
    const list = scenarios.map((s) => (s.id === activeId ? { ...s, state: outgoing, updatedAt: Date.now() } : s));
    const target = list.find((s) => s.id === id);
    if (!target) return;
    setScenarios(list);
    applyState(target.state);
    setActiveId(id);
  };
  const saveAsScenario = (name) => {
    const id = uid();
    const state = { openingCash, floor, projects, fixed, ap, capital, tab, selId };
    setScenarios((prev) => [
      ...prev.map((s) => (s.id === activeId ? { ...s, state: { ...state }, updatedAt: Date.now() } : s)),
      { id, name: (name && name.trim()) || "Untitled scenario", updatedAt: Date.now(), state },
    ]);
    setActiveId(id); // fork becomes active; live state already equals the fork
  };
  const renameScenario = (id, name) => setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, name: (name && name.trim()) || s.name, updatedAt: Date.now() } : s)));
  const deleteScenario = (id) => {
    setScenarios((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) { const nid = uid(); const st = { openingCash, floor, projects, fixed, ap, capital, tab, selId }; setActiveId(nid); return [{ id: nid, name: "Base case", updatedAt: Date.now(), state: st }]; }
      if (id === activeId) { const next = remaining[0]; applyState(next.state); setActiveId(next.id); }
      return remaining;
    });
  };

  /* merge a user-selected set of quotes (from the picker) into the planner;
     re-import refreshes amounts but keeps local schedules/edits */
  const addQuoteRuns = (selectedRuns) => {
    if (!Array.isArray(selectedRuns) || selectedRuns.length === 0) return { added: 0, updated: 0 };
    const { merged, added, updated } = mergeQuoteRuns(projects, selectedRuns);
    setProjects(merged);
    return { added, updated };
  };

  const evWeek = (p, e) => (e.anchor === "start" ? p.startWeek : p.startWeek + p.duration) + e.offset;

  /* eventId -> ISO date the budgeted line lands (week start, not before today) */
  const eventDateMap = useMemo(() => {
    const m = {};
    for (const p of projects) for (const e of p.events) { const d = addWeeks(base, evWeek(p, e)); m[e.id] = (d < base ? base : d).toISOString().slice(0, 10); }
    return m;
  }, [projects, base]);

  const horizon = useMemo(() => {
    let max = 20;
    for (const p of projects) { max = Math.max(max, p.startWeek + p.duration + 1); for (const e of p.events) max = Math.max(max, evWeek(p, e) + 2); }
    for (const b of ap) { if (b.include ?? defaultInclude(b.status)) max = Math.max(max, apPayWeek(b, base, eventDateMap) + 2); }
    return Math.min(max, 80);
  }, [projects, ap, base, eventDateMap]);
  const TL_W = horizon * WEEK_W;

  const fixedW = useMemo(() => buildFixed(fixed, base, horizon), [fixed, base, horizon]);
  const weeklyBurn = useMemo(() => fixed.reduce((s, it) => s + weeklyEquiv(it), 0), [fixed]);
  const apB = useMemo(() => buildAP(ap, base, horizon, eventDateMap), [ap, base, horizon, eventDateMap]);
  const capB = useMemo(() => buildCapital(capital, base, horizon), [capital, base, horizon]);

  const calc = useMemo(() => {
    /* sum of included bills linked to each budget event */
    const billedByEvent = {};
    for (const b of ap) { if ((b.include ?? defaultInclude(b.status)) && b.eventId) billedByEvent[b.eventId] = (billedByEvent[b.eventId] || 0) + b.amount; }
    const inW = new Array(horizon).fill(0), outW = new Array(horizon).fill(0);
    let totalIn = 0, totalOut = 0; const perProject = {};
    for (const p of projects) {
      let net = 0;
      for (const e of p.events) {
        const w = evWeek(p, e), within = w >= 0 && w < horizon;
        if (e.dir === "in") {
          net += e.amount;
          /* a hidden run is excluded from the position entirely (scenario toggle),
             but we still tally its standalone net so the rail can show what it would add */
          if (!p.hidden) { totalIn += e.amount; if (within) inW[w] += e.amount; }
        } else {
          net -= e.amount;
          if (!p.hidden) {
            totalOut += e.amount;
            /* actual linked bills replace the budgeted estimate; only the un-billed
               remainder of the budget still projects as expected cash at its planned week */
            const remaining = Math.max(0, e.amount - (billedByEvent[e.id] || 0));
            if (within) outW[w] += remaining;
          }
        }
      }
      perProject[p.id] = net;
    }
    const net = inW.map((v, i) => v + capB.inW[i] - outW[i] - fixedW[i] - apB.arr[i] - capB.outW[i]);
    const cum = []; let run = openingCash;
    for (let i = 0; i < horizon; i++) { run += net[i]; cum.push(run); }
    let troughI = 0, trough = cum[0] ?? openingCash;
    cum.forEach((v, i) => { if (v < trough) { trough = v; troughI = i; } });
    const totalFixed = fixedW.reduce((s, v) => s + v, 0);
    const totalAP = apB.arr.reduce((s, v) => s + v, 0);
    return { inW, outW, net, cum, totalIn, totalOut, totalFixed, totalAP, totalCapIn: capB.totalIn, totalCapSvc: capB.totalSvc, billedByEvent, perProject, trough, troughI, ending: cum[horizon - 1] ?? openingCash };
  }, [projects, ap, fixedW, apB, capB, openingCash, horizon]);

  /* capital injection markers for the position chart */
  const capMarks = useMemo(() => {
    const wkOf = (d) => Math.floor((new Date(d) - base) / MS_WK);
    return capital.map((c) => ({ week: wkOf(c.date), label: c.label, amount: Number(c.amount) || 0, type: c.type })).filter((m) => m.week >= 0 && m.week < horizon);
  }, [capital, base, horizon]);

  /* drag */
  const onDown = (e, p, mode) => { e.preventDefault(); e.stopPropagation(); setSelId(p.id); setDrag({ id: p.id, mode, x0: e.clientX, sw: p.startWeek, du: p.duration }); };
  const onMove = useCallback((e) => {
    setDrag((d) => {
      if (!d) return d;
      const dw = Math.round((e.clientX - d.x0) / WEEK_W);
      setProjects((ps) => ps.map((p) => {
        if (p.id !== d.id) return p;
        if (d.mode === "move") return { ...p, startWeek: Math.max(0, d.sw + dw) };
        if (d.mode === "start") { const ns = Math.max(0, Math.min(d.sw + dw, d.sw + d.du - 1)); return { ...p, startWeek: ns, duration: d.du + (d.sw - ns) }; }
        if (d.mode === "end") return { ...p, duration: Math.max(1, d.du + dw) };
        return p;
      }));
      return d;
    });
  }, []);
  const onUp = useCallback(() => setDrag(null), []);
  useEffect(() => {
    if (!drag) return;
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag, onMove, onUp]);

  const sel = projects.find((p) => p.id === selId) || null;
  const patch = (id, fn) => setProjects((ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  const toggleHide = (id) => patch(id, (p) => ({ ...p, hidden: !p.hidden }));
  const addProject = () => { const id = uid(); setProjects((ps) => [...ps, { id, name: "New run", color: PALETTE[ps.length % PALETTE.length], startWeek: 2, duration: 3, events: defaultEvents(100000) }]); setSelId(id); };
  const dupProject = (p) => { const id = uid(); setProjects((ps) => [...ps, { ...p, id, name: p.name + " (copy)", startWeek: p.startWeek + p.duration + 1, events: p.events.map((e) => ({ ...e, id: uid() })) }]); setSelId(id); };
  const delProject = (id) => {
    const evIds = new Set((projects.find((p) => p.id === id)?.events || []).map((e) => e.id));
    setAp((xs) => xs.map((b) => (evIds.has(b.eventId) ? { ...b, runId: null, eventId: null } : b)));
    setProjects((ps) => ps.filter((p) => p.id !== id));
    setSelId((s) => (s === id ? null : s));
  };
  const linkBill = (billId, runId, eventId) => setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, runId, eventId, include: true } : b)));
  const unlinkBill = (billId) => setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, runId: null, eventId: null } : b)));
  const setPayDate = (billId, isoOrNull) => setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, payDate: isoOrNull } : b)));
  const removeEvent = (runId, eventId) => { patch(runId, (p) => ({ ...p, events: p.events.filter((x) => x.id !== eventId) })); setAp((xs) => xs.map((b) => (b.eventId === eventId ? { ...b, runId: null, eventId: null } : b))); };

  const bands = useMemo(() => {
    const out = []; let i = 0;
    while (i < horizon) { const d = addWeeks(base, i), m = d.getMonth(); let j = i; while (j < horizon && addWeeks(base, j).getMonth() === m) j++; out.push({ label: MON[m] + " " + String(d.getFullYear()).slice(2), start: i, span: j - i }); i = j; }
    return out;
  }, [horizon, base]);

  const maxNet = Math.max(1, ...calc.net.map((v) => Math.abs(v)));
  const maxLane = Math.max(1, ...fixedW.map((v, i) => v + apB.arr[i]));
  const cumLoD = Math.min(0, floor, openingCash, ...calc.cum);
  const cumHiD = Math.max(openingCash, floor, ...calc.cum, 1);
  const pad = (cumHiD - cumLoD) * 0.12 || 1000;
  const cumLo = cumLoD - pad, cumHi = cumHiD + pad;
  const cumY = (v) => CUM_H - ((v - cumLo) / (cumHi - cumLo)) * CUM_H;
  const cumPts = calc.cum.map((v, i) => [i * WEEK_W + WEEK_W / 2, cumY(v)]);
  const cumPath = cumPts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
  const breach = calc.cum.some((v) => v < floor);

  /* wait for the saved plan to load before showing editable fields, so edits made in
     the first few hundred ms aren't clobbered when the async hydrate resolves */
  if (!hydrated) {
    return <div className="tcockpit" style={{ padding: "40px 22px", color: "var(--muted)", fontSize: 13 }}>Loading your cash plan…</div>;
  }

  return (
    <div className="tcockpit" style={{ background: "var(--canvas)", color: "var(--ink)" }}>
      <style>{`
        .tcockpit{--canvas:#F4F2EC;--panel:#FFFFFF;--ink:#1B1F24;--muted:#727880;--line:#E4E0D6;--line2:#EDEAE2;--in:#1F7A6B;--out:#B14A3B;--pos:#34468A;--danger:#C0392B;--chip:#F0EDE4;--fixed:#9A6B5E;--ap:#5F6B78;--cap:#6D5B8A;width:100%;min-height:100vh}
        .tcockpit *{box-sizing:border-box}
        .tcockpit .tc{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
        .tcockpit .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum";font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
        .tcockpit .eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:10px;color:var(--muted);font-weight:600}
        .tcockpit .card{background:var(--panel);border:1px solid var(--line);border-radius:10px}
        .tcockpit .btn{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 11px;font-size:13px;cursor:pointer;color:var(--ink);transition:background .12s,border-color .12s}
        .tcockpit .btn:hover{background:var(--chip);border-color:#d8d3c6}
        .tcockpit .btn-x{border:none;background:transparent;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:6px}
        .tcockpit .btn-x:hover{background:var(--chip);color:var(--danger)}
        .tcockpit .inp{border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:13px;background:#fff;width:100%}
        .tcockpit .inp:focus{outline:2px solid #c9d2e6;outline-offset:-1px;border-color:#b9c2da}
        .tcockpit .sel{border:1px solid var(--line);border-radius:7px;padding:5px 6px;font-size:13px;background:#fff}
        .tcockpit .barlabel{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .tcockpit .handle{position:absolute;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:3}
        .tcockpit .gridline{position:absolute;top:0;bottom:0;width:1px;background:var(--line2)}
        .tcockpit .th{font-size:11px;color:var(--muted);font-weight:600}
        .tcockpit tr.evrow td{padding:4px 6px;border-top:1px solid var(--line2);vertical-align:middle}
        .tcockpit .tabbar{display:inline-flex;background:var(--chip);border:1px solid var(--line);border-radius:9px;padding:3px}
        .tcockpit .tabbtn{border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer}
        .tcockpit .tabbtn.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06)}
        .tcockpit .tag{display:inline-block;font-size:9.5px;padding:1px 6px;border-radius:5px;font-weight:700;letter-spacing:.03em}
        .tcockpit .late{color:var(--danger);font-size:9.5px;font-weight:700;margin-left:5px}
        @media (prefers-reduced-motion: reduce){.tcockpit *{transition:none!important}}
      `}</style>

      <div className="tc" style={{ maxWidth: 1240, margin: "0 auto", padding: "26px 22px 60px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div className="eyebrow">Production cash timing</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: "4px 0 0", letterSpacing: "-0.02em" }}>Treasury Cockpit</h1>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 3 }}>
              {tab === "plan" ? "Drag a run to reschedule. Position nets runs, fixed costs, bills and capital."
                : tab === "fixed" ? "Recurring outflows with active windows. These feed the run planner."
                : tab === "ap" ? "Bills payable (sample, Xero-shaped). Due amounts feed the run planner."
                : tab === "capital" ? "Equity and debt injections that lift the cash position; debt can carry servicing."
                : "Every cash line in one grid for fast edits, with the weekly cash-flow statement below."}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
            <div className="tabbar">
              <button className={"tabbtn" + (tab === "plan" ? " on" : "")} onClick={() => setTab("plan")}>Run planner</button>
              <button className={"tabbtn" + (tab === "fixed" ? " on" : "")} onClick={() => setTab("fixed")}>Fixed costs</button>
              <button className={"tabbtn" + (tab === "ap" ? " on" : "")} onClick={() => setTab("ap")}>Accounts payable</button>
              <button className={"tabbtn" + (tab === "capital" ? " on" : "")} onClick={() => setTab("capital")}>Capital</button>
              <button className={"tabbtn" + (tab === "sheet" ? " on" : "")} onClick={() => setTab("sheet")}>Spreadsheet</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
              <button className="btn" style={{ fontSize: 12, padding: "5px 10px", fontWeight: 600 }} title="Switch, save, rename, or delete budget scenarios" onClick={() => setScenarioPickerOpen(true)}>📁 {activeName} ▾</button>
              <span title="Your plan is saved to the cloud (Supabase) and restored on every device">auto-saved</span>
            </div>
          </div>
        </div>

        {scenarioPickerOpen && (
          <ScenarioPicker
            scenarios={scenarios} activeId={activeId}
            onClose={() => setScenarioPickerOpen(false)}
            onSwitch={(id) => { switchScenario(id); setScenarioPickerOpen(false); }}
            onSaveAs={(name) => { saveAsScenario(name); setScenarioPickerOpen(false); }}
            onRename={renameScenario}
            onDelete={deleteScenario}
          />
        )}

        {tab === "plan" && (
          <PlanTab {...{ openingCash, setOpeningCash, floor, setFloor, calc, base, breach, weeklyBurn,
            projects, selId, setSelId, sel, patch, addProject, dupProject, delProject, toggleHide, addQuoteRuns, onDown, evWeek,
            ap, linkBill, unlinkBill, removeEvent, eventDateMap, setPayDate, capMarks, capInW: capB.inW, capOutW: capB.outW,
            horizon, TL_W, bands, fixedW, apArr: apB.arr, maxNet, maxLane, cumY, cumPts, cumPath,
            floorY: cumY(floor), openingY: cumY(openingCash), zeroVisible: cumLo < 0 && cumHi > 0, zeroY: cumY(0) }} />
        )}
        {tab === "fixed" && <FixedTab {...{ fixed, setFixed, base, horizon, fixedW, weeklyBurn, bands, TL_W }} />}
        {tab === "ap" && <APTab {...{ ap, setAp, base, horizon, apTotalWindow: calc.totalAP, cum: calc.cum, floor, openingCash, apArr: apB.arr, bands, TL_W, projects, unlinkBill, eventDateMap, capMarks }} />}
        {tab === "capital" && <CapitalTab {...{ capital, setCapital, base, horizon, capB, cum: calc.cum, floor, openingCash, bands, TL_W, capMarks }} />}
        {tab === "sheet" && <SheetTab {...{ projects, setProjects, fixed, setFixed, ap, setAp, capital, setCapital,
          openingCash, setOpeningCash, floor, setFloor, base, horizon, evWeek, eventDateMap, calc, fixedW,
          apArr: apB.arr, capInW: capB.inW, capOutW: capB.outW }} />}
      </div>
    </div>
  );
}

/* ---- Optimize run timing ----
 * Re-times runs (shifts startWeek — the same lever as dragging) to push the first
 * floor breach as late as possible, then deepen the trough. Pure hill-climb over
 * the very same cash math the board displays (fixed costs / AP / capital held
 * constant; hidden runs skipped; the model's overlap freedom is allowed). */
function evDatesOf(projects, base, evWeek) {
  const m = {};
  for (const p of projects) for (const e of p.events) { const d = addWeeks(base, evWeek(p, e)); m[e.id] = (d < base ? base : d).toISOString().slice(0, 10); }
  return m;
}
function simulatePosition(projects, ctx) {
  const { ap, fixedW, capInW, capOutW, base, horizon, openingCash, floor, evWeek } = ctx;
  const apB = buildAP(ap, base, horizon, evDatesOf(projects, base, evWeek));
  const billed = {};
  for (const b of ap) if ((b.include ?? defaultInclude(b.status)) && b.eventId) billed[b.eventId] = (billed[b.eventId] || 0) + b.amount;
  const inW = new Array(horizon).fill(0), outW = new Array(horizon).fill(0);
  for (const p of projects) {
    if (p.hidden) continue;
    for (const e of p.events) {
      const w = evWeek(p, e); if (w < 0 || w >= horizon) continue;
      if (e.dir === "in") inW[w] += e.amount;
      else outW[w] += Math.max(0, e.amount - (billed[e.id] || 0));
    }
  }
  let run = openingCash, firstBreach = horizon, trough = Infinity;
  for (let i = 0; i < horizon; i++) {
    run += inW[i] + capInW[i] - outW[i] - fixedW[i] - apB.arr[i] - capOutW[i];
    if (run < trough) trough = run;
    if (run < floor && firstBreach === horizon) firstBreach = i;
  }
  return { firstBreach, trough, ending: run };
}
// latest start that still keeps every one of a run's events inside the horizon, so
// "optimize" re-times runs rather than shoving their receivables off the board
function maxStartFor(p, horizon) {
  let rel = 0;
  for (const e of (p.events || [])) rel = Math.max(rel, (e.anchor === "end" ? (p.duration || 0) : 0) + (Number(e.offset) || 0));
  return Math.max(0, horizon - 1 - rel);
}
function optimizeTiming(ctx) {
  const { projects, horizon } = ctx;
  // Constraint: only care about staying green THROUGH targetWeek (default = whole
  // horizon). Capping the objective there stops the optimizer over-rescheduling
  // past the date the user actually needs to cover.
  const target = ctx.targetWeek == null ? horizon : Math.max(0, Math.min(horizon, ctx.targetWeek));
  const cap = (s) => Math.min(s.firstBreach, target + 1); // green through target = max
  // Only move a run if it pushes the first dip later (toward the target). Once the
  // target is met — or no move extends green — leave the schedule alone. Honors
  // "optimize for green to X, not entirely": no marginal reshuffling past the goal.
  const better = (a, b) => cap(a) > cap(b);
  let cur = projects.map((p) => ({ ...p }));
  let curScore = simulatePosition(cur, ctx);
  const before = curScore;
  let improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let r = 0; r < cur.length; r++) {
      if (cur[r].hidden || !cur[r].events || !cur[r].events.length) continue;
      const maxW = maxStartFor(cur[r], horizon);
      let bestW = cur[r].startWeek, bestScore = curScore;
      for (let w = 0; w <= maxW; w++) {
        if (w === cur[r].startWeek) continue;
        const trial = cur.slice(); trial[r] = { ...cur[r], startWeek: w };
        const s = simulatePosition(trial, ctx);
        if (better(s, bestScore)) { bestScore = s; bestW = w; }
      }
      if (bestW !== cur[r].startWeek) { cur = cur.slice(); cur[r] = { ...cur[r], startWeek: bestW }; curScore = bestScore; improved = true; }
    }
  }
  const moves = [];
  projects.forEach((p, i) => { if (cur[i].startWeek !== p.startWeek) moves.push({ id: p.id, name: p.name, from: p.startWeek, to: cur[i].startWeek }); });
  return { moves, before, after: curScore, target, reachedTarget: curScore.firstBreach > target };
}

/* Scenario picker modal — switch / save-as / rename / delete budget scenarios.
   Modeled on QuotePicker (same overlay/card/.tag conventions). */
function ScenarioPicker({ scenarios, activeId, onClose, onSwitch, onSaveAs, onRename, onDelete }) {
  const [newName, setNewName] = useState("");
  const fmtWhen = (ts) => { if (!ts) return ""; const d = new Date(ts); return MON[d.getMonth()] + " " + d.getDate(); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,22,26,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 96vw)", maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="eyebrow">Budget scenarios</span>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>click a scenario to switch</span>
          <button className="btn-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {scenarios.map((s) => {
            const active = s.id === activeId;
            return (
              <div key={s.id} onClick={() => onSwitch(s.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--line2)", cursor: "pointer", background: active ? "#F1EFE7" : "transparent" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                {active && <span className="tag" style={{ color: "#1f5e54", background: "#dcefe9" }}>active</span>}
                <span style={{ fontSize: 11, color: "var(--muted)" }}>updated {fmtWhen(s.updatedAt)}</span>
                <div style={{ flex: 1 }} />
                <button className="btn-x" style={{ fontSize: 11 }} title="Rename" onClick={(e) => { e.stopPropagation(); const n = window.prompt("Rename scenario:", s.name); if (n) onRename(s.id, n); }}>Rename</button>
                {scenarios.length > 1 && <button className="btn-x" style={{ fontSize: 11 }} title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm('Delete scenario "' + s.name + '"? This can\'t be undone.')) onDelete(s.id); }}>Delete</button>}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <input className="inp" placeholder="New scenario name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) onSaveAs(newName.trim()); }} style={{ flex: 1 }} />
          <button className="btn" disabled={!newName.trim()} style={{ fontWeight: 600, opacity: newName.trim() ? 1 : 0.5 }} onClick={() => newName.trim() && onSaveAs(newName.trim())} title="Fork the current plan into a new named scenario">+ Save current as new</button>
        </div>
      </div>
    </div>
  );
}

/* Quote picker modal — choose which co-packing quotes to bring onto the Gantt. */
function QuotePicker({ existingIds, onClose, onImport }) {
  const [quotes, setQuotes] = useState(null); // null = loading
  const [sel, setSel] = useState(() => new Set());
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => { const r = await loadAppData("runs"); if (alive) setQuotes(Array.isArray(r) ? r : []); })();
    return () => { alive = false; };
  }, []);
  const rows = useMemo(() => (quotes || []).map((run) => ({ run, ...quoteSummary(run) })), [quotes]);
  const ql = q.toLowerCase();
  const filtered = rows.filter((r) => !q || (r.run.name || "").toLowerCase().includes(ql) || (r.run.client || "").toLowerCase().includes(ql));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allShown = filtered.length > 0 && filtered.every((r) => sel.has(r.run.id));
  const toggleAll = () => setSel((s) => { const n = new Set(s); filtered.forEach((r) => allShown ? n.delete(r.run.id) : n.add(r.run.id)); return n; });
  const doImport = () => onImport((quotes || []).filter((run) => sel.has(run.id)));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,22,26,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(740px, 96vw)", maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="eyebrow">Import runs from quoting</span>
          <input className="inp" placeholder="Search name or client…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220, marginLeft: "auto" }} />
          <button className="btn-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {quotes === null ? (
            <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Loading quotes…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>No quotes found in Run Quoting yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr>
                <th style={{ padding: "6px 10px", textAlign: "left" }}><input type="checkbox" checked={allShown} onChange={toggleAll} title="Select all shown" /></th>
                {["Run", "Client", "Cases", "Quote", "Tolling (margin)"].map((h, i) => (<th key={i} className="th" style={{ textAlign: i >= 2 ? "right" : "left", padding: "6px 10px", fontWeight: 600 }}>{h}</th>))}
              </tr></thead>
              <tbody>
                {filtered.map(({ run, cases, total, tolling }) => {
                  const on = sel.has(run.id);
                  return (
                    <tr key={run.id} className="evrow" style={{ cursor: "pointer", background: on ? "#F1EFE7" : "transparent" }} onClick={() => toggle(run.id)}>
                      <td style={{ padding: "5px 10px" }}><input type="checkbox" checked={on} onChange={() => toggle(run.id)} onClick={(e) => e.stopPropagation()} /></td>
                      <td style={{ padding: "5px 10px" }}>{run.name || "(unnamed)"} {existingIds.has(run.id) && <span className="tag" style={{ color: "#5a5f66", background: "var(--chip)" }}>on board</span>}</td>
                      <td style={{ padding: "5px 10px", color: "var(--muted)" }}>{run.client || "—"}</td>
                      <td className="num" style={{ padding: "5px 10px", textAlign: "right" }}>{cases ? cases.toLocaleString() : "—"}</td>
                      <td className="num" style={{ padding: "5px 10px", textAlign: "right" }}>{fmt(total)}</td>
                      <td className="num" style={{ padding: "5px 10px", textAlign: "right", color: "var(--in)" }}>{fmt(tolling)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{sel.size} selected</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={sel.size === 0} onClick={doImport} style={{ fontWeight: 600, opacity: sel.size === 0 ? 0.5 : 1 }}>Import {sel.size || ""} run{sel.size === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}

/* =====================  TAB 1  ===================== */
function PlanTab(props) {
  const { openingCash, setOpeningCash, floor, setFloor, calc, base, breach, weeklyBurn,
    projects, selId, setSelId, sel, patch, addProject, dupProject, delProject, toggleHide, addQuoteRuns, onDown, evWeek,
    ap, linkBill, unlinkBill, removeEvent, eventDateMap, setPayDate, capMarks, capInW, capOutW,
    horizon, TL_W, bands, fixedW, apArr, maxNet, maxLane, cumY, cumPts, cumPath, floorY, openingY, zeroVisible, zeroY } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [runMsg, setRunMsg] = useState("");
  const [opt, setOpt] = useState(null); // { moves, before, after, target, reachedTarget, applied }
  const [greenUntil, setGreenUntil] = useState(() => addWeeks(base, 12).toISOString().slice(0, 10));
  const tgtLabel = (iso) => { const [, m, d] = (iso || "").split("-").map(Number); return m ? MON[m - 1] + " " + d : iso; }; // local, no TZ shift
  const runOptimize = () => {
    const targetWeek = Math.max(0, Math.min(horizon, wkOfDate(greenUntil, base))); // green THROUGH the week containing the target date
    const res = optimizeTiming({ projects, ap, fixedW, capInW, capOutW, base, horizon, openingCash, floor, evWeek, targetWeek });
    setOpt({ ...res, applied: false });
  };
  const applyOptimize = () => { opt.moves.forEach((m) => patch(m.id, (p) => ({ ...p, startWeek: m.to }))); setOpt((o) => ({ ...o, applied: true })); };
  const undoOptimize = () => { opt.moves.forEach((m) => patch(m.id, (p) => ({ ...p, startWeek: m.from }))); setOpt(null); };
  const breachLabel = (fb) => (fb >= horizon ? "no dip (full horizon)" : "week of " + dateLabel(base, fb));
  return (
    <>
      <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
        <Field label="Opening cash" value={openingCash} onChange={setOpeningCash} />
        <Field label="Cash floor" value={floor} onChange={setFloor} hint="min you'll tolerate" />
        <div className="card" style={{ padding: "7px 11px" }}><div className="eyebrow">Fixed burn / wk</div><div className="num" style={{ fontSize: 16, fontWeight: 700, color: "var(--fixed)", marginTop: 4 }}>{fmt(weeklyBurn)}</div></div>
      </div>

      <div style={{ marginTop: 14 }}>
        <WeeklyCashFlow {...{ calc, fixedW, apArr, capInW, capOutW, base, horizon, floor, openingCash }} />
      </div>

      {breach && (
        <div style={{ marginTop: 12, border: "1px solid #e6c4bd", background: "#fbeeea", color: "#8f3322", borderRadius: 9, padding: "9px 13px", fontSize: 13 }}>
          <b>Cash floor breached.</b> Position drops to {fmt(calc.trough)} the week of {dateLabel(base, calc.troughI)}, below your {fmt(floor)} floor. Slide a deposit earlier, push a run, stretch a bill's pay week, or trim fixed burn.
        </div>
      )}

      <div className="card" style={{ marginTop: 16, overflow: "hidden" }}>
        <div style={{ display: "flex" }}>
          <div style={{ width: RAIL_W, flex: "0 0 " + RAIL_W + "px", borderRight: "1px solid var(--line)", background: "#FBFAF6" }}>
            <div style={{ height: HEADER_H, borderBottom: "1px solid var(--line)", display: "flex", alignItems: "flex-end", padding: "0 12px 6px" }}><span className="eyebrow">Runs</span></div>
            {projects.map((p) => (
              <div key={p.id} onClick={() => setSelId(p.id)} style={{ height: ROW_H, borderBottom: "1px solid var(--line2)", padding: "0 6px 0 12px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: p.id === selId ? "#F1EFE7" : "transparent" }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flex: "0 0 auto", opacity: p.hidden ? 0.4 : 1 }} />
                <span className="barlabel" style={{ flex: 1, color: p.hidden ? "var(--muted)" : "inherit", textDecoration: p.hidden ? "line-through" : "none" }}>{p.name}</span>
                <span className="num" style={{ fontSize: 11, color: p.hidden ? "var(--muted)" : (calc.perProject[p.id] >= 0 ? "var(--in)" : "var(--out)") }}>{fmtK(calc.perProject[p.id])}</span>
                <button className="btn-x" title={p.hidden ? "Hidden from cash position — click to show" : "Hide from cash position"} onClick={(ev) => { ev.stopPropagation(); toggleHide(p.id); }} style={{ padding: "0 3px", flex: "0 0 auto", display: "flex", alignItems: "center", color: p.hidden ? "var(--muted)" : "var(--ink)" }}>{p.hidden ? <EyeOff /> : <EyeOn />}</button>
              </div>
            ))}
            <div style={{ height: NET_H, borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "10px 12px" }}>
              <div className="eyebrow">Net / week</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}><span style={{ color: "var(--in)" }}>▲</span> receivables in<br /><span style={{ color: "var(--out)" }}>▼</span> run payments out</div>
            </div>
            <div style={{ height: LANE_H, borderBottom: "1px solid var(--line)", padding: "0 12px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 3 }}>
              <span className="eyebrow">Fixed + bills / wk</span>
              <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--muted)" }}>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--fixed)", marginRight: 3 }} />fixed</span>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--ap)", marginRight: 3 }} />bills</span>
              </div>
            </div>
            <div style={{ height: CUM_H, padding: "10px 12px" }}>
              <div className="eyebrow">Cash position</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, color: "var(--muted)" }}><span style={{ width: 16, height: 2, background: "var(--pos)" }} /> running balance</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: "var(--muted)" }}><span style={{ width: 16, height: 0, borderTop: "2px dashed var(--danger)" }} /> floor {fmtK(floor)}</div>
            </div>
          </div>

          <div style={{ overflowX: "auto", flex: 1 }}>
            <div style={{ width: TL_W, position: "relative" }}>
              <div style={{ height: HEADER_H, borderBottom: "1px solid var(--line)", position: "relative" }}>
                {bands.map((b, i) => (<div key={i} style={{ position: "absolute", left: b.start * WEEK_W, width: b.span * WEEK_W, top: 0, height: 20, borderRight: "1px solid var(--line)", padding: "3px 7px" }}><span className="th" style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase" }}>{b.label}</span></div>))}
                {Array.from({ length: horizon }).map((_, i) => (<div key={i} style={{ position: "absolute", left: i * WEEK_W, top: 22, width: WEEK_W, height: 24, borderRight: "1px solid var(--line2)", textAlign: "center", paddingTop: 4 }}><span className="th num">{dateLabel(base, i, true)}</span></div>))}
              </div>

              <div style={{ position: "relative" }}>
                {Array.from({ length: horizon }).map((_, i) => (<div key={i} className="gridline" style={{ left: (i + 1) * WEEK_W - 1 }} />))}
                {projects.map((p) => (
                  <div key={p.id} style={{ height: ROW_H, borderBottom: "1px solid var(--line2)", position: "relative" }} onClick={() => setSelId(p.id)}>
                    <div onMouseDown={(e) => onDown(e, p, "move")} style={{ position: "absolute", left: p.startWeek * WEEK_W + 2, width: p.duration * WEEK_W - 4, top: 7, height: 22, borderRadius: 6, cursor: "grab", background: hexA(p.color, 0.16), border: "1px " + (p.hidden ? "dashed" : "solid") + " " + hexA(p.color, 0.55), opacity: p.hidden ? 0.45 : 1, boxShadow: p.id === selId ? "0 0 0 2px " + hexA(p.color, 0.35) : "none", display: "flex", alignItems: "center", padding: "0 8px", overflow: "hidden" }}>
                      <span style={{ width: 6, height: 6, borderRadius: 2, background: p.color, marginRight: 6, flex: "0 0 auto" }} />
                      <span className="barlabel" style={{ color: "#2a2f35" }}>{p.name}</span>
                      <div className="handle" style={{ left: -1 }} onMouseDown={(e) => onDown(e, p, "start")} />
                      <div className="handle" style={{ right: -1 }} onMouseDown={(e) => onDown(e, p, "end")} />
                    </div>
                    {!p.hidden && p.events.map((e) => { const w = evWeek(p, e); if (w < 0 || w >= horizon) return null; return (<span key={e.id} style={{ position: "absolute", left: w * WEEK_W + WEEK_W / 2, bottom: 2, transform: "translateX(-50%)", fontSize: 9, color: e.dir === "in" ? "var(--in)" : "var(--out)", zIndex: 2 }} title={e.label + "  " + (e.dir === "in" ? "+" : "-") + fmt(e.amount) + "  ·  " + dateLabel(base, w)}>{e.dir === "in" ? "▲" : "▼"}</span>); })}
                  </div>
                ))}
              </div>

              <div style={{ height: NET_H, borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", position: "relative" }}>
                <svg width={TL_W} height={NET_H} style={{ display: "block" }}>
                  <line x1={0} y1={NET_H / 2} x2={TL_W} y2={NET_H / 2} stroke="var(--line)" />
                  {calc.net.map((v, i) => {
                    const h = (Math.abs(v) / maxNet) * (NET_H / 2 - 8), x = i * WEEK_W + 7, w = WEEK_W - 14, up = v >= 0;
                    return (<g key={i}><rect x={x} y={up ? NET_H / 2 - h : NET_H / 2} width={w} height={Math.max(h, v === 0 ? 0 : 1)} fill={up ? "var(--in)" : "var(--out)"} opacity={0.85} rx={2} />{v !== 0 && (<text x={x + w / 2} y={up ? NET_H / 2 - h - 3 : NET_H / 2 + h + 9} textAnchor="middle" fontSize="8.5" fill={up ? "var(--in)" : "var(--out)"} className="num">{fmtK(v)}</text>)}</g>);
                  })}
                </svg>
              </div>

              {/* fixed + bills lane (stacked) */}
              <div style={{ height: LANE_H, borderBottom: "1px solid var(--line)", position: "relative" }}>
                <svg width={TL_W} height={LANE_H} style={{ display: "block" }}>
                  {fixedW.map((fv, i) => {
                    const av = apArr[i], tot = fv + av; if (tot <= 0) return null;
                    const usable = LANE_H - 8, x = i * WEEK_W + 9, w = WEEK_W - 18;
                    const hf = (fv / maxLane) * usable, ha = (av / maxLane) * usable;
                    return (<g key={i}>
                      <rect x={x} y={4} width={w} height={Math.max(hf, fv > 0 ? 1 : 0)} fill="var(--fixed)" opacity={0.6} rx={1}><title>{dateLabel(base, i) + "  fixed " + fmt(fv)}</title></rect>
                      <rect x={x} y={4 + hf} width={w} height={Math.max(ha, av > 0 ? 1 : 0)} fill="var(--ap)" opacity={0.65} rx={1}><title>{dateLabel(base, i) + "  bills " + fmt(av)}</title></rect>
                    </g>);
                  })}
                </svg>
              </div>

              <div style={{ height: CUM_H, position: "relative" }}>
                <svg width={TL_W} height={CUM_H} style={{ display: "block" }}>
                  {breach && (<rect x={0} y={floorY} width={TL_W} height={Math.max(0, CUM_H - floorY)} fill="#C0392B" opacity={0.06} />)}
                  {zeroVisible && (<line x1={0} y1={zeroY} x2={TL_W} y2={zeroY} stroke="var(--line)" />)}
                  <line x1={0} y1={floorY} x2={TL_W} y2={floorY} stroke="var(--danger)" strokeWidth="1.4" strokeDasharray="5 4" opacity={0.8} />
                  {capMarks.map((m, i) => { const x = m.week * WEEK_W + WEEK_W / 2; const col = m.type === "equity" ? "var(--in)" : "var(--cap)"; return (<g key={i}><line x1={x} y1={0} x2={x} y2={CUM_H} stroke={col} strokeWidth="1.2" strokeDasharray="2 3" opacity={0.7} /><polygon points={(x - 4) + ",2 " + (x + 4) + ",2 " + x + ",9"} fill={col} /><text x={x} y={CUM_H - 4} textAnchor="middle" fontSize="8.5" className="num" fill={col}>+{fmtK(m.amount)}</text></g>); })}
                  <line x1={0} y1={openingY} x2={WEEK_W / 2} y2={openingY} stroke="var(--pos)" strokeWidth="2" />
                  <path d={cumPath} fill="none" stroke="var(--pos)" strokeWidth="2.2" />
                  {cumPts.map((pt, i) => (<circle key={i} cx={pt[0]} cy={pt[1]} r={2} fill={calc.cum[i] < floor ? "var(--danger)" : "var(--pos)"} />))}
                  <circle cx={cumPts[calc.troughI][0]} cy={cumPts[calc.troughI][1]} r={4.5} fill="none" stroke={calc.trough < floor ? "var(--danger)" : "var(--pos)"} strokeWidth="2" />
                  <text x={cumPts[calc.troughI][0]} y={cumY(calc.trough) - 9} textAnchor="middle" fontSize="9.5" className="num" fill={calc.trough < floor ? "var(--danger)" : "var(--pos)"}>floor {fmtK(calc.trough)}</text>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" onClick={addProject}>+ Add run</button>
        {sel && <button className="btn" onClick={() => dupProject(sel)}>Duplicate "{sel.name}"</button>}
        <button className="btn" title="Choose which co-packing quotes to bring onto the Gantt" onClick={() => setPickerOpen(true)}>↓ Import runs from quoting…</button>
        <span style={{ width: 1, height: 22, background: "var(--line)", margin: "0 2px" }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
          keep green until
          <input className="inp num" type="date" value={greenUntil} min={base.toISOString().slice(0, 10)} onChange={(e) => setGreenUntil(e.target.value)} style={{ width: 150 }} />
        </label>
        <button className="btn" title="Re-time runs to keep the position above the floor through the target date" onClick={runOptimize} style={{ fontWeight: 600 }}>✨ Optimize timing</button>
        {runMsg && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{runMsg}</span>}
      </div>

      {opt && (
        <div className="card" style={{ marginTop: 12, padding: "11px 14px", borderColor: opt.reachedTarget ? "#cdd8c9" : "#e6c4bd", background: opt.reachedTarget ? "#f3f6ee" : "#fbeeea" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="eyebrow" style={{ color: opt.reachedTarget ? "var(--in)" : "var(--danger)" }}>
              {opt.reachedTarget ? "✓ Green through " + tgtLabel(greenUntil) : "✗ Can't stay green to " + tgtLabel(greenUntil)}{opt.applied ? " · applied" : ""}
            </span>
            <span style={{ fontSize: 13 }}>
              First floor dip: <b>{breachLabel(opt.before.firstBreach)}</b> → <b style={{ color: opt.after.firstBreach > opt.before.firstBreach ? "var(--in)" : "var(--ink)" }}>{breachLabel(opt.after.firstBreach)}</b>
              {opt.after.firstBreach > opt.before.firstBreach && <span style={{ color: "var(--in)" }}> (+{opt.after.firstBreach - opt.before.firstBreach} wks)</span>}
              <span style={{ color: "var(--muted)" }}> · {opt.moves.length ? opt.moves.length + " run" + (opt.moves.length === 1 ? "" : "s") + " moved" : "no changes needed"}</span>
            </span>
            <div style={{ flex: 1 }} />
            {opt.moves.length > 0 && !opt.applied && (<><button className="btn" onClick={applyOptimize} style={{ fontWeight: 600 }}>Apply</button><button className="btn-x" onClick={() => setOpt(null)}>Cancel</button></>)}
            {opt.moves.length > 0 && opt.applied && (<button className="btn" onClick={undoOptimize}>↺ Undo</button>)}
            {opt.moves.length === 0 && (<button className="btn-x" onClick={() => setOpt(null)}>Dismiss</button>)}
          </div>
          {!opt.reachedTarget && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#8f3322" }}>Re-timing alone can't cover the target — that points to missing <b>cash-in</b> (no sales/receivables loaded yet) or a need for capital, not a scheduling fix.</div>
          )}
          {opt.moves.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "2px 16px" }}>
              {opt.moves.map((m) => (<span key={m.id} className="num" style={{ fontSize: 11.5, color: "var(--muted)" }}>{m.name}: {dateLabel(base, m.from)} → <span style={{ color: "var(--ink)" }}>{dateLabel(base, m.to)}</span></span>))}
            </div>
          )}
        </div>
      )}
      {pickerOpen && (
        <QuotePicker
          existingIds={new Set(projects.map((p) => p.id))}
          onClose={() => setPickerOpen(false)}
          onImport={(selected) => { const r = addQuoteRuns(selected); setRunMsg(`Imported ${r.added} new, ${r.updated} updated from quoting.`); setPickerOpen(false); }}
        />
      )}

      {sel && (
        <div className="card" style={{ marginTop: 14, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: sel.color }} />
            <input className="inp" style={{ width: 220, fontWeight: 600 }} value={sel.name} onChange={(e) => patch(sel.id, (p) => ({ ...p, name: e.target.value }))} />
            <Mini label="Start week" value={sel.startWeek} min={0} onChange={(v) => patch(sel.id, (p) => ({ ...p, startWeek: Math.max(0, v) }))} />
            <Mini label="Duration (wks)" value={sel.duration} min={1} onChange={(v) => patch(sel.id, (p) => ({ ...p, duration: Math.max(1, v) }))} />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{dateLabel(base, sel.startWeek)} → {dateLabel(base, sel.startWeek + sel.duration)}</span>
            {sel.hidden && <span className="tag" style={{ color: "#7a5d2e", background: "#f3ead6" }}>hidden · excluded from position</span>}
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={() => toggleHide(sel.id)} title="Toggle whether this run feeds the cash position">{sel.hidden ? "👁 Show in budget" : "🚫 Hide from budget"}</button>
            <button className="btn-x" onClick={() => delProject(sel.id)}>Remove run</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 14 }}>
            <thead><tr>{["Cash event", "Direction", "Amount", "Anchor", "Offset (wks)", "Lands", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 2 ? "right" : "left", padding: "0 6px 6px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
            <tbody>
              {sel.events.map((e) => {
                const w = evWeek(sel, e);
                const setE = (k, val) => patch(sel.id, (p) => ({ ...p, events: p.events.map((x) => x.id === e.id ? { ...x, [k]: val } : x) }));
                return (<tr key={e.id} className="evrow">
                  <td><input className="inp" value={e.label} onChange={(ev) => setE("label", ev.target.value)} /></td>
                  <td><select className="sel" value={e.dir} onChange={(ev) => setE("dir", ev.target.value)}><option value="in">In ▲</option><option value="out">Out ▼</option></select></td>
                  <td style={{ textAlign: "right" }}><NumberInput value={e.amount} onChange={(v) => setE("amount", v)} className="inp num" style={{ width: 110, textAlign: "right" }} /></td>
                  <td><select className="sel" value={e.anchor} onChange={(ev) => setE("anchor", ev.target.value)}><option value="start">Start</option><option value="end">End</option></select></td>
                  <td><NumberInput value={e.offset} onChange={(v) => setE("offset", v)} integer className="inp num" style={{ width: 64 }} /></td>
                  <td className="num" style={{ fontSize: 12, color: w < 0 || w >= horizon ? "var(--muted)" : "var(--ink)" }}>{dateLabel(base, w)}</td>
                  <td><button className="btn-x" onClick={() => removeEvent(sel.id, e.id)}>✕</button></td>
                </tr>);
              })}
            </tbody>
          </table>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => patch(sel.id, (p) => ({ ...p, events: [...p.events, { id: uid(), label: "New event", dir: "out", amount: 10000, anchor: "start", offset: 0 }] }))}>+ Add cash event</button>
        </div>
      )}

      {sel && <BudgetActuals {...{ sel, ap, base, billedByEvent: calc.billedByEvent, linkBill, unlinkBill, eventDateMap, setPayDate }} />}

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        Position nets run receivables and payables, <span style={{ color: "var(--fixed)" }}>fixed overhead</span>, and <span style={{ color: "var(--ap)" }}>bills due</span> from accounts payable. The stacked lane shows the non-run drain each week.
      </div>
    </>
  );
}

function BudgetActuals({ sel, ap, base, billedByEvent, linkBill, unlinkBill, eventDateMap, setPayDate }) {
  const outEvents = sel.events.filter((e) => e.dir === "out");
  const unlinked = ap.filter((b) => !b.eventId);
  const minISO = base.toISOString().slice(0, 10);
  if (!outEvents.length) return null;
  return (
    <div className="card" style={{ marginTop: 14, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="eyebrow">Budget vs actuals · {sel.name}</span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>linked bills inherit the budget date; override the pay date right here</span>
      </div>
      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {outEvents.map((e) => {
          const budget = e.amount, billed = billedByEvent[e.id] || 0;
          const remaining = Math.max(0, budget - billed), variance = billed - budget;
          const linked = ap.filter((b) => b.eventId === e.id);
          const budgetISO = eventDateMap[e.id];
          return (
            <div key={e.id} style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "11px 13px", background: "#FBFAF6" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{e.label}</span>
                <span className="num" style={{ fontSize: 12, color: "var(--muted)" }}>budget {fmt(budget)} · {fmtDate(budgetISO)}</span>
                <span className="num" style={{ fontSize: 12, color: "var(--ap)" }}>billed {fmt(billed)}</span>
                <span className="num" style={{ fontSize: 12, color: "var(--muted)" }}>remaining {fmt(remaining)}</span>
                {billed !== 0 && (<span className="tag" style={{ color: variance > 0 ? "#8a3a2e" : "#1f5e54", background: variance > 0 ? "#f4ddd6" : "#dcefe9" }}>{variance > 0 ? "+" + fmt(variance) + " over" : fmt(-variance) + " under"}</span>)}
              </div>
              {linked.length > 0 && (
                <div style={{ marginTop: 9, display: "grid", gap: 6 }}>
                  {linked.map((b) => {
                    const on = b.include ?? defaultInclude(b.status);
                    const eff = apPayDate(b, base, eventDateMap);
                    const overridden = !!b.payDate;
                    const late = new Date(eff) > new Date(b.dueDate);
                    return (
                      <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, padding: "6px 8px", border: "1px solid var(--line2)", borderRadius: 7, background: "#fff", opacity: on ? 1 : 0.5 }}>
                        <span style={{ fontWeight: 600 }}>{b.vendor}</span>
                        <span className="num" style={{ color: "var(--muted)" }}>{fmt(b.amount)}</span>
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>due {fmtDate(b.dueDate)}</span>
                        <div style={{ flex: 1 }} />
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
                          pay
                          <input className="inp num" style={{ width: 144 }} type="date" min={minISO} value={eff} onChange={(ev) => setPayDate(b.id, ev.target.value || null)} />
                        </label>
                        {overridden
                          ? <button className="btn-x" style={{ fontSize: 11 }} title={"reset to budget date (" + fmtDate(budgetISO) + ")"} onClick={() => setPayDate(b.id, null)}>↺ budget</button>
                          : <span className="tag" style={{ color: "#5a5f66", background: "var(--chip)" }}>budget date</span>}
                        {late && <span className="late" title="paying after due date">late</span>}
                        <button className="btn-x" title="Unlink" onClick={() => unlinkBill(b.id)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ marginTop: 9 }}>
                <select className="sel" value="" onChange={(ev) => { if (ev.target.value) linkBill(Number(ev.target.value), sel.id, e.id); }}>
                  <option value="">+ Link a bill…</option>
                  {unlinked.map((b) => <option key={b.id} value={b.id}>{b.vendor} · {fmt(b.amount)} · due {fmtDate(b.dueDate)}</option>)}
                </select>
                {unlinked.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>all bills linked</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =====================  TAB 2  ===================== */
function FixedTab({ fixed, setFixed, base, horizon, fixedW, weeklyBurn, bands, TL_W }) {
  const setIt = (id, k, val) => setFixed((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const add = () => setFixed((xs) => [...xs, { id: uid(), label: "New cost", cat: "Other", cadence: "monthly", amount: 5000, day: 1, from: 0, to: null }]);
  const del = (id) => setFixed((xs) => xs.filter((x) => x.id !== id));
  const byCat = useMemo(() => { const m = {}; for (const it of fixed) m[it.cat] = (m[it.cat] || 0) + weeklyEquiv(it); return CATS.filter((c) => m[c]).map((c) => ({ cat: c, wk: m[c] })); }, [fixed]);
  const maxFixed = Math.max(1, ...fixedW);
  const numCell = (id, k, val, w, min, max) => (<NumberInput value={val} onChange={(v) => setIt(id, k, v)} min={min} max={max} integer className="inp num" style={{ width: w }} />);

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap", alignItems: "stretch" }}>
        <div className="card" style={{ padding: "12px 15px" }}>
          <div className="eyebrow" style={{ color: "var(--fixed)" }}>Recurring burn</div>
          <div className="num" style={{ fontSize: 24, fontWeight: 700, color: "var(--fixed)", marginTop: 4 }}>{fmt(weeklyBurn)}<span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}> / wk</span></div>
          <div className="num" style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{fmt(weeklyBurn * 52 / 12)} / mo · {fmt(weeklyBurn * 52)} / yr</div>
        </div>
        <div className="card" style={{ padding: "12px 15px", flex: 1, minWidth: 220 }}>
          <div className="eyebrow">By category · weekly equivalent</div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: "4px 16px" }}>
            {byCat.map((r) => (<div key={r.cat} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderBottom: "1px solid var(--line2)", padding: "3px 0" }}><span style={{ color: "var(--muted)" }}>{r.cat}</span><span className="num">{fmtK(r.wk)}</span></div>))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="eyebrow">Fixed outflow by week</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>monthly items land in the week of their due day; windows clip them</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ width: TL_W, position: "relative" }}>
            <div style={{ height: 22, position: "relative", borderBottom: "1px solid var(--line2)" }}>
              {bands.map((b, i) => (<div key={i} style={{ position: "absolute", left: b.start * WEEK_W, width: b.span * WEEK_W, borderRight: "1px solid var(--line2)", padding: "3px 7px" }}><span className="th" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{b.label}</span></div>))}
            </div>
            <svg width={TL_W} height={96} style={{ display: "block" }}>
              {fixedW.map((v, i) => { if (v <= 0) return null; const h = (v / maxFixed) * 78, x = i * WEEK_W + 8, w = WEEK_W - 16; return (<g key={i}><rect x={x} y={88 - h} width={w} height={h} fill="var(--fixed)" opacity={0.6} rx={2}><title>{dateLabel(base, i) + "  " + fmt(v)}</title></rect><text x={x + w / 2} y={88 - h - 3} textAnchor="middle" fontSize="8" className="num" fill="var(--fixed)">{fmtK(v)}</text></g>); })}
            </svg>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14, padding: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead><tr>{["Cost", "Category", "Cadence", "Amount", "Timing", "Active from", "until", "≈ / wk", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 3 || i === 7 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
          <tbody>
            {fixed.map((it) => (
              <tr key={it.id} className="evrow">
                <td><input className="inp" style={{ minWidth: 150 }} value={it.label} onChange={(e) => setIt(it.id, "label", e.target.value)} /></td>
                <td><select className="sel" value={it.cat} onChange={(e) => setIt(it.id, "cat", e.target.value)}>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td><select className="sel" value={it.cadence} onChange={(e) => setIt(it.id, "cadence", e.target.value)}><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="one-time">One-time</option></select></td>
                <td style={{ textAlign: "right" }}><NumberInput value={it.amount} onChange={(v) => setIt(it.id, "amount", v)} className="inp num" style={{ width: 104, textAlign: "right" }} /></td>
                <td><TimingCell it={it} setIt={setIt} horizon={horizon} /></td>
                <td>{numCell(it.id, "from", it.from ?? 0, 56, 0)}</td>
                <td><NumberInput value={it.to ?? ""} onChange={(v) => setIt(it.id, "to", v)} min={0} integer emptyValue={null} placeholder="open" className="inp num" style={{ width: 60 }} /></td>
                <td className="num" style={{ textAlign: "right", fontSize: 12.5, color: "var(--fixed)" }}>{it.cadence === "one-time" ? "—" : fmtK(weeklyEquiv(it))}</td>
                <td><button className="btn-x" onClick={() => del(it.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn" style={{ marginTop: 12 }} onClick={add}>+ Add fixed cost</button>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        <b>Active from / until</b> are week numbers (wk 0 = this week; leave <i>until</i> blank for open-ended). Use them to model the asset-light shift — end a cost at the changeover week, start its replacement the next. The <b>≈ / wk</b> column shows the steady-state rate while a cost is active.
      </div>
    </>
  );
}
function TimingCell({ it, setIt, horizon }) {
  if (it.cadence === "weekly") return <span style={{ fontSize: 12, color: "var(--muted)" }}>every week</span>;
  if (it.cadence === "biweekly") return (<label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>from wk<NumberInput value={it.anchorWeek ?? 0} onChange={(v) => setIt(it.id, "anchorWeek", v)} min={0} integer className="inp num" style={{ width: 52 }} /></label>);
  if (it.cadence === "one-time") return (<label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>week<NumberInput value={it.week ?? 0} onChange={(v) => setIt(it.id, "week", v)} min={0} max={horizon - 1} integer className="inp num" style={{ width: 52 }} /></label>);
  return (<label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>day<NumberInput value={it.day ?? 1} onChange={(v) => setIt(it.id, "day", v)} min={1} max={28} integer className="inp num" style={{ width: 52 }} /></label>);
}

/* =====================  TAB 3  ===================== */
function APTab({ ap, setAp, base, horizon, apTotalWindow, cum, floor, openingCash, apArr, bands, TL_W, projects, unlinkBill, eventDateMap, capMarks }) {
  const setB = (id, k, val) => setAp((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const del = (id) => setAp((xs) => xs.filter((x) => x.id !== id));
  const add = () => setAp((xs) => [...xs, { id: uid(), vendor: "New vendor", ref: "", billDate: iso(0), dueDate: iso(14), amount: 5000, status: "AUTHORISED", include: true }]);
  const linkMap = useMemo(() => { const m = {}; for (const p of projects) for (const e of p.events) m[e.id] = { run: p.name, label: e.label, color: p.color }; return m; }, [projects]);

  /* pull bills from the Xero snapshot in Supabase and merge them in, preserving
     local planning edits (include/payDate/links). Live OAuth feed is still pending. */
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const importXero = async () => {
    setImporting(true); setImportMsg("");
    try {
      const snapshot = await loadAppData(XERO_SNAPSHOT_KEY);
      if (!Array.isArray(snapshot) || snapshot.length === 0) {
        setImportMsg("No Xero bills found yet — connect the Xero feed to sync ACCPAY bills.");
        return;
      }
      const facts = snapshot.map(mapXeroBill).filter((f) => f.xeroId);
      const { merged, added, updated } = mergeXeroBills(ap, facts);
      setAp(merged);
      setImportMsg(`Imported from Xero — ${added} new, ${updated} updated.`);
    } catch (err) {
      setImportMsg("Xero import failed: " + (err?.message || "unknown error"));
    } finally {
      setImporting(false);
    }
  };

  const inc = (b) => b.include ?? defaultInclude(b.status);
  const today = useMemo(() => { const d = new Date(_t); d.setHours(0, 0, 0, 0); return d; }, []);
  const minISO = base.toISOString().slice(0, 10);

  const summary = useMemo(() => {
    let totalIncluded = 0, overdue = 0, b0 = 0, b1 = 0, b2 = 0;
    for (const b of ap) {
      if (!inc(b)) continue;
      totalIncluded += b.amount;
      const days = Math.round((new Date(b.dueDate) - today) / 86400000);
      if (days < 0) overdue += b.amount; else if (days <= 14) b0 += b.amount; else if (days <= 42) b1 += b.amount; else b2 += b.amount;
    }
    return { totalIncluded, overdue, b0, b1, b2 };
  }, [ap, today]);

  const rows = [...ap].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 18 }}>
        <Stat label="Total payable (incl.)" value={fmt(summary.totalIncluded)} tone="ap" />
        <Stat label="Overdue" value={fmt(summary.overdue)} tone={summary.overdue > 0 ? "danger" : "ink"} />
        <Stat label="Due ≤ 2 wks" value={fmt(summary.b0)} />
        <Stat label="Due 3–6 wks" value={fmt(summary.b1)} />
        <Stat label="Hits position (window)" value={fmt(apTotalWindow)} tone="ap" sub="paid within chart horizon" />
      </div>

      <MiniPosition {...{ cum, floor, openingCash, base, horizon, TL_W, laneData: apArr, laneColor: "var(--ap)", title: "Cash position with bills", hint: "slate bars = bills scheduled to pay that week · keep the line above the floor", markers: capMarks, bands }} />

      <div style={{ marginTop: 14, border: "1px solid #d9e0d2", background: "#f3f6ee", color: "#4d5a3f", borderRadius: 9, padding: "9px 13px", fontSize: 12.5, lineHeight: 1.55 }}>
        <b>Connected to Xero (via Maton).</b> <b>Import from Xero</b> pulls bills where <span className="num">Type = ACCPAY</span> and <span className="num">Status ≠ PAID/VOIDED</span>. Map: Contact.Name → Vendor · Reference (or Invoice #) → Ref · Date → Bill date · DueDate → Due date · AmountDue → Amount · Status → Status. Re-importing refreshes the Xero facts but keeps your local edits (include toggle, pay date, run links). Pay date defaults to the due date; change it to time the payment against the position above.
      </div>

      <div className="card" style={{ marginTop: 14, padding: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
          <thead><tr>{["", "Vendor", "Ref", "Bill date", "Due date", "Status", "Amount", "Pay date", "Linked to", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 6 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
          <tbody>
            {rows.map((b) => {
              const included = inc(b);
              const payISO = apPayDate(b, base, eventDateMap);
              const late = new Date(payISO) > new Date(b.dueDate);
              const overdue = new Date(b.dueDate) < today;
              return (
                <tr key={b.id} className="evrow" style={{ opacity: included ? 1 : 0.45 }}>
                  <td><input type="checkbox" checked={included} onChange={(e) => setB(b.id, "include", e.target.checked)} title="Include in cash position" /></td>
                  <td><input className="inp" style={{ minWidth: 150 }} value={b.vendor} onChange={(e) => setB(b.id, "vendor", e.target.value)} /></td>
                  <td className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{b.ref}</td>
                  <td className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(b.billDate)}</td>
                  <td className="num" style={{ fontSize: 12, color: overdue ? "var(--danger)" : "var(--ink)" }}>{fmtDate(b.dueDate)}{overdue && <span className="late">overdue</span>}</td>
                  <td><StatusTag status={b.status} /></td>
                  <td className="num" style={{ textAlign: "right" }}><NumberInput value={b.amount} onChange={(v) => setB(b.id, "amount", v)} className="inp num" style={{ width: 104, textAlign: "right" }} /></td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><input className="inp num" style={{ width: 144 }} type="date" min={minISO} value={payISO} onChange={(e) => setB(b.id, "payDate", e.target.value || null)} />{late && <span className="late" title="paying after due date">late</span>}</div></td>
                  <td>{b.eventId && linkMap[b.eventId] ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: linkMap[b.eventId].color, flex: "0 0 auto" }} />
                      <span style={{ color: "var(--muted)" }}>{linkMap[b.eventId].run} · {linkMap[b.eventId].label}</span>
                      <button className="btn-x" style={{ padding: "0 4px" }} title="Unlink" onClick={() => unlinkBill(b.id)}>✕</button>
                    </span>
                  ) : <span style={{ fontSize: 11.5, color: "#b8b2a4" }}>—</span>}</td>
                  <td><button className="btn-x" onClick={() => del(b.id)}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={add}>+ Add bill</button>
          <button className="btn" onClick={importXero} disabled={importing} title="Pull ACCPAY bills from Xero (preserves your pay-date and link overrides)">{importing ? "Importing…" : "↓ Import from Xero"}</button>
          {importMsg && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{importMsg}</span>}
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        The checkbox controls whether a bill hits the cash position (DRAFT, PAID and VOIDED are off by default). <b>Pay date</b> is the lever — drag a bill later into a week with headroom above the floor, and the position line recomputes as you go.
      </div>
    </>
  );
}

function MiniPosition({ cum, floor, openingCash, base, horizon, TL_W, laneData, laneColor = "var(--ap)", title = "Cash position with bills", hint = "slate bars = bills scheduled to pay that week · keep the line above the floor", markers = [], bands }) {
  const H = 152, LANE = 30;
  const dLo = Math.min(0, floor, openingCash, ...cum), dHi = Math.max(openingCash, floor, ...cum, 1);
  const pad = (dHi - dLo) * 0.12 || 1000;
  const lo = dLo - pad, hi = dHi + pad;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const pts = cum.map((v, i) => [i * WEEK_W + WEEK_W / 2, y(v)]);
  const path = pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
  const breach = cum.some((v) => v < floor);
  let tI = 0, t = cum.length ? cum[0] : openingCash;
  cum.forEach((v, i) => { if (v < t) { t = v; tI = i; } });
  const maxLane = Math.max(1, ...laneData);
  const floorY = y(floor), openY = y(openingCash);
  return (
    <div className="card" style={{ marginTop: 14, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span className="eyebrow">{title}</span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{hint}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ width: TL_W, position: "relative" }}>
          <div style={{ height: 22, position: "relative", borderBottom: "1px solid var(--line2)" }}>
            {bands.map((b, i) => (<div key={i} style={{ position: "absolute", left: b.start * WEEK_W, width: b.span * WEEK_W, borderRight: "1px solid var(--line2)", padding: "3px 7px" }}><span className="th" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{b.label}</span></div>))}
          </div>
          <div style={{ height: LANE, borderBottom: "1px solid var(--line2)", position: "relative" }}>
            <svg width={TL_W} height={LANE} style={{ display: "block" }}>
              {laneData.map((v, i) => { if (v <= 0) return null; const h = (v / maxLane) * (LANE - 6), x = i * WEEK_W + 9, w = WEEK_W - 18; return (<rect key={i} x={x} y={3} width={w} height={Math.max(h, 1)} fill={laneColor} opacity={0.6} rx={1}><title>{dateLabel(base, i) + "  " + fmt(v)}</title></rect>); })}
            </svg>
          </div>
          <svg width={TL_W} height={H} style={{ display: "block" }}>
            {breach && (<rect x={0} y={floorY} width={TL_W} height={Math.max(0, H - floorY)} fill="#C0392B" opacity={0.06} />)}
            {Array.from({ length: horizon }).map((_, i) => (<line key={i} x1={(i + 1) * WEEK_W} y1={0} x2={(i + 1) * WEEK_W} y2={H} stroke="var(--line2)" />))}
            <line x1={0} y1={floorY} x2={TL_W} y2={floorY} stroke="var(--danger)" strokeWidth="1.4" strokeDasharray="5 4" opacity={0.8} />
            {markers.map((m, i) => { const x = m.week * WEEK_W + WEEK_W / 2; const col = m.type === "equity" ? "var(--in)" : "var(--cap)"; return (<g key={i}><line x1={x} y1={0} x2={x} y2={H} stroke={col} strokeWidth="1.2" strokeDasharray="2 3" opacity={0.7} /><polygon points={(x - 4) + ",2 " + (x + 4) + ",2 " + x + ",9"} fill={col} /><text x={x} y={H - 4} textAnchor="middle" fontSize="8.5" className="num" fill={col}>+{fmtK(m.amount)}</text></g>); })}
            <line x1={0} y1={openY} x2={WEEK_W / 2} y2={openY} stroke="var(--pos)" strokeWidth="2" />
            <path d={path} fill="none" stroke="var(--pos)" strokeWidth="2.2" />
            {pts.map((pt, i) => (<circle key={i} cx={pt[0]} cy={pt[1]} r={2} fill={cum[i] < floor ? "var(--danger)" : "var(--pos)"} />))}
            <circle cx={pts[tI][0]} cy={pts[tI][1]} r={4.5} fill="none" stroke={t < floor ? "var(--danger)" : "var(--pos)"} strokeWidth="2" />
            <text x={pts[tI][0]} y={y(t) - 9} textAnchor="middle" fontSize="9.5" className="num" fill={t < floor ? "var(--danger)" : "var(--pos)"}>floor {fmtK(t)}</text>
          </svg>
        </div>
      </div>
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)", display: "flex", gap: 16, fontSize: 11.5, color: "var(--muted)", flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 16, height: 2, background: "var(--pos)", verticalAlign: "middle" }} /> position</span>
        <span><span style={{ display: "inline-block", width: 16, borderTop: "2px dashed var(--danger)", verticalAlign: "middle" }} /> floor {fmtK(floor)}</span>
        <span style={{ marginLeft: "auto" }} className="num">lowest {fmt(t)} · week of {dateLabel(base, tI)}</span>
      </div>
    </div>
  );
}
function StatusTag({ status }) {
  const map = { DRAFT: ["#6b7177", "#eceae3"], SUBMITTED: ["#7a5d2e", "#f3ead6"], AUTHORISED: ["#1f5e54", "#dcefe9"], PAID: ["#2f6b3a", "#dff0e2"], VOIDED: ["#8a3a2e", "#f4ddd6"] };
  const [c, bg] = map[status] || map.DRAFT;
  return <span className="tag" style={{ color: c, background: bg }}>{status}</span>;
}

/* =====================  TAB 5  ===================== */
function CapitalTab({ capital, setCapital, base, horizon, capB, cum, floor, openingCash, bands, TL_W, capMarks }) {
  const setC = (id, k, val) => setCapital((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const del = (id) => setCapital((xs) => xs.filter((x) => x.id !== id));
  const addEquity = () => setCapital((xs) => [...xs, { id: uid(), type: "equity", label: "Equity raise", amount: 250000, date: iso(28), rate: 0, termMonths: 0, repay: "none" }]);
  const addDebt = () => setCapital((xs) => [...xs, { id: uid(), type: "debt", label: "Term loan", amount: 250000, date: iso(28), rate: 9, termMonths: 36, repay: "amortizing" }]);

  const equityIn = capital.filter((c) => c.type === "equity").reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const debtIn = capital.filter((c) => c.type === "debt").reduce((s, c) => s + (Number(c.amount) || 0), 0);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 18 }}>
        <Stat label="Equity in" value={fmt(equityIn)} tone="in" />
        <Stat label="Debt drawn" value={fmt(debtIn)} tone="cap" />
        <Stat label="Capital in (window)" value={fmt(capB.totalIn)} tone="cap" sub="lands within chart horizon" />
        <Stat label="Debt service (window)" value={fmt(capB.totalSvc)} tone="out" sub="principal + interest" />
      </div>

      <MiniPosition {...{ cum, floor, openingCash, base, horizon, TL_W, laneData: capB.inW, laneColor: "var(--cap)", title: "Cash position with capital", hint: "markers = injections · size a raise to clear the floor at the trough", markers: capMarks, bands }} />

      <div className="card" style={{ marginTop: 14, padding: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
          <thead><tr>{["Source", "Type", "Amount", "Funding date", "Rate %", "Term (mo)", "Repayment", "Svc (window)", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 2 || i === 7 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
          <tbody>
            {capital.map((c) => {
              const isDebt = c.type === "debt";
              const svcWindow = capB.perItem[c.id] ? capB.perItem[c.id].svcWindow : 0;
              return (
                <tr key={c.id} className="evrow">
                  <td><input className="inp" style={{ minWidth: 150 }} value={c.label} onChange={(e) => setC(c.id, "label", e.target.value)} /></td>
                  <td><select className="sel" value={c.type} onChange={(e) => setC(c.id, "type", e.target.value)}><option value="equity">Equity</option><option value="debt">Debt</option></select></td>
                  <td style={{ textAlign: "right" }}><NumberInput value={c.amount} onChange={(v) => setC(c.id, "amount", v)} className="inp num" style={{ width: 120, textAlign: "right" }} /></td>
                  <td><input className="inp num" style={{ width: 144 }} type="date" value={c.date} onChange={(e) => setC(c.id, "date", e.target.value)} /></td>
                  <td>{isDebt ? <NumberInput value={c.rate} onChange={(v) => setC(c.id, "rate", v)} min={0} className="inp num" style={{ width: 64 }} /> : <span style={{ color: "#b8b2a4" }}>—</span>}</td>
                  <td>{isDebt ? <NumberInput value={c.termMonths} onChange={(v) => setC(c.id, "termMonths", v)} min={0} integer className="inp num" style={{ width: 64 }} /> : <span style={{ color: "#b8b2a4" }}>—</span>}</td>
                  <td>{isDebt ? (
                    <select className="sel" value={c.repay} onChange={(e) => setC(c.id, "repay", e.target.value)}>
                      <option value="amortizing">Amortizing</option><option value="interest-only">Interest-only</option><option value="none">None (track in fixed)</option>
                    </select>
                  ) : <span style={{ color: "#b8b2a4" }}>—</span>}</td>
                  <td className="num" style={{ textAlign: "right", fontSize: 12.5, color: "var(--out)" }}>{isDebt && c.repay !== "none" ? fmt(svcWindow) : "—"}</td>
                  <td><button className="btn-x" onClick={() => del(c.id)}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={addEquity}>+ Equity injection</button>
          <button className="btn" onClick={addDebt}>+ Debt draw</button>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        Each source adds cash on its <b>funding date</b> and lifts the position there (and on the run planner). For <b>debt</b>, choose how it's serviced: <b>amortizing</b> spreads level monthly payments over the term, <b>interest-only</b> pays monthly interest with principal due at maturity, and <b>none</b> leaves servicing to model on the Fixed costs tab (avoids double-counting). Servicing lands monthly on the funding day-of-month and flows back out of the position.
      </div>
    </>
  );
}

/* shared weekly cash-flow statement */
function WeeklyCashFlow({ calc, fixedW, apArr, capInW, capOutW, base, horizon, floor, openingCash, note }) {
  const rows = [
    { label: "Receipts — runs", vals: calc.inW, sign: 1, tone: "in" },
    { label: "Capital in", vals: capInW, sign: 1, tone: "cap" },
    { label: "Run payments", vals: calc.outW, sign: -1, tone: "out" },
    { label: "Fixed costs", vals: fixedW, sign: -1, tone: "fixed" },
    { label: "Bills", vals: apArr, sign: -1, tone: "ap" },
    { label: "Debt service", vals: capOutW, sign: -1, tone: "out" },
  ];
  const toneColor = (t) => t === "in" ? "var(--in)" : t === "out" ? "var(--out)" : t === "fixed" ? "var(--fixed)" : t === "ap" ? "var(--ap)" : t === "cap" ? "var(--cap)" : "var(--ink)";
  const CFW = 60;
  const stickyL = { position: "sticky", left: 0, background: "#FBFAF6", zIndex: 1, borderRight: "1px solid var(--line)", padding: "5px 10px", whiteSpace: "nowrap" };
  const stickyH = { position: "sticky", left: 0, background: "#F1EFE7", zIndex: 2, borderRight: "1px solid var(--line)", padding: "6px 10px", textAlign: "left" };
  let tI = 0, t = calc.cum.length ? calc.cum[0] : openingCash;
  calc.cum.forEach((v, i) => { if (v < t) { t = v; tI = i; } });
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span className="eyebrow">Weekly cash flow</span>
        <span className="num" style={{ fontSize: 11.5, color: "var(--muted)" }}>ending {fmt(calc.ending)} · lowest {fmt(t)} week of {dateLabel(base, tI)}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }} className="num">
          <thead>
            <tr>
              <th style={{ ...stickyH, fontWeight: 600 }} className="th">Week ending</th>
              {Array.from({ length: horizon }).map((_, i) => (<th key={i} className="th" style={{ minWidth: CFW, padding: "6px 6px", textAlign: "right", fontWeight: 600 }}>{dateLabel(base, i, true)}</th>))}
              <th className="th" style={{ minWidth: CFW + 10, padding: "6px 10px", textAlign: "right", fontWeight: 700, borderLeft: "1px solid var(--line)" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => { const tot = r.vals.reduce((s, v) => s + v, 0) * r.sign; return (
              <tr key={ri}>
                <td style={{ ...stickyL, color: toneColor(r.tone), fontWeight: 600 }}>{r.label}</td>
                {r.vals.map((v, i) => { const x = v * r.sign; return (<td key={i} style={{ padding: "4px 6px", textAlign: "right", color: x === 0 ? "#cfcabb" : toneColor(r.tone) }}>{x === 0 ? "·" : fmtK(x)}</td>); })}
                <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, color: toneColor(r.tone), borderLeft: "1px solid var(--line)" }}>{fmtK(tot)}</td>
              </tr>); })}
            <tr>
              <td style={{ ...stickyL, fontWeight: 700, borderTop: "1px solid var(--line)" }}>Net change</td>
              {calc.net.map((v, i) => (<td key={i} style={{ padding: "4px 6px", textAlign: "right", borderTop: "1px solid var(--line)", color: v === 0 ? "#cfcabb" : v > 0 ? "var(--in)" : "var(--out)" }}>{v === 0 ? "·" : fmtK(v)}</td>))}
              <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--line)", borderLeft: "1px solid var(--line)" }}>{fmtK(calc.net.reduce((s, v) => s + v, 0))}</td>
            </tr>
            <tr>
              <td style={{ ...stickyL, fontWeight: 700 }}>Closing position</td>
              {calc.cum.map((v, i) => (<td key={i} style={{ padding: "4px 6px", textAlign: "right", fontWeight: 600, color: v < floor ? "var(--danger)" : "var(--pos)" }}>{fmtK(v)}</td>))}
              <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, borderLeft: "1px solid var(--line)", color: calc.ending < floor ? "var(--danger)" : "var(--pos)" }}>{fmtK(calc.ending)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--muted)" }}>
        {note || <>Opening cash {fmt(openingCash)} · red closing = below the {fmt(floor)} floor.</>}
      </div>
    </div>
  );
}

/* =====================  TAB 6  ===================== */
function SheetTab({ projects, setProjects, fixed, setFixed, ap, setAp, capital, setCapital,
  openingCash, setOpeningCash, floor, setFloor, base, horizon, evWeek, eventDateMap, calc, fixedW, apArr, capInW, capOutW }) {

  const updEvent = (rid, eid, patch) => setProjects((ps) => ps.map((p) => p.id === rid ? { ...p, events: p.events.map((e) => e.id === eid ? { ...e, ...patch } : e) } : p));
  const updFixed = (id, patch) => setFixed((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const updBill = (id, patch) => setAp((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const updCap = (id, patch) => setCapital((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const num = (val, on, w = 104) => <NumberInput value={val} onChange={on} className="inp num" style={{ width: w, textAlign: "right" }} />;

  const [exporting, setExporting] = useState(false);
  const exportXlsx = async () => {
    setExporting(true);
    try {
      await exportTreasuryToExcel({ base, horizon, openingCash, floor, calc, fixedW, apArr, capInW, capOutW, projects, fixed, ap, capital, evWeek, eventDateMap });
    } catch (e) { window.alert("Excel export failed: " + (e?.message || e)); }
    finally { setExporting(false); }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap", alignItems: "center" }}>
        <Field label="Opening cash" value={openingCash} onChange={setOpeningCash} />
        <Field label="Cash floor" value={floor} onChange={setFloor} hint="min you'll tolerate" />
        <button className="btn" disabled={exporting} onClick={exportXlsx} title="Download the full cash model as a formatted Excel workbook">{exporting ? "Exporting…" : "⬇ Export to Excel"}</button>
      </div>

      <div style={{ marginTop: 14 }}>
        <WeeklyCashFlow {...{ calc, fixedW, apArr, capInW, capOutW, base, horizon, floor, openingCash, note: <>Opening cash {fmt(openingCash)} · red closing = below the {fmt(floor)} floor. Edits below flow straight into these columns and every other tab.</> }} />
      </div>

      {/* editable line-item grid */}
      <div className="card" style={{ marginTop: 14, padding: 16, overflowX: "auto" }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Line items · quick edit</div>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead><tr>{["Item", "In/Out", "Amount", "When", "Lands"].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 2 ? "right" : "left", padding: "0 6px 6px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
          <tbody>
            {projects.map((p) => (
              <React.Fragment key={p.id}>
                <GroupHead>Run · {p.name}</GroupHead>
                {p.events.map((e) => { const w = evWeek(p, e); return (
                  <tr key={e.id} className="evrow">
                    <td><input className="inp" style={{ minWidth: 150 }} value={e.label} onChange={(ev) => updEvent(p.id, e.id, { label: ev.target.value })} /></td>
                    <td><select className="sel" value={e.dir} onChange={(ev) => updEvent(p.id, e.id, { dir: ev.target.value })}><option value="in">In</option><option value="out">Out</option></select></td>
                    <td style={{ textAlign: "right" }}>{num(e.amount, (v) => updEvent(p.id, e.id, { amount: v }))}</td>
                    <td><span style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--muted)" }}>
                      <select className="sel" value={e.anchor} onChange={(ev) => updEvent(p.id, e.id, { anchor: ev.target.value })}><option value="start">start</option><option value="end">end</option></select>
                      <NumberInput value={e.offset} onChange={(v) => updEvent(p.id, e.id, { offset: v })} integer className="inp num" style={{ width: 54 }} />wk
                    </span></td>
                    <td className="num" style={{ fontSize: 12, color: w < 0 || w >= horizon ? "var(--muted)" : "var(--ink)" }}>{dateLabel(base, w)}</td>
                  </tr>); })}
              </React.Fragment>
            ))}

            <GroupHead>Fixed costs</GroupHead>
            {fixed.map((it) => (
              <tr key={it.id} className="evrow">
                <td><input className="inp" style={{ minWidth: 150 }} value={it.label} onChange={(e) => updFixed(it.id, { label: e.target.value })} /></td>
                <td><span style={{ fontSize: 11.5, color: "var(--out)" }}>Out</span></td>
                <td style={{ textAlign: "right" }}>{num(it.amount, (v) => updFixed(it.id, { amount: v }))}</td>
                <td><select className="sel" value={it.cadence} onChange={(e) => updFixed(it.id, { cadence: e.target.value })}><option value="weekly">weekly</option><option value="biweekly">biweekly</option><option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="annual">annual</option><option value="one-time">one-time</option></select></td>
                <td className="num" style={{ fontSize: 12, color: "var(--fixed)" }}>{it.cadence === "one-time" ? "—" : fmtK(weeklyEquiv(it)) + "/wk"}</td>
              </tr>
            ))}

            <GroupHead>Bills payable</GroupHead>
            {ap.map((b) => { const on = b.include ?? defaultInclude(b.status); const payISO = apPayDate(b, base, eventDateMap); return (
              <tr key={b.id} className="evrow" style={{ opacity: on ? 1 : 0.45 }}>
                <td><input className="inp" style={{ minWidth: 150 }} value={b.vendor} onChange={(e) => updBill(b.id, { vendor: e.target.value })} /></td>
                <td><input type="checkbox" checked={on} title="include in cash" onChange={(e) => updBill(b.id, { include: e.target.checked })} /></td>
                <td style={{ textAlign: "right" }}>{num(b.amount, (v) => updBill(b.id, { amount: v }))}</td>
                <td><input className="inp num" style={{ width: 144 }} type="date" value={payISO} onChange={(e) => updBill(b.id, { payDate: e.target.value || null })} /></td>
                <td className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(payISO)}</td>
              </tr>); })}

            <GroupHead>Capital</GroupHead>
            {capital.map((c) => (
              <tr key={c.id} className="evrow">
                <td><input className="inp" style={{ minWidth: 150 }} value={c.label} onChange={(e) => updCap(c.id, { label: e.target.value })} /></td>
                <td><select className="sel" value={c.type} onChange={(e) => updCap(c.id, { type: e.target.value })}><option value="equity">Equity</option><option value="debt">Debt</option></select></td>
                <td style={{ textAlign: "right" }}>{num(c.amount, (v) => updCap(c.id, { amount: v }))}</td>
                <td><input className="inp num" style={{ width: 144 }} type="date" value={c.date} onChange={(e) => updCap(c.id, { date: e.target.value })} /></td>
                <td className="num" style={{ fontSize: 12, color: "var(--cap)" }}>{c.type === "debt" ? c.repay : "in"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- shared bits ---------- */

/* Robust numeric input. The old pattern — value={number} + onChange={Number(e.target.value)}
   — fought the user on edit: clearing the field snapped it to 0, leading zeros stuck ("08"),
   and partial input (a lone "-" or "12.") was dropped. This keeps a local string buffer while
   the field is focused, so what you type is exactly what you see, and still emits a parsed
   number to the live cash model on every keystroke. On blur it normalizes and clamps. */
function NumberInput({ value, onChange, min, max, step = 1, integer = false, emptyValue, className = "inp num", style, placeholder, title }) {
  const [buf, setBuf] = useState(null);
  const empty = emptyValue !== undefined ? emptyValue : (min != null ? min : 0);
  const re = integer ? /^-?\d*$/ : /^-?\d*\.?\d*$/;
  const ext = value === "" || value === null || value === undefined ? "" : String(value);
  const shown = buf !== null ? buf : ext;
  const partial = (s) => s === "" || s === "-" || s === "." || s === "-.";

  const emit = (raw) => {
    if (partial(raw)) { onChange(empty); return; }
    const n = Number(raw);
    onChange(Number.isFinite(n) ? n : empty);
  };
  const onChangeRaw = (e) => {
    const raw = e.target.value;
    if (!re.test(raw)) return; // reject keystrokes that would break the numeric format
    setBuf(raw);
    emit(raw);
  };
  const onBlur = () => {
    const raw = buf;
    setBuf(null); // resync display to the canonical value from props
    if (raw === null) return; // focused but never edited
    if (partial(raw)) { onChange(empty); return; }
    let n = Number(raw);
    if (!Number.isFinite(n)) { onChange(empty); return; }
    if (integer) n = Math.trunc(n);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    onChange(n);
  };
  const onKeyDown = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; // restore spinner-style nudging
    e.preventDefault();
    const cur = Number(buf !== null ? buf : value);
    let n = (Number.isFinite(cur) ? cur : empty) + (e.key === "ArrowUp" ? step : -step);
    if (integer) n = Math.round(n);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    setBuf(String(n));
    onChange(n);
  };
  return (
    <input type="text" inputMode={integer ? "numeric" : "decimal"} className={className} style={style}
      placeholder={placeholder} title={title} value={shown} onChange={onChangeRaw} onBlur={onBlur} onKeyDown={onKeyDown} />
  );
}

function Field({ label, value, onChange, hint }) {
  return (<label className="card" style={{ padding: "7px 11px", display: "block" }}>
    <div className="eyebrow">{label}{hint ? <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {hint}</span> : null}</div>
    <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 2 }}><span style={{ color: "var(--muted)" }}>$</span><NumberInput value={value} onChange={onChange} className="num" style={{ border: "none", outline: "none", width: 92, fontSize: 16, fontWeight: 600, background: "transparent", color: "var(--ink)" }} /></div>
  </label>);
}
function Stat({ label, value, sub, tone = "ink" }) {
  const color = tone === "in" ? "var(--in)" : tone === "out" ? "var(--out)" : tone === "fixed" ? "var(--fixed)" : tone === "ap" ? "var(--ap)" : tone === "cap" ? "var(--cap)" : tone === "danger" ? "var(--danger)" : "var(--ink)";
  return (<div className="card" style={{ padding: "11px 13px" }}><div className="eyebrow">{label}</div><div className="num" style={{ fontSize: 19, fontWeight: 700, color, marginTop: 3 }}>{value}</div>{sub && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}</div>);
}
function Mini({ label, value, onChange, min }) {
  return (<label style={{ fontSize: 12, color: "var(--muted)" }}><div style={{ marginBottom: 2 }}>{label}</div><NumberInput value={value} onChange={onChange} min={min} integer className="inp num" style={{ width: 88 }} /></label>);
}
function dateLabel(base, weekIdx, short) { const d = addWeeks(base, weekIdx); if (short) return d.getDate() + "/" + (d.getMonth() + 1); return MON[d.getMonth()] + " " + d.getDate(); }
function GroupHead({ children }) { return (<tr><td colSpan={5} style={{ padding: "12px 6px 4px", borderTop: "1px solid var(--line)" }}><span className="eyebrow">{children}</span></td></tr>); }
function hexA(hex, a) { const h = hex.replace("#", ""); return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")"; }

/* visibility toggle icons (Feather "eye" / "eye-off"); stroke inherits the button color */
function EyeOn() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>);
}
function EyeOff() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>);
}
