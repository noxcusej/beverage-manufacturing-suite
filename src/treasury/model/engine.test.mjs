import { test } from "node:test";
import assert from "node:assert/strict";
import { sprintIndex, sprintStart, sprintEnd, isoLocal, parseLocalDate } from "./sprints.js";
import { newRun, standardMaterials, materialOrderDate, paymentDate, runEndDate } from "./runs.js";
import { burnBySprint } from "./burn.js";
import { computeCash, emptyResult, billPayDate } from "./engine.js";

/* ------------------------------------------------------------------ fixture
 * epoch Mon 2026-09-07 (sprint 0). Window: origin −1, horizon 8 → sprints −1..6:
 *   −1 Aug 24–Sep 6 · 0 Sep 7–20 · 1 Sep 21–Oct 4 · 2 Oct 5–18 · 3 Oct 19–Nov 1
 *    4 Nov 2–15 · 5 Nov 16–29 · 6 Nov 30–Dec 13.   i = k + 1.   today = Sat Aug 29.
 */
const E = "2026-09-07";
const ORIGIN = -1, H = 8, TODAY = "2026-08-29";
const mkId = () => { let n = 0; return (p) => `${p}_${++n}`; };
const sum = (arr) => arr.reduce((t, x) => t + x, 0);
const ctx = { epoch: E, originSprint: ORIGIN };

function setAmounts(lines, amounts) {
  return lines.map((l) => (amounts[l.label] ? { ...l, ...amounts[l.label] } : l));
}

function fixture() {
  const newId = mkId();

  // Run A — starts sprint 2 (Oct 5). Default schedule: deposit 20k + BOM 40k @ Sep 7 (k0), completion 40k @ Oct 18 (k2).
  // Materials: Soft 10k (lead 3 → Sep 14, k0) · Cans 20k (lead 4 → Sep 7, k0) · Cartons 6k (lead 3 → Sep 14, k0)
  //            · Domestic 4k (lead 2 → Sep 21, k1). Taxes 5k @ Oct 18 (k2).
  const runA = newRun(
    {
      id: "A", name: "Alpha", startSprint: 2, sprints: 1, value: 100000, tolling: 40000, taxes: 5000,
      materials: setAmounts(standardMaterials(newId), {
        "Soft goods": { amount: 10000 }, Cans: { amount: 20000, id: "A-cans" }, Cartons: { amount: 6000 }, "Domestic spirits": { amount: 4000 },
      }),
    },
    newId, ctx,
  );

  // Run B — sprints 0..1 (Sep 7 → Oct 4). Explicit schedule: deposit 10k + BOM 23k @ Aug 10 (k−2, PAST),
  // progress 5k @ Dec 20 (k7, FUTURE), completion balances to 22k @ Oct 4 (k1). Taxes 2k @ k1.
  // Materials: Cans 15k lead 4 → Aug 10, 'planned' → OVERDUE, not counted · Soft 5k lead 3 → Aug 17, 'ordered' → not overdue, not counted
  //            · Domestic 3k lead 0 → Sep 7 (k0) counted.
  const runB = newRun(
    {
      id: "B", name: "Bravo", startSprint: 0, sprints: 2, value: 60000, tolling: 20000, taxes: 2000,
      materials: setAmounts(standardMaterials(newId), {
        Cans: { amount: 15000, id: "B-cans" }, "Soft goods": { amount: 5000, status: "ordered", orderedOn: "2026-08-15" }, "Domestic spirits": { amount: 3000, leadWeeks: 0 },
      }),
      payments: [
        { id: "B-dep", kind: "deposit", label: "Deposit", amount: 10000, timing: { mode: "beforeStart", weeks: 4 } },
        { id: "B-bom", kind: "bom", label: "BOM funding", amount: 23000, timing: { mode: "beforeStart", weeks: 4 } },
        { id: "B-prog", kind: "progress", label: "Progress", amount: 5000, timing: { mode: "date", date: "2026-12-20" } },
        { id: "B-comp", kind: "completion", label: "Completion", amount: 22000, timing: { mode: "runEnd" } },
      ],
    },
    newId, ctx,
  );

  // Run C — hidden. Would otherwise put 9k materials, 5k+9k+16k payments and 1k taxes in the window.
  const runC = newRun(
    {
      id: "C", name: "Charlie", hidden: true, startSprint: 1, sprints: 1, value: 30000, tolling: 10000, taxes: 1000,
      materials: setAmounts(standardMaterials(newId), { Cans: { amount: 9000 } }),
    },
    newId, ctx,
  );

  const burn = [
    { id: "burn1", category: "Payroll & benefits", monthly: 30000, dayOfMonth: 1 },            // Sep 1 (k−1), Oct 1 (k1), Nov 1 (k3), Dec 1 (k6)
    { id: "burn2", category: "Rent & facilities", label: "Lease", monthly: 8000, dayOfMonth: 15 }, // Sep 15 (k0), Oct 15 (k2), Nov 15 (k4)
  ];
  const capital = [
    { id: "cap1", type: "equity", label: "Seed top-up", amount: 50000, date: "2026-10-10" }, // k2 → in window
    { id: "cap2", type: "debt", label: "Old draw", amount: 20000, date: "2026-08-01" },     // k−2 → dropped
  ];
  const ap = [
    // linked to Alpha's Cans line; explicit payDate Oct 1 (k1) — the estimate at k0 drops to 8k, the bill flows at k1
    { id: "b1", vendor: "CanCo", ref: "INV-1", billDate: "2026-08-20", dueDate: "2026-09-30", amount: 12000, status: "AUTHORISED", runId: "A", lineId: "A-cans", payDate: "2026-10-01" },
    // unlinked, overdue → max(today, due) = today (k−1)
    { id: "b2", vendor: "Utility Co", billDate: "2026-08-01", dueDate: "2026-08-20", amount: 3000, status: "AUTHORISED" },
    // DRAFT → excluded by default
    { id: "b3", vendor: "Draft Inc", billDate: "2026-09-01", dueDate: "2026-09-10", amount: 999, status: "DRAFT" },
    // PAID but explicitly included → counted at due date Nov 20 (k5)
    { id: "b4", vendor: "Paid Ltd", ref: "R-4", billDate: "2026-10-01", dueDate: "2026-11-20", amount: 1500, status: "PAID", include: true },
  ];
  const manualAdj = { "1": -5000, "-3": 999, "40": 12345 }; // only k=1 is in the window

  return {
    input: { epoch: E, origin: ORIGIN, horizon: H, openingCash: 60000, floor: 26500, runs: [runA, runB, runC], burn, capital, ap, manualAdj, today: TODAY },
    runA, runB, runC,
  };
}

