import { test } from "node:test";
import assert from "node:assert/strict";
import { BURN_CATEGORIES, defaultBurnLines, burnBySprint, monthlyTotal, migrateFixedToBurn } from "./burn.js";
import { isoLocal, sprintStart } from "./sprints.js";

const E = "2026-09-07"; // Monday, sprint 0
// Window used throughout: origin −1, horizon 8 → sprints −1..6 = Aug 24 → Dec 13 2026.
const ORIGIN = -1, H = 8;

let seq = 0;
const newId = (p) => `${p}_${++seq}`;

test("defaultBurnLines: nine $0 monthly lines in P&L order", () => {
  const lines = defaultBurnLines(newId);
  assert.equal(lines.length, 9);
  assert.deepEqual(lines.map((l) => l.category), [
    "Payroll & benefits", "Rent & facilities", "Utilities", "Insurance",
    "Software & subscriptions", "Professional services", "Marketing", "Debt service", "Other G&A",
  ]);
  assert.deepEqual([...BURN_CATEGORIES], lines.map((l) => l.category));
  for (const l of lines) {
    assert.equal(l.monthly, 0);
    assert.equal(l.dayOfMonth, 1);
    assert.equal(l.cadence, "monthly");
    assert.match(l.id, /^burn_\d+$/);
  }
  assert.equal(new Set(lines.map((l) => l.id)).size, 9);
});

test("burnBySprint: empty / zero horizon are safe", () => {
  const z = burnBySprint([], E, ORIGIN, 0);
  assert.deepEqual(z, { arr: [], items: [], weekly: [] });
  const e = burnBySprint([], E, ORIGIN, H);
  assert.equal(e.arr.length, H);
  assert.equal(e.items.length, H);
  assert.equal(e.weekly.length, 2 * H);
  assert.equal(e.arr.reduce((s, v) => s + v, 0), 0);
});

test("monthly line on the 15th lands in the right sprint across month boundaries, with weekly split", () => {
  const line = { id: "a", category: "Insurance", label: "GL policy", monthly: 3000, dayOfMonth: 15 };
  const { arr, items, weekly } = burnBySprint([line], E, ORIGIN, H);
  // Aug 15 is before the window (Aug 24). Sep 15 → sprint 0 week 1; Oct 15 → sprint 2 week 1;
  // Nov 15 (Sun) → sprint 4 week 1; Dec 15 → sprint 7 (outside horizon).
  assert.deepEqual(arr, [0, 3000, 0, 3000, 0, 3000, 0, 0]);
  const wk = new Array(2 * H).fill(0);
  wk[2 * 1 + 1] = 3000; wk[2 * 3 + 1] = 3000; wk[2 * 5 + 1] = 3000;
  assert.deepEqual(weekly, wk);
  assert.deepEqual(items[1], [{ label: "GL policy", amount: 3000, category: "Insurance" }]);
  assert.deepEqual(items[0], []);
  // weekly always ties out to arr
  for (let i = 0; i < H; i++) assert.equal(weekly[2 * i] + weekly[2 * i + 1], arr[i]);
});

test("monthly line on the 1st lands in week 0 and uses the category as label when unlabeled", () => {
  const line = { id: "b", category: "Rent & facilities", monthly: 16000, dayOfMonth: 1 };
  const { arr, items, weekly } = burnBySprint([line], E, ORIGIN, H);
  // Sep 1 (Tue) → sprint −1 week 1 (Mon Aug 31); Oct 1 (Thu) → sprint 1 week 1 (Mon Sep 28);
  // Nov 1 (Sun) → sprint 3 week 1 (Mon Oct 26); Dec 1 (Tue) → sprint 6 week 0 (Mon Nov 30).
  assert.deepEqual(arr, [16000, 0, 16000, 0, 16000, 0, 0, 16000]);
  assert.equal(weekly[2 * 0 + 1], 16000);
  assert.equal(weekly[2 * 7 + 0], 16000);
  assert.equal(items[0][0].label, "Rent & facilities");
});

