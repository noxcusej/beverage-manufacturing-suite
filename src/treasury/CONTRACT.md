# Treasury Cockpit v2 — module contract

Read this before touching anything under `src/treasury/`. It pins the data shapes and
function signatures so the model modules, the engine, the store and the UI agree.
The product spec is `docs/TREASURY_COCKPIT_V2_SPEC.md`; this file is the code-level
contract derived from it. Plain ESM JavaScript, **no React and no external deps in
`model/`**, pure functions, JSDoc types. Tests: `node --test src/treasury/model/*.test.mjs`
(Node's built-in runner; the package is `"type": "module"`).

Layout
```
src/treasury/
  model/sprints.js   ✅ written — sprint calendar (import everything date/sprint from here)
  model/runs.js      runs · materials table · payment schedule · suite mapping · v2→v3 run migration
  model/burn.js      baseline burn (P&L lines) → per-sprint heartbeat
  model/engine.js    the cash engine (pure) — ONE source of truth for every number on screen
  model/store.js     v3 store shape · v2→v3 migration · canonical signature · save-merge · ids
  components/…       React, built on the modules above
  pages/TreasuryCockpitV2.jsx  composition + persistence + cross-window coordination
```

## 0. Time (sprints.js — done)
- `epoch` = ISO date of a known sprint start, default `"2026-09-07"`. Sprint `k` (integer,
  may be negative) starts `epoch + 14k days` (Monday), ends Sunday.
- `sprintIndex(dateOrIso, epoch)`, `sprintStart(k, epoch)`, `sprintEnd(k, epoch)`,
  `weekInSprint(date, epoch)` (0|1), `sprintOfToday(epoch, today?)`, `sprintColumns(epoch, origin, horizon)`,
  `parseLocalDate`, `isoLocal`, `addDays`, `mondayOf`, `daysBetween`, `fmtMD`, `rangeLabel`, `MON`.
- **View origin** `origin = sprintOfToday(epoch)`. Engine arrays are indexed `i = k − origin`,
  `0 ≤ i < horizon`. Flows before the origin are **not counted** but must be **reported**.
- **Persist absolute `k`** (never `i`) — `startSprint`, `manualAdj` keys, etc. — so nothing
  shifts as time passes.

## 1. Shapes (v3)

```ts
type Id = string;                  // new ids: newId(prefix) from store.js; migrated numeric ids are stringified

type MaterialLine = {
  id: Id;
  label: string;                   // standard labels below, or free text for extras
  standard: boolean;               // the five standard lines: always present, never deleted (zero them instead)
  amount: number;                  // total cost $, paid ON ORDER
  leadWeeks: number;               // order this many weeks before the start of the sprint it feeds
  feedsSprint: number;             // 1-based sprint OF THE RUN it must arrive for (1 = run's first sprint)
  category?: 'hard' | 'soft' | 'outsourced'; // optional tag; only groups the cash-table display
  status?: 'planned' | 'ordered' | 'linked';  // 'linked' = a Xero bill is linked (actuals replace estimate)
  orderedOn?: string;              // ISO, set when marked ordered
  source?: 'suite' | 'manual';     // 'manual' once the user edits a suite-filled amount (refresh must not clobber)
};
// Standard lines & default leads (weeks): Soft goods 3 · Cans 4 · Cartons 3 · Imported spirits 4 · Domestic spirits 2.
// Default categories: Soft goods/Imported spirits/Domestic spirits → 'soft'; Cans/Cartons → 'hard'; extras → 'outsourced'.

type PaymentLine = {
  id: Id;
  kind: 'deposit' | 'bom' | 'progress' | 'completion';
  label: string;
  amount: number;
  timing: { mode: 'date'; date: string } | { mode: 'runEnd' } | { mode: 'beforeStart'; weeks: number };
  received?: boolean;
};
// Exactly one 'completion' with timing {mode:'runEnd'} per run; deposit + ≥1 bom expected.

type Run = {
  id: Id; suiteRunId?: string; name: string; client?: string; color: string; hidden?: boolean;
  startSprint: number;             // absolute k
  sprints: number;                 // ≥ 1; runs MAY overlap other runs
  value: number;                   // run value (quote total)
  tolling: number;                 // margin portion of value
  materials: MaterialLine[];       // 5 standard lines always present + extras
  taxes: number;                   // paid at run end
  payments: PaymentLine[];
  notes?: string;
};

type BurnCategory = 'Payroll & benefits' | 'Rent & facilities' | 'Utilities' | 'Insurance'
  | 'Software & subscriptions' | 'Professional services' | 'Marketing' | 'Debt service' | 'Other G&A';
type BurnLine = { id: Id; category: BurnCategory; label?: string; monthly: number; dayOfMonth?: number; // 1–28, default 1
  from?: string; to?: string;      // ISO bounds (inclusive); step-changes
  cadence?: 'monthly' | 'quarterly' | 'annual' | 'one-time'; notes?: string };

type Injection = { id: Id; type: 'equity' | 'debt'; label: string; amount: number; date: string };   // cash IN only

type Bill = {                      // Xero-shaped, same as v1 except eventId → lineId
  id: Id; xeroId?: string; vendor: string; ref?: string; billDate: string; dueDate: string; amount: number;
  status: string; include?: boolean; payDate?: string; runId?: Id; lineId?: Id;   // lineId = linked MaterialLine.id
};

type ScenarioState = {
  version: 3; sprintEpoch: string; horizonSprints: number; openingCash: number; floor: number;
  runs: Run[]; burn: BurnLine[]; capital: Injection[]; ap: Bill[];
  manualAdj: { [k: string]: number };   // keyed by ABSOLUTE sprint k; signed (+ in / − out)
  tab: string; selId: Id | null;
};
type Scenario = { id: Id; name: string; group?: string; notes?: string; updatedAt: number; state: ScenarioState; legacyV2?: unknown };
type StoreV3 = { version: 3; activeId: Id; scenarios: Scenario[] };
```

## 2. runs.js — exports
```js
export const STANDARD_MATERIALS   // [{label:'Soft goods',leadWeeks:3,category:'soft'}, {label:'Cans',leadWeeks:4,category:'hard'}, {label:'Cartons',leadWeeks:3,category:'hard'}, {label:'Imported spirits',leadWeeks:4,category:'soft'}, {label:'Domestic spirits',leadWeeks:2,category:'soft'}]
export const DEFAULT_EXTRA_LEAD = 1
export function newMaterialLine(partial, newId)          // fills defaults; standard=false unless given
export function standardMaterials(newId)                 // the five lines, amount 0, feedsSprint 1
export function ensureStandardMaterials(lines, newId)    // adds any missing standard line (idempotent), preserves order: standard first in canonical order, then extras
export function newRun(partial, newId, ctx)              // ctx: { epoch, originSprint }; sets startSprint (default origin+1), sprints 1, standard materials, default payments
export function runStartDate(run, epoch) / runEndDate(run, epoch)
export function materialOrderDate(run, line, epoch)      // sprintStart(startSprint + feedsSprint − 1) − 7·leadWeeks days  (Date)
export function paymentDate(run, line, epoch)            // 'date' → that date; 'runEnd' → runEndDate; 'beforeStart' → runStartDate − 7·weeks
export function materialsTotal(run)                      // Σ amount
export function defaultPayments(run, newId)              // deposit 50% tolling @beforeStart 4w · bom 100% materials @beforeStart 4w · completion remainder @runEnd
export function balancePayments(run)                     // returns payments with completion.amount = value − Σ others (never mutates); if user-overridden flag needed, caller decides
export function ensureCompletion(run, newId)             // guarantees exactly one completion(runEnd)
export function applySuiteCosts(run, costs)              // costs = computeRunResults(suiteRun).costs; fills value/tolling/taxes and standard-line amounts (Soft goods←totalIngredientCost, Cans←rawPackagingCost, Cartons←bomCost, extra "Batching / cartoning"←totalBatchingFees) WITHOUT overwriting lines whose source==='manual'; returns new run
export function quoteToRun(suiteRun, costs, idx, newId, ctx)   // new v3 run from a suite quote
export function migrateRunFromV2(v2run, ctx)             // ctx: { base: Date (v2 week-0 Monday), epoch, newId }. startWeek→startSprint via sprintIndex(addDays(base, 7·startWeek)), sprints=max(1,ceil(duration/2)); events→materials/payments by label heuristics (see spec §7); returns { run, unmapped: [{label, dir, amount}] }; NO MONEY LOST: Σ in / Σ out preserved
export function runCoverage(run, epoch, todayIso)        // { total, overdue: MaterialLine[], firstDue: Date|null } — overdue = orderDate < today && status not ordered/linked && amount>0
```

## 3. burn.js — exports
```js
export const BURN_CATEGORIES        // the 9 names, in P&L order
export function defaultBurnLines(newId)                  // one $0 line per category
export function burnBySprint(lines, epoch, origin, horizon)  // { arr: number[horizon], items: Array<Array<{label, amount}>>, weekly: number[2*horizon] }
   // monthly: lands in the sprint containing (year, month, dayOfMonth) for each month inside [from,to]; quarterly/annual step by 3/12 months from `from` (or the origin month); one-time lands on `from`
export function migrateFixedToBurn(fixedItems, newId)    // v1 fixed[] → BurnLine[] (weekly ×52/12, biweekly ×26/12 → monthly; cat → category map; unknown → 'Other G&A')
export function monthlyTotal(lines)                      // Σ monthly of currently-active lines (today)
```

## 4. engine.js — the ONE cash engine
```js
export function computeCash(input) → Result
input = { epoch, origin, horizon, openingCash, floor, runs, burn, capital, ap, manualAdj, today /* ISO */ }
Result = {
  origin, horizon,
  cols: Array<{k, i, start, end, range, ordinal}>,           // from sprintColumns
  rows: { clientIn, capitalIn, materials, taxes, burn, bills, adjust, net, closing },  // number[horizon] each (magnitudes for out-rows, signed for adjust/net/closing)
  weekly: { clientIn, capitalIn, materials, taxes, burn, bills, adjust, net, closing },   // number[2*horizon] (adjust split into week 0 of its sprint)
  breakdown: { clientIn, capitalIn, materials, taxes, burn, bills },  // Array<Array<{label, amount, runId?, lineId?, category?}>> per i
  materialsByCategory: { hard: number[], soft: number[], outsourced: number[] },
  orderAhead: Array<{ k, i, total, count, lines: Array<{runId, runName, lineId, label, amount, orderDate, feedsK}> }>,  // per i
  overdue: Array<{runId, runName, lineId, label, amount, orderDate}>,   // order date < today and not ordered/linked; NOT counted in rows
  droppedCapital: Injection[],       // dated before origin or after horizon (not counted)
  perRun: { [runId]: { net, inTotal, outTotal, coverage: {total, overdue: number, firstDue} } },
  totals: { clientIn, capitalIn, materials, taxes, burn, bills, adjust },
  trough, troughI, ending, firstBreach   // firstBreach = first i with closing < floor, else horizon
}
```
Rules (carry the v1 invariants):
- Hidden runs contribute nothing (but perRun still reports their standalone net).
- Materials: cash at `materialOrderDate`, bucketed to its sprint; **linked bills replace the estimate** — for a line with linked included bills, only `max(0, amount − Σ linked bills)` projects at the order date; the bills themselves flow at their pay date in `bills`. Never sum both.
- Bills: included if `include ?? defaultInclude(status)` (DRAFT/PAID/VOIDED off by default); pay date = `payDate` → else linked line's order date → else `max(today, dueDate)`; pay dates before the origin are pulled to the origin sprint (they are real cash owed now).
- Payments: `paymentDate`; before origin → not counted, but listed in `breakdown`-adjacent `overdue`? No — pre-origin *payments* are reported in `perRun[...].pastPayments` (amount only) and flagged by the UI; keep it simple.
- Capital: counted only inside the window; otherwise `droppedCapital`.
- `net[i] = clientIn + capitalIn − materials − taxes − burn − bills + adjust`; `closing[i] = openingCash + Σ net[0..i]`.
- `manualAdj` keys are absolute k; `adjust[i] = manualAdj[String(origin+i)] || 0`.
- Deterministic and pure; no Date.now() — use `input.today`.

## 5. store.js — exports
```js
export const STORE_KEY = "treasury_cockpit_v3"      // v2 writes ONLY here
export const LEGACY_KEY = "treasury_cockpit"        // v1/v2 blob: READ-ONLY, for first-load migration
export function newId(prefix = "id")                // string ids, monotonic-ish + random; never collide with numeric legacy ids
export function canon(v) / storeSig(store)          // key-order-independent, ignores `updatedAt` (same semantics as v1)
export function isV3(raw)
export function migrateLegacyToV3(legacyRaw, ctx)   // ctx: { epoch, today }: accepts v1 flat blob OR v2 {version:2,scenarios} → StoreV3; per scenario: runs via migrateRunFromV2 (base = mondayOf(today) — the v1/v2 base was "this Monday" at save time; document the approximation), burn via migrateFixedToBurn, capital: keep injections, convert v2 debt servicing (repay!=='none') into a Burn 'Debt service' line (level P&I), manualAdj week-index → absolute k, ap: eventId → lineId (unlinked if no match); keep `legacyV2` copy on the scenario; returns { store, report: [{scenarioId, unmapped:[...]}] }
export function normalizeStore(raw)                 // v3 → v3 with defaults filled (ensureStandardMaterials, ensureCompletion, manualAdj {}, horizon default 13, epoch default)
export function mergeScenarios(localStore, remoteStore, activeId)  // v1 save-merge semantics: active wins; others keep the newer updatedAt; remote-only appended; preserves local order
export function bumpIds / (not needed: ids are strings) — omit
```

## 6. Suite integration
`computeRunResults(suiteRun)` from `src/utils/runResults.js` → `.costs` = `{ totalCost, rawPackagingCost, totalIngredientCost, bomCost, taxCost, totalBatchingFees, tollingCost }` (may throw on malformed → callers try/catch). Suite runs are loaded with `loadAppData("runs")`.

## 7. Persistence (page, not model)
Same as v1: manual Save only; dirty derived from `storeSig(current) !== savedSig`; save = re-read remote, `mergeScenarios`, write to `STORE_KEY`; BroadcastChannel `treasury_cockpit_v3_sync` for sibling windows (adopt if not dirty; writer election; read-only banner). `loadAppData`/`saveAppData` from `src/data/supabase.js`.

## 8. Tests (each module ships `<name>.test.mjs`, `node --test`)
Minimum: sprints across the epoch and negative k · run date derivation incl. feedsSprint>1 · default payments balance to value · completion auto-balance · materials replace-not-sum with a linked bill · burn monthly bucketing across month boundaries and from/to · engine net/closing tie-out on a small fixture · v2→v3 migration on a realistic scenario preserves Σ in / Σ out · mergeScenarios revert case (stale window can't clobber newer scenario).
