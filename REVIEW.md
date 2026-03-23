# Code Review — beverage-manufacturing-suite

**Reviewer:** installer (bev-suite)
**Date:** 2026-03-23
**Server:** http://localhost:8001

---

## Architecture Overview

React 19 + Vite 7 SPA with React Router 7. Data layer uses an in-memory cache (`src/data/store.js`) backed by Supabase with write-through persistence. A custom event bus (`comanufacturing:datachange` CustomEvent) notifies all components of data changes. No external state library (no Redux/Zustand). Excel export via `xlsx` library.

---

## Module Summary

### src/main.jsx + src/App.jsx
Entry point. Initializes store, hydrates from Supabase, renders routes. Routes defined: `/`, `/batch-calculator`, `/copacking`, `/inventory`, `/packaging`, `/formulas`, `/summary`, `/clients`, `/clients/:clientName`.

### src/data/store.js
Central in-memory data store. Exports typed getters/setters for: inventory, packaging, services, vendors, formulas, currentBatch, tankConfig, runs, clients, missionControl. All writes trigger Supabase write-through. Formula saves include versioning (snapshots of previous state).

### src/data/supabase.js
Supabase client. Two storage patterns: (1) generic `app_data` table (key/JSONB blob) for most domains; (2) dedicated `formulas` table for formula data. Reads env vars `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

### src/data/defaults.js
Default seed data: 6 inventory items, 5 packaging items, 5 services, 12 vendors, 3 tank configs, 6 team members. Also exports `defaultTeam` used by MissionControl.

### src/data/drayhorsePricing.js
Drayhorse carton pricing grid (September 2025). 8 products × 9 quantity tiers × 4 SKU counts. `lookupPrice()` utility returns price-per-M, total cost, per-carton price. `NEW_ART_PREP_FEE = 296`.

### src/pages/BatchCalculator.jsx (93KB)
Largest file. Recipe scaling calculator: load/save formulas, add ingredients from inventory, scale to batch size, compute unit economics. Includes version history, Excel export.

### src/pages/CoPackingCalculator.jsx (60KB)
Run quoting: multi-SKU flavors, packaging line items, tolling fees, BOM items, taxes. Drayhorse carton pricing integration. Excel export.

### src/pages/FormulaLibrary.jsx (28KB)
Formula management: grouped by client folder, drag-to-reorder, search, version history viewer, JSON import/export, batch dispatch to BatchCalculator.

### src/pages/Inventory.jsx (28KB)
Ingredient inventory CRUD: tiered pricing editor, vendor assignment, stock levels, reorder points, unit conversions.

### src/pages/Packaging.jsx (19KB)
Packaging materials CRUD: tiered pricing, lead times, category tags, vendor assignment.

### src/pages/Summary.jsx (19KB)
Run cost summary: pulls from saved runs, computes per-unit/per-case/per-pack/per-pallet costs, pricing calculator (FOB → distributor → retail chain).

### src/pages/MissionControl.jsx (13KB)
Task kanban board (todo/in-progress/done), calendar view, cron jobs tab, team grid, office status view. **UNREACHABLE** — no route defined.

### src/pages/ClientProfile.jsx (14KB)
Client CRM: list view + detail view. Tracks contacts, links to formulas and runs, logo upload, Pipedrive URL, notes.

### src/pages/Services.jsx (7KB)
Co-packing services CRUD: fee type (per-unit/fixed/per-batch/per-pallet), rates, minimums, lead times. **UNREACHABLE** — no route defined.

### src/components/Layout.jsx
App shell: sidebar nav (8 links), topbar (search, Reports, History), batch info banner, CommandPalette.

### src/components/CommandPalette.jsx
Cmd+K palette with 7 hardcoded commands. Navigation only; no action commands.

### src/components/TypeAhead.jsx
Reusable typeahead/autocomplete component.

### src/hooks/useLocalStorageSync.js
Thin hook wrapping the datachange event listener + a getter. Misleadingly named (no localStorage involved).

### src/hooks/useKeyboardShortcuts.js
Declarative keyboard shortcut registration. Respects Ctrl/Meta, Shift, and suppresses shortcuts in inputs.

### src/utils/exportExcel.js
Two export functions: `exportCoPackingToExcel` and `exportBatchToExcel`. Builds XLSX sheets with native formulas for live recalculation.

---

## Bugs Found

### Critical

1. **MissionControl has no route** (`src/App.jsx`)
   `src/pages/MissionControl.jsx` exists and is fully implemented but is never imported or routed. Path `/mission-control` is referenced in `CommandPalette.jsx` but leads nowhere.

2. **Services has no route** (`src/App.jsx`)
   `src/pages/Services.jsx` exists but is never imported or routed. Path `/services` in `CommandPalette.jsx` is a dead link.

3. **ID collision on delete-then-add** (`src/data/store.js:149,186,222`)
   `addInventoryItem`, `addPackagingItem`, and `addService` all generate IDs using `array.length + 1`. After any deletion, the next added item gets a duplicate ID. Example: delete INV-002 from a 6-item list → next add produces INV-006 again.

### Moderate

4. **Formula name fallback overwrites wrong formula** (`src/data/store.js:293`)
   `saveFormula` matches by name when no ID match is found. Two formulas with the same name (different clients) results in the second overwriting the first.

5. **CommandPalette has 2 dead routes** (`src/components/CommandPalette.jsx:8,10`)
   `/services` and `/mission-control` don't exist in the router. Navigating to them renders a blank/unmatched route.

6. **TaskCard defined inside parent component** (`src/pages/MissionControl.jsx:132`)
   `TaskCard` is a nested function component. React re-creates it every render, causing unnecessary unmount/remount of all task cards on any state change.

7. **TaskCard assignee label wrong for non-gilbert team members** (`src/pages/MissionControl.jsx:133`)
   `task.assignee === 'me' ? 'Me' : 'Gilbert'` — any other assignee shows as "Gilbert". Tasks can be assigned to all team members via the form but only two labels work.

8. **Hardcoded Supabase credentials** (`public/batch-calculator-v4.html:~1300`)
   Supabase URL and anon key are hardcoded in plain JS in a committed file. Anon keys are typically safe to expose but this is bad practice; should use env vars or be scrubbed.

### Minor

9. **Topbar search is non-functional** (`src/components/Layout.jsx:84`)
   Input renders but has no `onChange`, `onSubmit`, or search logic wired up.

10. **Dead anchor links in sidebar footer** (`src/components/Layout.jsx:72-77`)
    `#settings` and `#support` go nowhere. No settings page exists.