test("from/to clips a line: Debt service ending 2026-11-30 does not land in December", () => {
  const open = { id: "c", category: "Debt service", label: "Equipment loan", monthly: 8000, dayOfMonth: 5 };
  const clipped = { ...open, to: "2026-11-30" };
  const a = burnBySprint([open], E, ORIGIN, H).arr;
  const b = burnBySprint([clipped], E, ORIGIN, H).arr;
  // Sep 5 → sprint −1 (i 0); Oct 5 → sprint 2 (i 3); Nov 5 → sprint 4 (i 5); Dec 5 → sprint 6 (i 7).
  assert.deepEqual(a, [8000, 0, 0, 8000, 0, 8000, 0, 8000]);
  assert.deepEqual(b, [8000, 0, 0, 8000, 0, 8000, 0, 0]);
  // `from` clips the front the same way (inclusive bound)
  const late = { ...open, from: "2026-10-05" };
  assert.deepEqual(burnBySprint([late], E, ORIGIN, H).arr, [0, 0, 0, 8000, 0, 8000, 0, 8000]);
  const later = { ...open, from: "2026-10-06" };
  assert.deepEqual(burnBySprint([later], E, ORIGIN, H).arr, [0, 0, 0, 0, 0, 8000, 0, 8000]);
});

test("quarterly steps by 3 months from `from` (or the origin month)", () => {
  const anchored = { id: "d", category: "Insurance", monthly: 9000, cadence: "quarterly", dayOfMonth: 1, from: "2026-09-01" };
  const r1 = burnBySprint([anchored], E, ORIGIN, H);
  // Sep 1 → i 0; Dec 1 → i 7. Oct/Nov must not fire.
  assert.deepEqual(r1.arr, [9000, 0, 0, 0, 0, 0, 0, 9000]);
  assert.equal(r1.arr.reduce((s, v) => s + v, 0), 18000);

  const unanchored = { ...anchored, from: undefined };
  const r2 = burnBySprint([unanchored], E, ORIGIN, H);
  // Origin month is Aug: Aug 1 (outside window), Nov 1 → sprint 3 (i 4). One landing.
  assert.deepEqual(r2.arr, [0, 0, 0, 0, 9000, 0, 0, 0]);

  // A `from` before the window still phases correctly: Jun 1 → Sep 1 → Dec 1
  const early = { ...anchored, from: "2026-06-01" };
  assert.deepEqual(burnBySprint([early], E, ORIGIN, H).arr, [9000, 0, 0, 0, 0, 0, 0, 9000]);
});

test("annual steps by 12 months", () => {
  const line = { id: "e", category: "Professional services", monthly: 12000, cadence: "annual", dayOfMonth: 10, from: "2025-10-10" };
  const { arr } = burnBySprint([line], E, ORIGIN, H);
  // Only Oct 10 2026 falls in the window → sprint 2 (Mon Oct 5), i 3
  assert.deepEqual(arr, [0, 0, 0, 12000, 0, 0, 0, 0]);
});

test("one-time lands exactly once on `from`; without `from` it is skipped", () => {
  const line = { id: "f", category: "Other G&A", label: "Trade show", monthly: 5000, cadence: "one-time", from: "2026-10-20" };
  const { arr, weekly, items } = burnBySprint([line], E, ORIGIN, H);
  // Oct 20 (Tue) → sprint 3 (Mon Oct 19) week 0 → i 4
  assert.deepEqual(arr, [0, 0, 0, 0, 5000, 0, 0, 0]);
  assert.equal(weekly[2 * 4 + 0], 5000);
  assert.equal(items[4][0].label, "Trade show");
  assert.equal(arr.filter(Boolean).length, 1);

  const noFrom = { ...line, from: undefined };
  assert.equal(burnBySprint([noFrom], E, ORIGIN, H).arr.reduce((s, v) => s + v, 0), 0);

  const outside = { ...line, from: "2027-01-05" };
  assert.equal(burnBySprint([outside], E, ORIGIN, H).arr.reduce((s, v) => s + v, 0), 0);
});

