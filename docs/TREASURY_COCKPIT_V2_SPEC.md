# Treasury Cockpit v2 — Sprint-Based Cash Planning

**Status:** approved design, ready to implement
**Owner:** Jordan Garbis
**Code:** `src/pages/TreasuryCockpit.jsx` (currently a single ~1,900-line file; see "Refactor" below)
**Supersedes:** the weekly, event-anchored model in v1

---

## 0. Why

The v1 cockpit thinks in *weeks-from-today, generic run "events", and a flat fixed-cost table*. The business runs on *2-week sprints, materials orders, client payment schedules, and a steady overhead burn*. Every translation between the two leaks accuracy. v2 makes the tool's primitives match the operating primitives so the plan stays true with less hand-tuning.

Confirmed decisions from the design conversation:

| Topic | Decision |
|---|---|
| Unit of time | **The sprint.** Always exactly 2 weeks, Monday start. Next sprint starts **Mon Sep 7, 2026**. |
| Runs in sprints | A run occupies **one or many whole sprints**. **Two runs can share a sprint.** |
| Materials | **Hard goods:** cans, closures, trays, shrink, cartons. **Soft goods:** ingredients, flavors. **Outsourced activities:** e.g. cartoning. |
| Materials cash timing | Assume **paid on order**. Do **not** model per-vendor terms (too complex). |
| Client payments | No universal schedule, but **always**: a **deposit**, at least one **BOM (materials) funding**, and a **completion payment**. Some clients also make **progress** payments. **Completion is due on receipt at the end of the run.** Schedules are negotiated per run. |
| Overhead ("burn") | Treat as **flat**. Capture in **standard P&L categories** (prompted). **Debt payments live in burn.** Replace the current Fixed-costs UI. |
| Source of run cost | Pull from the **beverage-manufacturing-suite run** (quote) via `computeRunResults` — it "hits cost neatly." It does **not** carry payment terms; those live in the cockpit. |

Everything below follows from those.

---

## 1. Time model

### 1.1 Sprint calendar
- `sprintEpoch`: ISO date of a known sprint start. **Default `2026-09-07`.** Stored per scenario (all scenarios normally share it); editable in settings.
- Sprint `k` (integer, may be negative) starts `epoch + 14·k days`, ends `start + 13 days` (Sunday). Sprints are contiguous and never flex.
- `sprintOf(date) = floor((mondayOf(date) − epoch) / 14 days)`.
- **View origin** = the sprint containing today (so Aug 29, 2026 sits in the sprint Aug 24 – Sep 6, i.e. `k = −1`). Columns run from the origin sprint for `horizonSprints` (default **13** ≈ 6 months; auto-extend to cover the latest scheduled flow, cap 40).
- Sprint label: `Sprint {ordinal from view origin} · Sep 7 – 20`. Ordinal is display-only; persist `k`.

### 1.2 Bucketing
- **Every** cash flow is dated, then bucketed to the sprint containing its date. Sprint is the unit for planning, the table, and the position line.
- Retain a **week sub-bucket** internally (`weekOf(date)` within the sprint: 0 or 1) so the cash table can **expand a sprint into its two weeks** on demand (bills and payments often need it). Default view is sprints.
- Replace all `WEEK_W`/`base`/`horizon` (week) math with sprint math. Keep one column-width constant for the sprint grid and reuse it for the Gantt so columns stay aligned (the v1 alignment invariant).

### 1.3 Past-dated flows
- Flows dated before the view origin are **not counted** (consistent with v1) and must be **flagged**, not silently dropped — keep the v1 "◀ before start — not counted" indicators for runs, payments, materials, capital, and bills.

---

## 2. Run model

A run is a production job scheduled into sprints, with a materials plan and a client payment schedule. Cost comes from the suite; timing and payments are the cockpit's.