11. **Dead anchor links in topbar** (`src/components/Layout.jsx:90-91`)
    `#reports` and `#history` go nowhere.

12. **MissionControl Calendar shows no events** (`src/pages/MissionControl.jsx:240`)
    Calendar renders correctly but no task due dates are plotted. Purely decorative.

13. **Cron Jobs tab entirely unimplemented** (`src/pages/MissionControl.jsx:264`)
    Just shows placeholder text. No UI to create/edit/delete cron jobs despite the data field existing.

14. **hydrateAll() silently swallows errors** (`src/data/store.js:100`)
    `Promise.allSettled` results are captured in `results` but never inspected. Failed domain hydrations are invisible.

15. **Default MissionControl tasks contain dev notes** (`src/pages/MissionControl.jsx:39-43`)
    Seed tasks reference internal dev work ("Fix packaging button", "Build Mission Control dashboard"). These ship to users as real task content.

16. **drayhorsePricing.js die is 'TBD' string** (`src/data/drayhorsePricing.js:136`)
    `standard-8pk` has `die: 'TBD'`. Should be `null` or the actual die number.

17. **ClientProfile uses browser prompt/confirm** (`src/pages/ClientProfile.jsx:59,68,74,80`)
    For adding clients, formulas, runs, contacts. Blocked in some embedded/iframe contexts. Poor UX.

---

## Dead Code Found

### Duplicate Root-Level JS Files
The following files at the repo root are **exact byte-for-byte duplicates** of their `public/` counterparts. They are not imported by the React app:
- `mission-control.js` = `public/mission-control.js`
- `command-palette.js` = `public/command-palette.js`
- `shared-data.js` ≈ `public/shared-data.js` (public version is newer/more complete)