test("dayOfMonth is clamped to 1–28 and defaults to 1", () => {
  const a = burnBySprint([{ id: "g", category: "Utilities", monthly: 100, dayOfMonth: 31 }], E, ORIGIN, H);
  const b = burnBySprint([{ id: "g", category: "Utilities", monthly: 100, dayOfMonth: 28 }], E, ORIGIN, H);
  assert.deepEqual(a.arr, b.arr);
  const c = burnBySprint([{ id: "g", category: "Utilities", monthly: 100 }], E, ORIGIN, H);
  const d = burnBySprint([{ id: "g", category: "Utilities", monthly: 100, dayOfMonth: 1 }], E, ORIGIN, H);
  assert.deepEqual(c.arr, d.arr);
});

test("multiple lines aggregate per sprint and $0 lines add no items", () => {
  const lines = [
    ...defaultBurnLines(newId),
    { id: "h", category: "Payroll & benefits", monthly: 47667, dayOfMonth: 1 },
    { id: "i", category: "Rent & facilities", monthly: 16000, dayOfMonth: 1 },
  ];
  const { arr, items } = burnBySprint(lines, E, ORIGIN, H);
  assert.equal(arr[0], 63667);
  assert.equal(items[0].length, 2);
  assert.equal(arr.reduce((s, v) => s + v, 0), 4 * 63667);
});

test("per-sprint cadence spreads monthly × 12/26 onto the start of every sprint, honoring from/to", () => {
  const perSprint = 52000 * 12 / 26; // 24,000
  const lines = [{ id: "p", category: "Payroll & benefits", monthly: 52000, cadence: "per-sprint" }];
  const { arr, weekly, items } = burnBySprint(lines, E, ORIGIN, H);
  for (let i = 0; i < H; i++) { assert.equal(arr[i], perSprint); assert.equal(weekly[2 * i], perSprint); assert.equal(weekly[2 * i + 1], 0); assert.equal(items[i].length, 1); }
  // bounded: starts at the second sprint
  const bounded = [{ ...lines[0], from: isoLocal(sprintStart(ORIGIN + 1, E)) }];
  const b = burnBySprint(bounded, E, ORIGIN, H);
  assert.equal(b.arr[0], 0);
  assert.equal(b.arr[1], perSprint);
  assert.equal(monthlyTotal(lines, "2026-09-04"), 52000);
});

test("monthlyTotal respects the active window and normalizes cadences", () => {
  const lines = [
    { id: "1", category: "Payroll & benefits", monthly: 10000 },
    { id: "2", category: "Rent & facilities", monthly: 5000, to: "2026-08-31" },          // ended
    { id: "3", category: "Marketing", monthly: 3000, from: "2026-10-01" },                 // not yet
    { id: "4", category: "Insurance", monthly: 9000, cadence: "quarterly" },               // 3000/mo
    { id: "5", category: "Professional services", monthly: 12000, cadence: "annual" },     // 1000/mo
    { id: "6", category: "Other G&A", monthly: 5000, cadence: "one-time", from: "2026-09-04" }, // 0
    { id: "7", category: "Utilities", monthly: 700, from: "2026-09-04", to: "2026-09-04" },   // inclusive both ends
  ];
  assert.equal(monthlyTotal(lines, "2026-09-04"), 10000 + 3000 + 1000 + 700);
  assert.equal(monthlyTotal(lines, "2026-08-15"), 10000 + 5000 + 3000 + 1000);
  assert.equal(monthlyTotal(lines, "2026-10-01"), 10000 + 3000 + 3000 + 1000);
  assert.equal(monthlyTotal([], "2026-09-04"), 0);
});