```ts
type Run = {
  id: string;                 // stable; == suite run id when linked
  suiteRunId?: string;        // link to beverage-manufacturing-suite run (quote)
  name: string; client?: string; color: string; hidden?: boolean;
  startSprint: number;        // sprint k
  sprints: number;            // duration in sprints, >= 1  (runs MAY overlap other runs)
  value: number;              // run value (quote total). From suite when linked; else manual.
  tolling: number;            // tolling/margin portion of value (from suite). Drives deposit/completion defaults.
  materials: {
    hard:       MaterialLine;      // cans, closures, trays, shrink, cartons
    soft:       MaterialLine;      // ingredients, flavors
    outsourced: MaterialLine[];    // e.g. { label:"Cartoning", ... }
  };
  taxes?: number;             // taxes & regulatory (from suite), paid at completion
  payments: PaymentLine[];    // client schedule — see §3
  notes?: string;
};

type MaterialLine = {
  label: string;
  amount: number;             // $ (from suite when linked; editable override)
  leadWeeks: number;          // order this many weeks BEFORE the run's start date
  source?: 'suite' | 'manual';
};
```

### 2.1 Derived dates (all relative to the run's sprint placement)
- `runStart = sprintStart(startSprint)`; `runEnd = sprintEnd(startSprint + sprints − 1)`.
- **Materials cash out = "on order":** `orderDate(line) = runStart − leadWeeks·7 days`. Bucket to that sprint. Defaults: **hard 4 wks, soft 2 wks, outsourced 1 wk** before run start (per-line editable).
- **Taxes** land at `runEnd`.
- Dragging a run (or changing `startSprint`/`sprints`) re-derives every material order date and the completion payment automatically. Deposits/BOM/progress payments do **not** move (see §3) unless set to "follow run."

### 2.2 Suite link (source of cost)
- "Import from quoting" / "Link to suite run" sets `suiteRunId` and pulls costs via `computeRunResults(run).costs` (already imported in v1):
  - `value ← totalCost`, `tolling ← tollingCost`
  - `materials.hard.amount ← rawPackagingCost + bomCost` (packaging + freight/BOM)
  - `materials.soft.amount ← totalIngredientCost`
  - `materials.outsourced ← [{ label:"Batching / cartoning", amount: totalBatchingFees }]`
  - `taxes ← taxCost`