**Recommendation:** Delete the root-level copies.

### Legacy HTML (public/legacy/ + legacy-html/)
The React app supersedes these standalone HTML tools entirely:
- `public/legacy/batch-calculator-v4.html` (3933 lines)
- `public/legacy/copacking-calculator.html` (1942 lines)
- `public/legacy/inventory.html` (1357 lines)
- `public/legacy/mission-control.html` (750 lines)
- `public/legacy/services.html` (1060 lines)
- `legacy-html/packaging.html` (1311 lines)

**Total: ~10,353 lines of superseded code.**

### public/batch-calculator-v4.html (Active but Orphaned)
`public/batch-calculator-v4.html` (4178 lines) is a standalone HTML app that appears to be the "current" non-React version. It has newer features vs `public/legacy/` (Supabase sync, formula IDs, client folders). It is not linked from the React app's index.html and appears to be a parallel development track that should either be deprecated or explicitly maintained.

### Supabase Migration 001
`supabase/migrations/001_create_inventory_table.sql` creates a Katana-integration inventory table with `katana_id`, `katana_variant_id`, `katana_last_sync` columns. The app uses the `app_data` blob table from migration 002 instead. The dedicated inventory table and all Katana integration columns are unused.

### useLocalStorageSync Hook
`src/hooks/useLocalStorageSync.js` is a wrapper with a misleading name (no localStorage). It's not used by any page — each page implements its own identical `window.addEventListener('comanufacturing:datachange', handler)` pattern directly.

---

## Security Concerns

1. **Supabase RLS is wide open** (`supabase/migrations/001 + 002`)
   Both tables use `FOR ALL USING (true) WITH CHECK (true)` — unauthenticated reads and writes are allowed. Acceptable for local dev; must be locked to authenticated users before production deployment.

2. **Hardcoded credentials in committed file** (`public/batch-calculator-v4.html`)
   Supabase URL and anon key hardcoded in JS. Anon keys are designed to be public, but this pattern breaks key rotation and differs from the React app's correct env var approach.

---

## Recommended Removals

| File/Path | Lines | Reason |
|---|---|---|
| `mission-control.js` (root) | 620 | Exact duplicate of public/ |
| `command-palette.js` (root) | 198 | Exact duplicate of public/ |
| `shared-data.js` (root) | 498 | Older version of public/shared-data.js |
| `public/legacy/` (entire dir) | ~9,042 | All superseded by React app |
| `legacy-html/packaging.html` | 1,311 | Superseded by React Packaging page |
| `supabase/migrations/001_create_inventory_table.sql` | 32 | Unused (Katana integration never built) |

**Total removable: ~11,700 lines**

---

## Recommended Improvements

1. **Add missing routes** — Register `/mission-control` and `/services` in `App.jsx` and add nav links in `Layout.jsx`.

2. **Fix CommandPalette routes** — Update dead `/services` and `/mission-control` entries to match actual routes, or add those routes first.

3. **Fix ID generation** — Replace `array.length + 1` ID generation with `Date.now()` or UUID-based IDs (pattern already used for formulas, runs, clients).

4. **Extract TaskCard** — Move `TaskCard` out of `MissionControl` component to prevent unnecessary re-mounting.

5. **Implement Calendar event display** — Plot tasks with due dates on the calendar grid.

6. **Implement or remove Cron Jobs tab** — Either build the UI or remove the tab from MissionControl.

7. **Replace prompt/confirm in ClientProfile** — Use inline form modals or inline edit UI.

8. **Rename useLocalStorageSync** — Rename to `useStoreSync` or `useDataSync` to reflect actual behavior.

9. **Implement topbar search** — Wire up the search input to filter across formulas, runs, inventory.

10. **Implement Settings** — Replace `#settings` dead link with a real settings route.

11. **Clear dev seed tasks** — Remove hardcoded dev-notes tasks from MissionControl defaults.

12. **Check hydration errors** — Inspect `results` from `Promise.allSettled` in `hydrateAll` and surface errors to the user.

---

## Server Status

Local HTTP server running at `http://localhost:8001` (serves `index.html` — React app requires `npm run dev` for full functionality due to JSX/module bundling; raw file serving works for static assets only).