test("migrateFixedToBurn converts cadences, maps categories, and dates week bounds", () => {
  const base = new Date(2026, 8, 7); // Mon Sep 7 2026 = v1 week 0
  const fixed = [
    { id: 1, label: "Production payroll", cat: "Payroll", cadence: "biweekly", amount: 22000, anchorWeek: 0, from: 0, to: null },
    { id: 2, label: "Facility lease", cat: "Facilities", cadence: "monthly", amount: 16000, day: 1, from: 0, to: null },
    { id: 3, label: "Contract cleaner", cat: "Other", cadence: "weekly", amount: 1000, from: 0, to: null },
    { id: 4, label: "Equipment loan", cat: "Debt service", cadence: "monthly", amount: 8000, day: 5, from: 2, to: 5 },
    { id: 5, label: "Insurance (GL / product)", cat: "Insurance", cadence: "quarterly", amount: 900, day: 10, from: 0, to: "" },
    { id: 6, label: "Deposit refund", cat: "Widgets", cadence: "one-time", amount: 2500, week: 3 },
    { id: 7, label: "Software & tools", cat: "Software", cadence: "monthly", amount: 1500, day: 20 },
    { id: 8, label: "Utilities & water", cat: "Utilities", cadence: "annual", amount: 6000, day: 1, from: 0, to: 10 },
  ];
  const out = migrateFixedToBurn(fixed, newId, { base });
  assert.equal(out.length, 8);
  const [payroll, lease, cleaner, loan, ins, oneoff, sw, util] = out;

  assert.equal(payroll.category, "Payroll & benefits");
  assert.equal(payroll.cadence, "per-sprint"); // heartbeats stay spread across sprints
  assert.equal(payroll.monthly, 47667);
  assert.equal(payroll.dayOfMonth, 1);
  assert.equal(payroll.label, "Production payroll");
  assert.equal(payroll.from, undefined);
  assert.equal(payroll.to, undefined);

  assert.equal(lease.category, "Rent & facilities");
  assert.equal(lease.monthly, 16000);
  assert.equal(lease.dayOfMonth, 1);
  assert.equal(lease.cadence, "monthly");

  assert.equal(cleaner.category, "Other G&A");
  assert.equal(cleaner.monthly, 4333); // 1000 × 52 / 12 = 4333.33

  assert.equal(loan.category, "Debt service");
  assert.equal(loan.dayOfMonth, 5);
  assert.equal(loan.from, "2026-09-21");  // base + 14d
  assert.equal(loan.to, "2026-10-18");    // base + 35d + 6d (Sunday closing week 5)

  assert.equal(ins.cadence, "quarterly");
  assert.equal(ins.monthly, 900);
  assert.equal(ins.dayOfMonth, 10);
  assert.equal(ins.to, undefined);        // "" means unbounded

  assert.equal(oneoff.category, "Other G&A");
  assert.equal(oneoff.cadence, "one-time");
  assert.equal(oneoff.monthly, 2500);
  assert.equal(oneoff.from, "2026-09-28"); // base + 21d

  assert.equal(sw.category, "Software & subscriptions");
  assert.equal(sw.dayOfMonth, 20);

  assert.equal(util.category, "Utilities");
  assert.equal(util.cadence, "annual");
  assert.equal(util.to, "2026-11-22");    // base + 70d + 6d

  // every migrated line got a fresh string id from the factory
  for (const l of out) assert.match(l.id, /^burn_\d+$/);
  assert.equal(new Set(out.map((l) => l.id)).size, out.length);
});

test("migrated lines flow through burnBySprint (round trip)", () => {
  const base = new Date(2026, 8, 7);
  const fixed = [
    { id: 1, label: "Facility lease", cat: "Facilities", cadence: "monthly", amount: 16000, day: 1, from: 0, to: null },
    { id: 2, label: "Deposit refund", cat: "Other", cadence: "one-time", amount: 2500, week: 3 },
  ];
  const lines = migrateFixedToBurn(fixed, newId, { base });
  const { arr } = burnBySprint(lines, E, ORIGIN, H);
  // lease: Sep 1 / Oct 1 / Nov 1 / Dec 1 → i 0, 2, 4, 7; one-off Sep 28 → sprint 1 (i 2)
  assert.deepEqual(arr, [16000, 0, 18500, 0, 16000, 0, 0, 16000]);
});