- **Refresh from suite** re-pulls the numbers above but **preserves** `startSprint`, `sprints`, lead weeks, payment schedule edits, and any manual overrides (mark overridden lines `source:'manual'` and don't clobber them). This is the v1 `mergeQuoteRuns` contract, carried forward.
- Manual runs (no link) enter `value`/`tolling`/materials by hand.

### 2.3 Materials ↔ Xero bills (no double count)
- Keep the v1 invariant: a Xero AP bill can be **linked to a run's material line**. When linked, the budgeted line projects only its **remaining** estimate (`max(0, amount − Σ linked bills)`) at its order date, and the actual bill flows at its own pay date. Actuals replace and retime the estimate; never sum both.

---

## 3. Client payment schedule

Payments are a **contract schedule**, not a property of the bar. Only the completion payment is anchored to the run.

```ts
type PaymentLine = {
  id: string;
  kind: 'deposit' | 'bom' | 'progress' | 'completion';
  label: string;
  amount: number;                  // $; may be entered as % of value/tolling (UI helper) but persisted as $
  timing:
    | { mode: 'date'; date: string }                 // fixed calendar date (deposit / bom / progress)
    | { mode: 'runEnd' }                             // completion: due on receipt at run end (auto)
    | { mode: 'beforeStart'; weeks: number };        // optional: "follow run" — X weeks before run start
  received?: boolean;              // optional actuals toggle
};
```

### 3.1 Rules
- **Every run has exactly one `completion`** with `timing:{mode:'runEnd'}`. It cannot be deleted, and it always lands in the run's last sprint. It slides with the run.
- **Deposit and BOM funding are required** (created by default, deletable only with a warning). **Progress** lines are optional and repeatable.
- **Auto-balance:** by default `completion.amount = value − Σ(other payment amounts)`, recomputed when other lines change, so the schedule always sums to the run value. The user can override the completion amount (then show a "schedule ≠ run value by $X" warning rather than silently adjusting).
- Payment dates are independent of the bar. Moving a run moves **only** the completion payment (and any lines explicitly set to `beforeStart`).

### 3.2 Default template on run creation (editable)
Reflects the terms already agreed in v1 ("quote in, pass-throughs out, tolling = margin"):
| Line | Amount | Timing |
|---|---|---|
| Deposit | 50% of `tolling` | `beforeStart` 4 wks (with the hard-goods order) |
| BOM funding | 100% of `materials` (hard + soft + outsourced) | `beforeStart` 4 wks (client funds materials upfront) |
| Completion | remainder (= the other 50% of tolling + taxes) | `runEnd` |

Progress payments: none by default; "+ Progress payment" adds a dated line and rebalances completion.

---

## 4. Baseline burn (replaces the Fixed-costs tab)

Overhead is a heartbeat, independent of runs. Capture it once as a flat **monthly** budget by standard P&L category, with a short list of known step-changes.

```ts
type BurnLine = {
  id: string;
  category: BurnCategory;
  label?: string;                 // optional detail, e.g. "Facility lease — 123 Main"
  monthly: number;                // flat $ per month
  dayOfMonth?: number;            // 1–28; when it hits (default 1)
  from?: string; to?: string;     // ISO dates bounding the line (step changes: a loan paying off, a hire)
  notes?: string;
};
type BurnCategory =
  | 'Payroll & benefits' | 'Rent & facilities' | 'Utilities' | 'Insurance'
  | 'Software & subscriptions' | 'Professional services' | 'Marketing'
  | 'Debt service' | 'Other G&A';
```

- **Prompted setup:** the Burn tab presents the categories above as a standard P&L form (one row each, pre-created, $0), so the user fills in a monthly number per line rather than modeling cadences. "+ line" adds a second row within a category.
- **Debt service belongs here** (principal + interest as a flat monthly figure). Consequently the Capital tab becomes **injections only** (equity / debt draws IN); remove its amortization/servicing machinery to avoid double counting. Migrate any existing Capital servicing into a Burn "Debt service" line.
- **Bucketing:** each line lands in the sprint containing its `dayOfMonth` each month within `[from,to]`. Show the **monthly total** and the resulting **per-sprint heartbeat**.
- Non-monthly items are the exception; support `cadence: 'monthly' | 'quarterly' | 'annual' | 'one-time'` on a line only if needed (default monthly). Weekly/biweekly cadences from v1 are dropped (payroll is entered as a monthly figure).

---

## 5. Cash engine (single source of truth — keep it one `useMemo`/hook)

Per sprint `s` (arrays indexed from the view origin):

```
clientIn[s]   = Σ payments landing in s (deposit + bom + progress + completion), non-hidden runs
capitalIn[s]  = Σ equity/debt draws dated in s
materials[s]  = Σ material lines ordering in s, net of linked bills (remaining only)   // hard + soft + outsourced (kept separately for display)
taxes[s]      = Σ run taxes at runEnd in s
burn[s]       = Σ burn lines hitting s
bills[s]      = Σ included Xero AP bills paying in s (sprint of pay date; keep the v1 payDate override → linked line date → max(today, due) precedence)
adjust[s]     = manual adjustment (signed)

net[s]        = clientIn + capitalIn − materials − taxes − burn − bills + adjust
closing[s]    = openingCash + Σ net[0..s]
```
- `floor`, `trough`, breach detection, and the yellow 0-to-floor band carry over unchanged.
- Expose a per-sprint **breakdown** (line items per row) exactly as v1 does for hover, plus a per-week split for the expanded-week view.
- Hidden runs contribute nothing (v1 semantics).

---

## 6. UI

### 6.1 Planner (primary screen)
- **Sprint grid.** Column header shows `Sprint n` + date range; hover shows exact start/end. **Today** marker. Sprint width = the shared column constant; the cash table below uses the same grid so columns align vertically (v1 invariant).
- **Runs as bars** spanning whole sprints. Drag moves by whole sprints (snap); resize handles change `sprints`. Runs that share a sprint **stack in lanes** within the row area (no overlap collision — capacity is not a constraint).
- **Expand in place** (fixes "I can't see what's underlying a run"): a ▸ on each run unfolds sub-rows directly beneath its bar, on the same timeline:
  - **Materials** — one sub-row per line (Hard goods, Soft goods, each Outsourced item): a marker at the order date (before the bar), amount, editable lead-weeks and amount inline.
  - **Payments** — one sub-row per payment line: markers at each date; the completion marker pinned to bar end; amounts/dates editable inline; "+ Progress payment".
  - **Cost summary** — value, tolling, materials total, taxes, and the schedule-balance check.
  All edits happen here; no separate tab is required to change a run.
- Run rail (left): name, client, net cash, hide toggle, drag-to-reorder (keep v1), and the ◀⚠ past-activity flag.
- Keep the **inline Financing** panel (capital injections) and the **Optimize timing** control (now re-times runs by whole sprints).

### 6.2 Cash flow table (below the planner and on the Spreadsheet tab)
Rows (sprint columns; a toggle expands any/all sprints into their two weeks):
1. Client payments (with hover breakdown; optionally 4 sub-rows: Deposits / BOM funding / Progress / Completion)
2. Capital in
3. Materials — Hard goods
4. Materials — Soft goods
5. Outsourced activities
6. Taxes & regulatory
7. Burn (collapsible into the 9 P&L categories)
8. Bills (Xero AP)
9. Manual adjustment (editable, v1)
10. Net change
11. Closing position (red < 0, yellow 0–floor)
Header tooltips show the sprint's date range; cell tooltips show line items (v1 behavior retained).

### 6.3 Burn tab
P&L-style form: the 9 categories as rows, monthly $ each, optional day-of-month and from/to, "+ line" per category. Right side: monthly total, per-sprint heartbeat strip, and the list of upcoming step-changes.

### 6.4 Capital tab
Injections only (equity / debt draw, amount, date). Past-dated flag retained. Servicing removed (lives in Burn).

### 6.5 Accounts payable
Unchanged in concept; bucket by sprint; bills link to a run's **material line** (was: event).

### 6.6 Keep from v1 (do not regress)
Budget scenarios with **manual Save** (dirty derivation), per-scenario **save-merge** and the **read-only duplicate-window guard**, scenario groups, Excel export (update to sprint columns + new rows), hover breakdowns, drag-to-reorder runs, manual adjustment row, past-dated indicators, yellow floor band, Xero import via the `xero_bills` snapshot.

---

## 7. Persistence & migration

- Scenario `state` becomes **version 3**:
  ```ts
  { sprintEpoch, horizonSprints, openingCash, floor, runs: Run[], burn: BurnLine[], capital: Injection[], ap: Bill[], manualAdj: {[sprint]: number}, tab, selId }
  ```
- **Read-time, non-destructive migration v2 → v3** (same pattern as v1's `migrateStore`):
  - `startWeek/duration` → `startSprint = sprintOf(weekDate)`, `sprints = ceil(duration / 2)` (min 1).
  - Events → payments/materials by label heuristics: `Client deposit`→deposit(date), `Client balance`/`End receivable`→**completion**(runEnd), `Ingredients`→soft, `Packaging`/`Freight & BOM`/`Cartoning`/`Carton*`→hard (Cartoning → outsourced), `Taxes*`→taxes, other `in` events→progress(date), other `out` events→outsourced(label). Preserve amounts. Unmapped lines are kept as outsourced/progress so **no money is lost**; list them in a one-time "review migrated lines" banner.
  - `fixed[]` → `burn[]` by category mapping (Payroll→Payroll & benefits, Facilities→Rent & facilities, Debt service→Debt service, etc.; weekly/biweekly amounts converted to monthly ×52/12).
  - Capital debt servicing → a Burn `Debt service` line; capital keeps the draw.
  - Manual adjustments re-bucketed from week index → sprint.
  - Keep the untouched v2 blob under `legacyV2` inside the scenario for one release so nothing is unrecoverable.
- `bumpIdsAll` must scan the new arrays. `storeSig`/dirty derivation, save-merge, and the broadcast guard are unchanged in principle — extend them to the new shape.

---

## 8. Refactor (do this as part of v2, not after)

Split `TreasuryCockpit.jsx` so the engine is testable:
```
src/treasury/
  model/sprints.js        // epoch, sprintOf, sprintStart/End, bucketing
  model/runs.js           // derived dates, default payment template, suite mapping, migration heuristics
  model/burn.js           // burn bucketing
  model/engine.js         // the cash engine (pure) + useCashModel hook
  model/store.js          // v3 shape, migrateStore v2→v3, storeSig, save-merge
  components/Planner.jsx, RunRow.jsx (expand-in-place), CashFlowTable.jsx, BurnTab.jsx, CapitalTab.jsx, APTab.jsx, ScenarioPicker.jsx, ...
  pages/TreasuryCockpit.jsx  // composition + persistence/coordination only
```
Add unit tests (Node) for: sprint bucketing across the epoch, run date derivation, completion auto-balance, no-double-count (bill ↔ material line), v2→v3 migration on a real exported scenario, and the save-merge revert case.

---

## 9. Acceptance criteria

1. The planner and cash table are in **sprint columns** anchored to **Sep 7, 2026**; today's sprint is the first column; header hover shows the exact date range.
2. A run can be placed on any sprint, span N sprints, and **two runs can share a sprint** (rendered in lanes).
3. Moving a run re-times its **material orders** (by lead weeks) and its **completion payment**; **deposit/BOM/progress dates do not move** unless set to "follow run."
4. Every run has a **deposit, ≥1 BOM funding, and a completion** payment; completion auto-balances to the run value and lands at run end.
5. Materials are entered/displayed as **Hard goods, Soft goods, Outsourced**, paid **on order**, with per-line lead weeks; linking a Xero bill to a line **replaces** that portion of the estimate (no double count).
6. Linking a run to a suite run pulls **value, tolling, materials, taxes** from `computeRunResults`; "Refresh from suite" updates costs without touching schedule/payments/overrides.
7. **Burn** is entered as flat monthly amounts by the 9 P&L categories (incl. Debt service), with step-changes, and appears as a heartbeat per sprint; the old Fixed-costs UI is gone and Capital no longer amortizes debt.
8. **Expand in place** shows a run's materials, payments, and cost summary under its bar and lets the user edit them inline without changing tabs.
9. Existing v2 scenarios open correctly after migration with **no cash lost** (Σ in and Σ out per run equal before/after, up to bucketing), and a review banner lists any heuristically mapped lines.
10. All v1 safety features still hold: manual Save with dirty state, per-scenario save-merge, read-only duplicate window, past-dated flags, yellow floor band, hover breakdowns, Excel export (sprint columns).

---

## 10. Suggested phasing

1. **Sprint time model** — sprints module, planner + cash table on sprint columns, migration of `startWeek→startSprint`, alignment. (Everything else defines itself relative to a sprint.)
2. **Payment schedules** — `PaymentLine`, completion anchor + auto-balance, default template, migration of `in` events. (Biggest accuracy leak.)
3. **Materials** — hard/soft/outsourced with lead weeks, on-order timing, suite cost mapping + refresh, bill linking to material lines, migration of `out` events.
4. **Burn** — P&L categories, monthly heartbeat, migration of `fixed[]` + capital servicing; Capital → injections only.
5. **Expand-in-place run rows** + week drill-down in the cash table.
6. **Export / optimizer** updated to sprints; refactor + tests finished; remove `legacyV2` after one release.

Each phase must ship with the scenario save path working end-to-end (manual save + merge + guard), since the user's data is live and shared.

---

## 11. Open items (decide during implementation)
- Default `horizonSprints` (13) and the auto-extend cap (40).
- Whether to persist payment amounts entered as % (proposal: persist $, keep a UI helper for %).
- Deposit default timing: 4 wks before start (with hard-goods order) vs "on PO date." Proposal: default 4 wks before start, editable.
- Progress payment defaults: none.
- Whether the Spreadsheet tab keeps a flat editable grid of every line (proposal: yes, regenerated from the v3 shape).