/* ------------------------------------------------------------------ sanity on the fixture's dates */

test("fixture dates land where the comments say", () => {
  const { runA, runB } = fixture();
  const cans = runA.materials.find((l) => l.id === "A-cans");
  assert.equal(isoLocal(materialOrderDate(runA, cans, E)), "2026-09-07");
  assert.equal(isoLocal(paymentDate(runA, runA.payments[0], E)), "2026-09-07");
  assert.equal(isoLocal(runEndDate(runA, E)), "2026-10-18");
  assert.equal(isoLocal(materialOrderDate(runB, runB.materials.find((l) => l.id === "B-cans"), E)), "2026-08-10");
  assert.equal(sprintIndex("2026-12-20", E), 7);
  assert.deepEqual(runA.payments.map((p) => p.amount), [20000, 40000, 40000]);
});

/* ------------------------------------------------------------------ shape */

test("computeCash: result shape and cols", () => {
  const r = computeCash(fixture().input);
  assert.equal(r.origin, ORIGIN);
  assert.equal(r.horizon, H);
  assert.equal(r.cols.length, H);
  assert.deepEqual(r.cols.map((c) => c.k), [-1, 0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.cols.map((c) => c.i), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(r.cols.map((c) => c.ordinal), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(isoLocal(r.cols[0].start), "2026-08-24");
  assert.equal(isoLocal(r.cols[7].end), "2026-12-13");
  assert.equal(r.cols[1].range, "Sep 7 – 20");
  for (const key of ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills", "adjust", "net", "closing"]) {
    assert.equal(r.rows[key].length, H, key);
    assert.equal(r.weekly[key].length, 2 * H, key);
    for (const v of [...r.rows[key], ...r.weekly[key]]) assert.ok(Number.isFinite(v), `${key} finite`);
  }
  for (const key of ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills"]) assert.equal(r.breakdown[key].length, H, key);
  assert.deepEqual(Object.keys(r.materialsByCategory).sort(), ["hard", "outsourced", "soft"]);
  assert.equal(r.orderAhead.length, H);
  assert.deepEqual(Object.keys(r.totals).sort(), ["adjust", "bills", "burn", "capitalIn", "clientIn", "materials", "taxes"]);
});

/* ------------------------------------------------------------------ spot values (hand-computed) */

test("rows: hand-computed cells", () => {
  const r = computeCash(fixture().input);
  // client payments: Alpha deposit+BOM @k0, Bravo completion @k1, Alpha completion @k2; Bravo past/future not counted; Charlie hidden
  assert.deepEqual(r.rows.clientIn, [0, 60000, 22000, 40000, 0, 0, 0, 0]);
  // materials: k0 = Soft 10k + Cans (20k − 12k linked) 8k + Cartons 6k + Bravo Domestic 3k = 27k; k1 = Alpha Domestic 4k
  assert.deepEqual(r.rows.materials, [0, 27000, 4000, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.rows.taxes, [0, 0, 2000, 5000, 0, 0, 0, 0]);
  // bills: b2 pulled to today (k−1), b1 @ its payDate Oct 1 (k1), b4 @ Nov 20 (k5); b3 DRAFT excluded
  assert.deepEqual(r.rows.bills, [3000, 0, 12000, 0, 0, 0, 1500, 0]);
  assert.deepEqual(r.rows.capitalIn, [0, 0, 0, 50000, 0, 0, 0, 0]);
  assert.deepEqual(r.rows.adjust, [0, 0, -5000, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.rows.burn, [30000, 8000, 30000, 8000, 30000, 8000, 0, 30000]);
  // i0 60k−3k−30k · i1 +60k−27k−8k · i2 +22k−4k−2k−30k−12k−5k · i3 +40k+50k−5k−8k · i4 −30k · i5 −8k · i6 −1.5k · i7 −30k
  assert.deepEqual(r.rows.closing, [27000, 52000, 21000, 98000, 68000, 60000, 58500, 28500]);
  assert.equal(r.trough, 21000);
  assert.equal(r.troughI, 2);
  assert.equal(r.ending, 28500);
  assert.equal(r.firstBreach, 2); // floor 26,500: i0 27,000 holds, i2 21,000 breaches
});

/* ------------------------------------------------------------------ arithmetic invariants */

test("net equals the row arithmetic and closing is the running sum from openingCash", () => {
  const { input } = fixture();
  const r = computeCash(input);
  let running = input.openingCash;
  for (let i = 0; i < H; i++) {
    const expect = r.rows.clientIn[i] + r.rows.capitalIn[i] - r.rows.materials[i] - r.rows.taxes[i] - r.rows.burn[i] - r.rows.bills[i] + r.rows.adjust[i];
    assert.equal(r.rows.net[i], expect, `net[${i}]`);
    running += r.rows.net[i];
    assert.equal(r.rows.closing[i], running, `closing[${i}]`);
  }
  assert.equal(r.ending, r.rows.closing[H - 1]);
  assert.equal(r.trough, Math.min(...r.rows.closing));
  assert.equal(r.rows.closing[r.troughI], r.trough);
  const fb = r.rows.closing.findIndex((c) => c < input.floor);
  assert.equal(r.firstBreach, fb === -1 ? H : fb);
});

test("totals equal Σ rows over the window", () => {
  const r = computeCash(fixture().input);
  for (const key of Object.keys(r.totals)) assert.equal(r.totals[key], sum(r.rows[key]), key);
  assert.equal(r.totals.burn, 4 * 30000 + 3 * 8000);
  assert.equal(r.totals.adjust, -5000);
});

test("breakdown amounts per i sum to the row cell", () => {
  const r = computeCash(fixture().input);
  for (const key of ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills"]) {
    for (let i = 0; i < H; i++) {
      assert.equal(sum(r.breakdown[key][i].map((x) => x.amount)), r.rows[key][i], `${key}[${i}]`);
    }
  }
  // labels carry the run/kind context the hover needs
  assert.deepEqual(r.breakdown.clientIn[1].map((x) => [x.label, x.amount, x.runId, x.kind]), [
    ["Alpha — Deposit", 20000, "A", "deposit"],
    ["Alpha — BOM funding", 40000, "A", "bom"],
  ]);
  const cansItem = r.breakdown.materials[1].find((x) => x.lineId === "A-cans");
  assert.equal(cansItem.label, "Alpha — Cans (net of linked bills)");
  assert.equal(cansItem.amount, 8000);
  assert.equal(cansItem.category, "hard");
  assert.deepEqual(r.breakdown.taxes[3], [{ label: "Alpha — taxes & regulatory", amount: 5000, runId: "A" }]);
  assert.deepEqual(r.breakdown.bills[2], [{ label: "CanCo · INV-1", amount: 12000, billId: "b1" }]);
  assert.deepEqual(r.breakdown.bills[0], [{ label: "Utility Co", amount: 3000, billId: "b2" }]);
  assert.deepEqual(r.breakdown.capitalIn[3], [{ label: "Seed top-up", amount: 50000 }]);
  assert.equal(r.breakdown.burn[0][0].category, "Payroll & benefits");
});

test("weekly: sums per sprint equal the sprint rows; flows land in the right week; closing runs across 2H buckets", () => {
  const { input } = fixture();
  const r = computeCash(input);
  for (const key of ["clientIn", "capitalIn", "materials", "taxes", "burn", "bills", "adjust", "net"]) {
    for (let i = 0; i < H; i++) {
      assert.equal(r.weekly[key][2 * i] + r.weekly[key][2 * i + 1], r.rows[key][i], `${key} sprint ${i}`);
    }
  }
  // sprint 0 (i=1): Cans 8k + Bravo Domestic 3k on Mon Sep 7 (week 0); Soft 10k + Cartons 6k on Sep 14 (week 1)
  assert.equal(r.weekly.materials[2], 11000);
  assert.equal(r.weekly.materials[3], 16000);
  // adjust sits in week 0 of its sprint
  assert.equal(r.weekly.adjust[4], -5000);
  assert.equal(r.weekly.adjust[5], 0);
  // pulled-forward bill b2 lands in week 0 of the origin sprint; b1 (Oct 1) is week 1 of sprint 1 (Sep 21–Oct 4)
  assert.equal(r.weekly.bills[0], 3000);
  assert.equal(r.weekly.bills[5], 12000);
  // capital Oct 10 → week 0 of sprint 2 (Oct 5–18)
  assert.equal(r.weekly.capitalIn[6], 50000);
  // weekly closing is a running balance; the end of each sprint's week 1 equals the sprint closing
  let running = input.openingCash;
  for (let w = 0; w < 2 * H; w++) {
    running += r.weekly.net[w];
    assert.equal(r.weekly.closing[w], running, `weekly closing ${w}`);
  }
  for (let i = 0; i < H; i++) assert.equal(r.weekly.closing[2 * i + 1], r.rows.closing[i], `week-end closing ${i}`);
  // burn weekly is burnBySprint's, verbatim
  assert.deepEqual(r.weekly.burn, burnBySprint(input.burn, E, ORIGIN, H).weekly);
});

/* ------------------------------------------------------------------ replace-not-sum */

test("linked bill replaces the material estimate and flows at its own pay date (never both)", () => {
  const f = fixture();
  const withBill = computeCash(f.input);
  const withoutBill = computeCash({ ...f.input, ap: f.input.ap.filter((b) => b.id !== "b1") });
  // estimate at the order sprint (k0 → i1) drops by exactly the bill amount
  assert.equal(withoutBill.rows.materials[1] - withBill.rows.materials[1], 12000);
  assert.equal(withBill.rows.materials[1], 27000);
  // the bill itself lands at its payDate sprint (k1 → i2), not at the order date
  assert.equal(withBill.rows.bills[2] - withoutBill.rows.bills[2], 12000);
  assert.equal(withBill.rows.bills[1], 0);
  // total Cans-related cash over the window is unchanged: 20k either way (8k estimate + 12k bill vs 20k estimate)
  const cansCash = (r) => r.rows.materials[1] + r.rows.bills[2];
  assert.equal(cansCash(withBill), cansCash(withoutBill) + 12000 - 12000 + 0); // 27k+12k == 39k+0
  assert.equal(withBill.totals.materials + withBill.totals.bills, withoutBill.totals.materials + withoutBill.totals.bills);

  // a bill larger than the estimate zeroes the line (never negative) and still flows in full
  const big = computeCash({ ...f.input, ap: [{ ...f.input.ap[0], amount: 25000 }] });
  const cansItem = big.breakdown.materials[1].find((x) => x.lineId === "A-cans");
  assert.equal(cansItem.amount, 0);
  assert.equal(big.rows.materials[1], 27000 - 8000);
  assert.equal(big.rows.bills[2], 25000);

  // an excluded (DRAFT) linked bill does not reduce the estimate and does not flow
  const draft = computeCash({ ...f.input, ap: [{ ...f.input.ap[0], status: "DRAFT", include: undefined }] });
  assert.equal(draft.rows.materials[1], 39000);
  assert.equal(sum(draft.rows.bills), 0);
});

/* ------------------------------------------------------------------ overdue / order-ahead */

test("overdue: planned line ordered before today is listed and NOT in rows; ordered/linked ones are not overdue", () => {
  const f = fixture();
  const r = computeCash(f.input);
  assert.equal(r.overdue.length, 1);
  const o = r.overdue[0];
  assert.equal(o.runId, "B");
  assert.equal(o.runName, "Bravo");
  assert.equal(o.lineId, "B-cans");
  assert.equal(o.label, "Cans");
  assert.equal(o.amount, 15000);
  assert.equal(isoLocal(o.orderDate), "2026-08-10");
  // neither the overdue Cans (15k) nor the ordered Soft goods (5k) are in any row — both are pre-origin
  assert.equal(r.totals.materials, 31000);
  assert.ok(!r.breakdown.materials.flat().some((x) => x.lineId === "B-cans"));
  assert.ok(!r.orderAhead.flat().some((c) => c.lines.some((l) => l.lineId === "B-cans")));

  // marking it ordered clears the flag (cash still not counted: it's pre-origin)
  const runB2 = { ...f.runB, materials: f.runB.materials.map((l) => (l.id === "B-cans" ? { ...l, status: "ordered", orderedOn: TODAY } : l)) };
  const r2 = computeCash({ ...f.input, runs: [f.runA, runB2, f.runC] });
  assert.equal(r2.overdue.length, 0);
  assert.equal(r2.totals.materials, 31000);

  // a linked line whose bills fully cover it is not overdue either
  const runB3 = { ...f.runB, materials: f.runB.materials.map((l) => (l.id === "B-cans" ? { ...l, status: "linked" } : l)) };
  const r3 = computeCash({ ...f.input, runs: [f.runA, runB3, f.runC] });
  assert.equal(r3.overdue.length, 0);
});

test("overdue: an in-window line whose order date is before today is counted AND flagged", () => {
  const f = fixture();
  // Bravo Domestic lead 0 → Sep 7; give it lead 2 → Aug 24 (k−1, in window, before Aug 29)
  const runB = { ...f.runB, materials: f.runB.materials.map((l) => (l.label === "Domestic spirits" ? { ...l, leadWeeks: 2 } : l)) };
  const r = computeCash({ ...f.input, runs: [f.runA, runB, f.runC] });
  assert.equal(r.rows.materials[0], 3000);
  assert.ok(r.overdue.some((o) => o.runId === "B" && o.label === "Domestic spirits" && isoLocal(o.orderDate) === "2026-08-24"));
});

test("orderAhead: per-sprint commitments with feedsK, totals and counts", () => {
  const r = computeCash(fixture().input);
  for (let i = 0; i < H; i++) {
    const cell = r.orderAhead[i];
    assert.equal(cell.i, i);
    assert.equal(cell.k, ORIGIN + i);
    assert.equal(cell.total, r.rows.materials[i], `orderAhead total ${i}`);
    assert.equal(cell.total, sum(cell.lines.map((l) => l.amount)));
    assert.equal(cell.count, cell.lines.filter((l) => l.amount > 0).length);
  }
  const s0 = r.orderAhead[1];
  assert.equal(s0.count, 4);
  const cans = s0.lines.find((l) => l.lineId === "A-cans");
  assert.equal(cans.runName, "Alpha");
  assert.equal(cans.amount, 8000);
  assert.equal(cans.feedsK, 2);
  assert.equal(isoLocal(cans.orderDate), "2026-09-07");
  const bravoDom = s0.lines.find((l) => l.runId === "B");
  assert.equal(bravoDom.feedsK, 0);
  // materialsByCategory groups the same cash
  for (let i = 0; i < H; i++) {
    assert.equal(r.materialsByCategory.hard[i] + r.materialsByCategory.soft[i] + r.materialsByCategory.outsourced[i], r.rows.materials[i]);
  }
  assert.equal(r.materialsByCategory.hard[1], 8000 + 6000);
  assert.equal(r.materialsByCategory.soft[1], 10000 + 3000);
});

/* ------------------------------------------------------------------ hidden runs & perRun */

test("hidden run contributes nothing to rows but has perRun", () => {
  const f = fixture();
  const r = computeCash(f.input);
  const without = computeCash({ ...f.input, runs: [f.runA, f.runB] });
  assert.deepEqual(r.rows, without.rows);
  assert.deepEqual(r.weekly, without.weekly);
  assert.deepEqual(r.overdue, without.overdue);
  assert.ok(r.perRun.C);
  assert.equal(r.perRun.C.inTotal, 30000);
  assert.equal(r.perRun.C.outTotal, 9000 + 1000);
  assert.equal(r.perRun.C.net, 30000 - 10000);
  assert.equal(r.perRun.C.coverage.total, 1);
  assert.ok(!without.perRun.C);

  // perRun for visible runs
  assert.equal(r.perRun.A.inTotal, 100000);
  assert.equal(r.perRun.A.outTotal, 40000 + 5000); // gross materials (20k Cans, not net of the bill) + taxes
  assert.equal(r.perRun.A.net, 55000);
  assert.equal(r.perRun.A.pastPayments, 0);
  assert.equal(r.perRun.A.futurePayments, 0);
  assert.deepEqual(r.perRun.A.coverage, { total: 4, overdue: 0, firstDue: parseLocalDate("2026-09-07") });

  assert.equal(r.perRun.B.inTotal, 60000);
  assert.equal(r.perRun.B.pastPayments, 33000);   // deposit + BOM @ Aug 10
  assert.equal(r.perRun.B.futurePayments, 5000);  // progress @ Dec 20 (k7, past the horizon)
  assert.equal(r.perRun.B.outTotal, 23000 + 2000);
  assert.equal(r.perRun.B.coverage.total, 3);
  assert.equal(r.perRun.B.coverage.overdue, 1);
  assert.equal(isoLocal(r.perRun.B.coverage.firstDue), "2026-08-10");
});

/* ------------------------------------------------------------------ capital, adjust */

test("capital: in-window injections count; pre-origin / post-horizon ones are dropped and reported", () => {
  const f = fixture();
  const r = computeCash(f.input);
  assert.equal(r.totals.capitalIn, 50000);
  assert.deepEqual(r.droppedCapital.map((c) => c.id), ["cap2"]);
  const late = { id: "cap3", type: "equity", label: "Late", amount: 1, date: "2026-12-14" }; // k7
  const bad = { id: "cap4", type: "equity", label: "Undated", amount: 1, date: "" };
  const r2 = computeCash({ ...f.input, capital: [...f.input.capital, late, bad] });
  assert.deepEqual(r2.droppedCapital.map((c) => c.id), ["cap2", "cap3", "cap4"]);
  assert.equal(r2.totals.capitalIn, 50000);
});

test("manualAdj: keys are absolute k; signed; out-of-window keys ignored", () => {
  const f = fixture();
  const r = computeCash({ ...f.input, manualAdj: { "-1": 1000, "6": -250, "7": 5, "x": 3, "0": "2500" } });
  assert.deepEqual(r.rows.adjust, [1000, 2500, 0, 0, 0, 0, 0, -250]);
  const r2 = computeCash({ ...f.input, manualAdj: undefined });
  assert.deepEqual(r2.rows.adjust, zerosLike(H));
});
function zerosLike(n) { return new Array(n).fill(0); }

/* ------------------------------------------------------------------ billPayDate */

test("billPayDate: payDate override → linked line order date → max(today, dueDate)", () => {
  const f = fixture();
  const bctx = { runs: f.input.runs, epoch: E, today: TODAY };
  const linked = f.input.ap[0];
  assert.equal(billPayDate(linked, bctx), "2026-10-01");                              // 1. override
  assert.equal(billPayDate({ ...linked, payDate: undefined }, bctx), "2026-09-07");    // 2. Alpha Cans order date
  assert.equal(billPayDate({ ...linked, payDate: "", runId: undefined }, bctx), "2026-09-07"); // linked by lineId alone
  assert.equal(billPayDate({ ...linked, payDate: undefined, lineId: "nope" }, bctx), "2026-09-30"); // dangling link → due (after today)
  assert.equal(billPayDate(f.input.ap[1], bctx), TODAY);                               // 3. due Aug 20 < today → today
  assert.equal(billPayDate({ ...f.input.ap[1], dueDate: "2026-09-03" }, bctx), "2026-09-03"); // due after today → due
  assert.equal(billPayDate({ ...f.input.ap[1], dueDate: "" }, bctx), TODAY);           // no due date → today
  assert.equal(billPayDate({ ...f.input.ap[1], dueDate: "2026-09-03" }, { runs: [], epoch: E }), "2026-09-03"); // no today → due

  // the engine buckets by the same precedence: linked bill without override flows at the order date (k0)
  const r = computeCash({ ...f.input, ap: [{ ...linked, payDate: undefined }] });
  assert.equal(r.rows.bills[1], 12000);
  assert.equal(r.rows.bills[2], 0);
  // a pre-origin pay date is pulled to the origin sprint
  const r2 = computeCash({ ...f.input, ap: [{ ...linked, payDate: "2026-07-01" }] });
  assert.equal(r2.rows.bills[0], 12000);
  assert.equal(r2.weekly.bills[0], 12000);
  // a post-horizon pay date is not counted
  const r3 = computeCash({ ...f.input, ap: [{ ...linked, payDate: "2026-12-14" }] });
  assert.equal(sum(r3.rows.bills), 0);
  assert.equal(r3.rows.materials[1], 27000); // …but it still nets the estimate (it is an included linked bill)
});

/* ------------------------------------------------------------------ robustness */

test("missing arrays, garbage numbers and an empty horizon never produce NaN", () => {
  const r = computeCash({ epoch: E, origin: ORIGIN, horizon: H, openingCash: "abc", floor: null, today: TODAY });
  assert.deepEqual(r.rows.closing, zerosLike(H));
  assert.equal(r.firstBreach, H);
  assert.equal(r.trough, 0);
  assert.equal(r.ending, 0);
  assert.deepEqual(r.perRun, {});

  const f = fixture();
  const dirty = {
    ...f.input,
    runs: [{ ...f.runA, taxes: "x", payments: [{ ...f.runA.payments[0], amount: NaN }, ...f.runA.payments.slice(1)], materials: [{ ...f.runA.materials[0], amount: "oops" }, ...f.runA.materials.slice(1)] }],
    capital: [{ id: "c", type: "equity", amount: undefined, date: "2026-10-10" }],
    ap: [{ id: "z", vendor: "V", amount: "12", status: "AUTHORISED", dueDate: "2026-10-01" }],
    manualAdj: { "0": "not a number" },
  };
  const d = computeCash(dirty);
  for (const key of Object.keys(d.rows)) for (const v of d.rows[key]) assert.ok(Number.isFinite(v), key);
  assert.equal(d.rows.bills[2], 12);
  assert.ok(Number.isFinite(d.perRun.A.net));

  const z = computeCash({ ...f.input, horizon: 0 });
  assert.equal(z.horizon, 0);
  assert.deepEqual(z.rows.closing, []);
  assert.equal(z.ending, f.input.openingCash);
  assert.equal(z.trough, f.input.openingCash);
  assert.equal(z.firstBreach, 0);
  assert.deepEqual(z.droppedCapital.map((c) => c.id), ["cap1", "cap2"]);
});

test("computeCash is pure and deterministic", () => {
  const f = fixture();
  const snapshot = JSON.stringify(f.input);
  const a = computeCash(f.input);
  const b = computeCash(f.input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(f.input), snapshot);
  // no clock: a different `today` (not a different wall clock) is what moves the numbers
  const later = computeCash({ ...f.input, today: "2026-09-20" });
  assert.notDeepEqual(later.rows.bills, a.rows.bills); // b2 max(today, due) moves from k−1 to k0
  assert.equal(later.rows.bills[1], 3000);
});

/* ------------------------------------------------------------------ emptyResult */

test("emptyResult: zeroed Result of the same shape", () => {
  const e = emptyResult({ epoch: E, origin: ORIGIN, horizon: H, openingCash: 12345 });
  const r = computeCash(fixture().input);
  assert.deepEqual(Object.keys(e).sort(), Object.keys(r).sort());
  assert.deepEqual(Object.keys(e.rows).sort(), Object.keys(r.rows).sort());
  assert.deepEqual(Object.keys(e.weekly).sort(), Object.keys(r.weekly).sort());
  assert.deepEqual(Object.keys(e.breakdown).sort(), Object.keys(r.breakdown).sort());
  assert.deepEqual(Object.keys(e.totals).sort(), Object.keys(r.totals).sort());
  assert.deepEqual(e.cols.map((c) => c.k), r.cols.map((c) => c.k));
  for (const key of Object.keys(e.rows)) {
    if (key === "closing") { assert.deepEqual(e.rows.closing, new Array(H).fill(12345)); continue; }
    assert.deepEqual(e.rows[key], zerosLike(H), key);
    assert.deepEqual(e.weekly[key], zerosLike(2 * H), key);
  }
  assert.deepEqual(e.weekly.closing, new Array(2 * H).fill(12345));
  for (const key of Object.keys(e.breakdown)) assert.deepEqual(e.breakdown[key], Array.from({ length: H }, () => []));
  assert.deepEqual(e.orderAhead.map((c) => [c.k, c.i, c.total, c.count, c.lines.length]), r.cols.map((c) => [c.k, c.i, 0, 0, 0]));
  assert.deepEqual(e.overdue, []);
  assert.deepEqual(e.droppedCapital, []);
  assert.deepEqual(e.perRun, {});
  assert.equal(e.trough, 12345);
  assert.equal(e.ending, 12345);
  assert.equal(e.firstBreach, H);
  for (const v of Object.values(e.totals)) assert.equal(v, 0);
  // equals computeCash on an empty scenario
  const blank = computeCash({ epoch: E, origin: ORIGIN, horizon: H, openingCash: 12345, floor: 0, today: TODAY });
  assert.deepEqual(blank, e);
  // defaults when called with nothing
  const nothing = emptyResult();
  assert.equal(nothing.horizon, 0);
  assert.deepEqual(nothing.cols, []);
});

/* ------------------------------------------------------------------ sprint helpers stay the reference */

test("engine buckets agree with sprints.js for every counted flow", () => {
  const f = fixture();
  const r = computeCash(f.input);
  for (const run of [f.runA, f.runB]) {
    for (const p of run.payments) {
      const k = sprintIndex(paymentDate(run, p, E), E);
      if (k < ORIGIN || k >= ORIGIN + H) continue;
      assert.ok(r.breakdown.clientIn[k - ORIGIN].some((x) => x.runId === run.id && x.kind === p.kind), `${run.id} ${p.kind}`);
    }
  }
  assert.ok(sprintStart(ORIGIN, E) <= parseLocalDate(TODAY) && parseLocalDate(TODAY) <= sprintEnd(ORIGIN, E));
});
