import { test } from "node:test";
import assert from "node:assert/strict";
import { sprintStart, sprintEnd, sprintIndex, addDays, isoLocal, parseLocalDate, daysBetween } from "./sprints.js";
import {
  STANDARD_MATERIALS,
  DEFAULT_EXTRA_LEAD,
  PALETTE,
  newMaterialLine,
  standardMaterials,
  ensureStandardMaterials,
  newRun,
  runStartDate,
  runEndDate,
  materialOrderDate,
  paymentDate,
  materialsTotal,
  defaultPayments,
  balancePayments,
  ensureCompletion,
  applySuiteCosts,
  quoteToRun,
  migrateRunFromV2,
  runCoverage,
} from "./runs.js";

const E = "2026-09-07"; // Monday, sprint 0
const mkId = () => { let n = 0; return (p) => `${p}_${++n}`; };
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const byLabel = (run, label) => run.materials.find((l) => l.label.toLowerCase() === label.toLowerCase());
const ctx = { epoch: E, originSprint: 0 };

/* ---------------------------------------------------------------- materials */

test("STANDARD_MATERIALS: canonical order, leads and categories", () => {
  assert.deepEqual(
    STANDARD_MATERIALS.map((s) => [s.label, s.leadWeeks, s.category]),
    [["Soft goods", 3, "soft"], ["Cans", 4, "hard"], ["Cartons", 3, "hard"], ["Imported spirits", 4, "soft"], ["Domestic spirits", 2, "soft"]],
  );
  assert.equal(DEFAULT_EXTRA_LEAD, 1);
  assert.ok(PALETTE.length >= 8 && new Set(PALETTE).size === PALETTE.length);
  for (const c of PALETTE) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test("standardMaterials: five lines, $0, feedsSprint 1, ids from newId", () => {
  const lines = standardMaterials(mkId());
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((l) => l.label), STANDARD_MATERIALS.map((s) => s.label));
  for (const l of lines) {
    assert.equal(l.standard, true);
    assert.equal(l.amount, 0);
    assert.equal(l.feedsSprint, 1);
    assert.equal(l.status, "planned");
    assert.match(l.id, /^m_\d+$/);
  }
  assert.equal(lines[1].leadWeeks, 4);
  assert.equal(lines[1].category, "hard");
});

test("newMaterialLine: extra defaults; explicit values win", () => {
  const extra = newMaterialLine({ label: "Labels" }, mkId());
  assert.equal(extra.standard, false);
  assert.equal(extra.leadWeeks, DEFAULT_EXTRA_LEAD);
  assert.equal(extra.category, "outsourced");
  assert.equal(extra.amount, 0);
  const custom = newMaterialLine({ label: "Labels", amount: "1200", leadWeeks: 6, feedsSprint: 2, category: "hard", source: "manual" }, mkId());
  assert.equal(custom.amount, 1200);
  assert.equal(custom.leadWeeks, 6);
  assert.equal(custom.feedsSprint, 2);
  assert.equal(custom.category, "hard");
  assert.equal(custom.source, "manual");
});

test("ensureStandardMaterials: adds missing, keeps values, orders standard-then-extras, idempotent", () => {
  const newId = mkId();
  const input = [
    { id: "x1", label: "Labels", standard: false, amount: 500, leadWeeks: 2, feedsSprint: 1 },
    { id: "x2", label: "cans", standard: true, amount: 9000, leadWeeks: 6, feedsSprint: 2, status: "ordered" },
    { id: "x3", label: "Freight", standard: false, amount: 300, leadWeeks: 1, feedsSprint: 1 },
  ];
  const once = ensureStandardMaterials(input, newId);
  assert.deepEqual(once.map((l) => l.label), ["Soft goods", "Cans", "Cartons", "Imported spirits", "Domestic spirits", "Labels", "Freight"]);
  const cans = once[1];
  assert.equal(cans.id, "x2");
  assert.equal(cans.amount, 9000);
  assert.equal(cans.leadWeeks, 6);
  assert.equal(cans.feedsSprint, 2);
  assert.equal(cans.status, "ordered");
  assert.equal(once[0].amount, 0);
  assert.equal(once[5].id, "x1");
  assert.equal(once[6].id, "x3");
  const twice = ensureStandardMaterials(once, newId);
  assert.deepEqual(twice, once);
  // input untouched
  assert.equal(input.length, 3);
  assert.equal(input[1].label, "cans");
});

/* ---------------------------------------------------------------- dates */

test("run start/end dates from sprint placement", () => {
  const run = { startSprint: 2, sprints: 3 };
  assert.equal(isoLocal(runStartDate(run, E)), isoLocal(sprintStart(2, E)));
  assert.equal(isoLocal(runStartDate(run, E)), "2026-10-05");
  assert.equal(isoLocal(runEndDate(run, E)), isoLocal(sprintEnd(4, E)));
  assert.equal(isoLocal(runEndDate(run, E)), "2026-11-15");
});

test("materialOrderDate: leadWeeks before the sprint it feeds, incl. feedsSprint 2", () => {
  const run = { startSprint: 3, sprints: 2 };
  const s3 = sprintStart(3, E);
  assert.equal(isoLocal(materialOrderDate(run, { leadWeeks: 4, feedsSprint: 1 }, E)), isoLocal(addDays(s3, -28)));
  assert.equal(isoLocal(materialOrderDate(run, { leadWeeks: 0, feedsSprint: 1 }, E)), isoLocal(s3));
  const s4 = sprintStart(4, E);
  assert.equal(isoLocal(materialOrderDate(run, { leadWeeks: 3, feedsSprint: 2 }, E)), isoLocal(addDays(s4, -21)));
  // defaults when fields are missing
  assert.equal(isoLocal(materialOrderDate(run, {}, E)), isoLocal(s3));
});

test("paymentDate: date / runEnd / beforeStart", () => {
  const run = { startSprint: 1, sprints: 2 };
  assert.equal(isoLocal(paymentDate(run, { timing: { mode: "date", date: "2026-12-24" } }, E)), "2026-12-24");
  assert.equal(isoLocal(paymentDate(run, { timing: { mode: "runEnd" } }, E)), isoLocal(sprintEnd(2, E)));
  assert.equal(isoLocal(paymentDate(run, { timing: { mode: "beforeStart", weeks: 4 } }, E)), isoLocal(addDays(sprintStart(1, E), -28)));
});

/* ---------------------------------------------------------------- payments */

test("defaultPayments: deposit 50% tolling, bom = materials, completion = remainder; sums to value", () => {
  const newId = mkId();
  const run = { value: 100000, tolling: 30000, taxes: 2000, materials: [{ amount: 40000 }, { amount: 8000 }] };
  const pays = defaultPayments(run, newId);
  assert.deepEqual(pays.map((p) => [p.kind, p.label, p.amount]), [["deposit", "Deposit", 15000], ["bom", "BOM funding", 48000], ["completion", "Completion", 37000]]);
  assert.deepEqual(pays[0].timing, { mode: "beforeStart", weeks: 4 });
  assert.deepEqual(pays[1].timing, { mode: "beforeStart", weeks: 4 });
  assert.deepEqual(pays[2].timing, { mode: "runEnd" });
  assert.equal(sum(pays, (p) => p.amount), run.value);
  assert.equal(materialsTotal(run), 48000);
  // odd inputs: not clamped
  const odd = defaultPayments({ value: 10000, tolling: 30000, materials: [] }, newId);
  assert.equal(odd[2].amount, -5000);
});

test("balancePayments: completion = value − Σ others, new array, no mutation", () => {
  const run = {
    value: 50000,
    payments: [
      { id: "a", kind: "deposit", label: "Deposit", amount: 10000, timing: { mode: "beforeStart", weeks: 4 } },
      { id: "b", kind: "progress", label: "Progress", amount: 5000, timing: { mode: "date", date: "2026-10-01" } },
      { id: "c", kind: "completion", label: "Completion", amount: 1, timing: { mode: "runEnd" } },
    ],
  };
  const out = balancePayments(run);
  assert.notEqual(out, run.payments);
  assert.equal(out[2].amount, 35000);
  assert.equal(run.payments[2].amount, 1);
  assert.equal(sum(out, (p) => p.amount), 50000);
});

test("ensureCompletion: appends a balanced completion, dedupes extras, forces runEnd", () => {
  const newId = mkId();
  const none = ensureCompletion({ value: 20000, payments: [{ id: "a", kind: "deposit", label: "D", amount: 6000, timing: { mode: "beforeStart", weeks: 4 } }] }, newId);
  assert.equal(none.payments.length, 2);
  assert.equal(none.payments[1].kind, "completion");
  assert.equal(none.payments[1].amount, 14000);
  assert.deepEqual(none.payments[1].timing, { mode: "runEnd" });

  const many = ensureCompletion({
    value: 20000,
    payments: [
      { id: "c1", kind: "completion", label: "C1", amount: 7000, timing: { mode: "date", date: "2026-10-01" } },
      { id: "c2", kind: "completion", label: "C2", amount: 1000, timing: { mode: "runEnd" } },
    ],
  }, newId);
  assert.equal(many.payments.length, 1);
  assert.equal(many.payments[0].id, "c1");
  assert.equal(many.payments[0].amount, 7000); // kept as-is
  assert.deepEqual(many.payments[0].timing, { mode: "runEnd" });
});

test("newRun: defaults from ctx, standard materials, default schedule", () => {
  const run = newRun({ name: "Test" }, mkId(), { epoch: E, originSprint: 5 });
  assert.equal(run.startSprint, 6);
  assert.equal(run.sprints, 1);
  assert.equal(run.materials.length, 5);
  assert.deepEqual(run.payments.map((p) => p.kind), ["deposit", "bom", "completion"]);
  assert.equal(sum(run.payments, (p) => p.amount), run.value);
});

/* ---------------------------------------------------------------- suite */

const COSTS = { totalCost: 120000, rawPackagingCost: 30000, totalIngredientCost: 25000, bomCost: 4000, taxCost: 3000, totalBatchingFees: 6000, tollingCost: 52000 };

test("applySuiteCosts: fills value/tolling/taxes + standard lines, adds batching, builds default schedule", () => {
  const newId = mkId();
  const run = newRun({ name: "Q", payments: [] }, newId, ctx);
  const out = applySuiteCosts({ ...run, payments: [] }, COSTS, newId);
  assert.equal(out.value, 120000);
  assert.equal(out.tolling, 52000);
  assert.equal(out.taxes, 3000);
  assert.equal(byLabel(out, "Soft goods").amount, 25000);
  assert.equal(byLabel(out, "Cans").amount, 30000);
  assert.equal(byLabel(out, "Cartons").amount, 4000);
  assert.equal(byLabel(out, "Imported spirits").amount, 0);
  assert.equal(byLabel(out, "Domestic spirits").amount, 0);
  for (const l of ["Soft goods", "Cans", "Cartons"]) assert.equal(byLabel(out, l).source, "suite");
  const b = byLabel(out, "Batching / cartoning");
  assert.ok(b);
  assert.equal(b.amount, 6000);
  assert.equal(b.standard, false);
  assert.equal(b.category, "outsourced");
  assert.equal(b.leadWeeks, DEFAULT_EXTRA_LEAD);
  assert.equal(b.source, "suite");
  assert.equal(out.materials.length, 6);
  // schedule created since none existed; sums to value
  assert.deepEqual(out.payments.map((p) => p.kind), ["deposit", "bom", "completion"]);
  assert.equal(out.payments[0].amount, 26000);
  assert.equal(out.payments[1].amount, 65000);
  assert.equal(sum(out.payments, (p) => p.amount), 120000);
  // input untouched
  assert.equal(run.value, 0);
});

test("applySuiteCosts: respects source 'manual', keeps existing payments unbalanced, updates batching in place", () => {
  const newId = mkId();
  const first = applySuiteCosts(newRun({ name: "Q", payments: [] }, newId, ctx), COSTS, newId);
  const edited = {
    ...first,
    materials: first.materials.map((l) => (l.label === "Cans" ? { ...l, amount: 99999, source: "manual" } : l)),
    payments: first.payments.map((p) => (p.kind === "deposit" ? { ...p, amount: 1 } : p)),
  };
  const refreshed = applySuiteCosts(edited, { ...COSTS, rawPackagingCost: 31000, totalIngredientCost: 26000, totalBatchingFees: 7000 }, newId);
  assert.equal(byLabel(refreshed, "Cans").amount, 99999);
  assert.equal(byLabel(refreshed, "Cans").source, "manual");
  assert.equal(byLabel(refreshed, "Soft goods").amount, 26000);
  assert.equal(byLabel(refreshed, "Batching / cartoning").amount, 7000);
  assert.equal(refreshed.materials.filter((l) => l.label === "Batching / cartoning").length, 1);
  // payments untouched (not rebalanced)
  assert.deepEqual(refreshed.payments.map((p) => p.amount), edited.payments.map((p) => p.amount));
  assert.equal(refreshed.payments.filter((p) => p.kind === "completion").length, 1);
  // missing cost keys → 0
  const zero = applySuiteCosts(newRun({ name: "Z", payments: [] }, newId, ctx), {}, newId);
  assert.equal(zero.value, 0);
  assert.equal(byLabel(zero, "Cans").amount, 0);
  assert.equal(zero.materials.length, 5);
});

test("quoteToRun: stable string id, palette colour, staggered start, costs + schedule", () => {
  const newId = mkId();
  const r0 = quoteToRun({ id: 42, name: "Hugo's Cocktails", client: "Hugo" }, COSTS, 0, newId, { epoch: E, originSprint: 10 });
  assert.equal(r0.id, "42");
  assert.equal(r0.suiteRunId, "42");
  assert.equal(r0.name, "Hugo's Cocktails");
  assert.equal(r0.client, "Hugo");
  assert.equal(r0.color, PALETTE[0]);
  assert.equal(r0.startSprint, 11);
  assert.equal(r0.sprints, 1);
  assert.equal(r0.value, 120000);
  assert.equal(byLabel(r0, "Cans").amount, 30000);
  assert.equal(sum(r0.payments, (p) => p.amount), 120000);
  const r7 = quoteToRun({ id: "abc", client: "Only client" }, COSTS, 7, newId, { epoch: E, originSprint: 10 });
  assert.equal(r7.name, "Only client");
  assert.equal(r7.color, PALETTE[7 % PALETTE.length]);
  assert.equal(r7.startSprint, 10 + 1 + (7 % 6));
  const r13 = quoteToRun({ id: 1 }, COSTS, 13, newId, { epoch: E, originSprint: 0 });
  assert.equal(r13.name, "Run");
  assert.equal(r13.startSprint, 1 + (13 % 6));
});

/* ---------------------------------------------------------------- migration */

// Shape of v1/v2 SEED_RUNS / quoteEvents in src/pages/TreasuryCockpit.jsx
const V2_BASE = parseLocalDate("2026-08-31"); // Monday of the week the plan was viewed (sprint -1 wrt E)
const v2Events = [
  { id: 101, label: "Client deposit", dir: "in", amount: 60000, anchor: "start", offset: 0 },
  { id: 102, label: "Ingredients", dir: "out", amount: 25000, anchor: "start", offset: 0 },
  { id: 103, label: "Packaging", dir: "out", amount: 30000, anchor: "start", offset: 1 },
  { id: 104, label: "Cartoning", dir: "out", amount: 6000, anchor: "end", offset: 0 },
  { id: 105, label: "Client balance", dir: "in", amount: 60000, anchor: "end", offset: 0 },
];
const v2Run = { id: 7, name: "Chickie's RTD", color: "#586A8C", startWeek: 3, duration: 3, client: "Chickie", fromQuote: true, events: v2Events };

test("migrateRunFromV2: placement, labels, dates and the Σ in / Σ out invariants", () => {
  const newId = mkId();
  const { run, unmapped } = migrateRunFromV2(v2Run, { base: V2_BASE, epoch: E, newId });
  assert.equal(unmapped.length, 0);
  assert.equal(run.id, "7");
  assert.equal(run.suiteRunId, "7");
  assert.equal(run.name, "Chickie's RTD");
  assert.equal(run.client, "Chickie");
  assert.equal(run.color, "#586A8C");

  const startDate = addDays(V2_BASE, 7 * 3); // 2026-09-21 → sprint 1
  assert.equal(run.startSprint, sprintIndex(startDate, E));
  assert.equal(run.startSprint, 1);
  assert.equal(run.sprints, 2); // ceil(3/2)

  // materials
  assert.deepEqual(run.materials.map((l) => l.label), ["Soft goods", "Cans", "Cartons", "Imported spirits", "Domestic spirits"]);
  const soft = byLabel(run, "Soft goods"), cans = byLabel(run, "Cans"), cartons = byLabel(run, "Cartons");
  assert.equal(soft.amount, 25000);
  assert.equal(cans.amount, 30000);
  assert.equal(cartons.amount, 6000);
  for (const l of [soft, cans, cartons]) { assert.equal(l.source, "manual"); assert.equal(l.feedsSprint, 1); }
  // Ingredients @ week 3 == run start → lead 0, order date == run start
  assert.equal(soft.leadWeeks, 0);
  assert.equal(isoLocal(materialOrderDate(run, soft, E)), isoLocal(sprintStart(1, E)));
  // Packaging @ week 4 (after start) → clamped to 0; Cartoning @ week 6 → clamped to 0
  assert.equal(cans.leadWeeks, 0);
  assert.equal(cartons.leadWeeks, 0);
  assert.equal(byLabel(run, "Imported spirits").amount, 0);
  assert.equal(run.taxes, 0);

  // payments
  const dep = run.payments.find((p) => p.kind === "deposit");
  const comp = run.payments.filter((p) => p.kind === "completion");
  assert.equal(dep.amount, 60000);
  assert.deepEqual(dep.timing, { mode: "date", date: isoLocal(addDays(V2_BASE, 21)) });
  assert.equal(comp.length, 1);
  assert.equal(comp[0].amount, 60000);
  assert.deepEqual(comp[0].timing, { mode: "runEnd" });

  // NO MONEY LOST
  const inSum = sum(v2Events.filter((e) => e.dir === "in"), (e) => e.amount);
  const outSum = sum(v2Events.filter((e) => e.dir === "out"), (e) => e.amount);
  assert.equal(sum(run.payments, (p) => p.amount), inSum);
  assert.equal(materialsTotal(run) + run.taxes, outSum);
  assert.equal(run.value, inSum);
  assert.equal(run.tolling, inSum - outSum);
});

test("migrateRunFromV2: leads derive from event dates before run start; extras, taxes, progress and unmapped", () => {
  const newId = mkId();
  const events = [
    { id: 1, label: "Start receivable", dir: "in", amount: 40000, anchor: "start", offset: 0 },
    { id: 2, label: "Milestone", dir: "in", amount: 10000, anchor: "start", offset: 1 },
    { id: 3, label: "End receivable", dir: "in", amount: 30000, anchor: "end", offset: 2 },
    { id: 4, label: "Final payment", dir: "in", amount: 5000, anchor: "end", offset: 3 },
    { id: 5, label: "Packaging", dir: "out", amount: 12000, anchor: "start", offset: -4 },
    { id: 6, label: "Packaging film", dir: "out", amount: 3000, anchor: "start", offset: -2 },
    { id: 7, label: "Freight & BOM", dir: "out", amount: 2500, anchor: "start", offset: 0 },
    { id: 8, label: "Taxes & regulatory", dir: "out", amount: 1800, anchor: "end", offset: 0 },
    { id: 9, label: "COGS", dir: "out", amount: 9000, anchor: "end", offset: -1 },
    { id: 10, label: "Batching", dir: "out", amount: 4000, anchor: "start", offset: 0 },
    { id: 11, label: "Pinned bill", dir: "out", amount: 700, anchor: "start", offset: 0, date: "2026-09-10" },
  ];
  const v2 = { id: 12, name: "Top Dog", color: "#8A7B4F", startWeek: 8, duration: 5, hidden: true, events };
  const { run, unmapped } = migrateRunFromV2(v2, { base: V2_BASE, epoch: E, newId });

  assert.equal(run.hidden, true);
  assert.equal(run.suiteRunId, undefined);
  const startDate = addDays(V2_BASE, 56); // 2026-10-26
  assert.equal(run.startSprint, sprintIndex(startDate, E));
  assert.equal(run.sprints, 3);
  const runStart = sprintStart(run.startSprint, E);

  // Packaging events (weeks 4 and 6) both hit Cans: amounts accumulate, lead = earliest order
  const cans = byLabel(run, "Cans");
  assert.equal(cans.amount, 15000);
  // startWeek 8 = Oct 26, which snaps into the sprint starting Oct 19; Packaging @ week 4 = Sep 28 → 3 weeks ahead
  const expectLead = Math.round(daysBetween(addDays(V2_BASE, 7 * 4), runStart) / 7);
  assert.equal(isoLocal(runStart), "2026-10-19");
  assert.equal(expectLead, 3);
  assert.equal(cans.leadWeeks, 3);
  assert.equal(isoLocal(materialOrderDate(run, cans, E)), "2026-09-28");
  // extras
  const freight = byLabel(run, "Freight & BOM");
  assert.ok(freight && !freight.standard && freight.category === "outsourced");
  assert.equal(freight.amount, 2500);
  assert.equal(byLabel(run, "COGS").amount, 9000);
  assert.equal(byLabel(run, "Batching / cartoning").amount, 4000); // rule-mapped extra (outsourced)
  assert.equal(byLabel(run, "Pinned bill").amount, 700);
  assert.equal(run.taxes, 1800);
  assert.deepEqual(run.materials.slice(0, 5).map((l) => l.label), STANDARD_MATERIALS.map((s) => s.label));

  // payments: "Start receivable" → deposit, "Milestone" → progress, one completion summing the two completion-ish events
  const deposits = run.payments.filter((p) => p.kind === "deposit");
  assert.deepEqual(deposits.map((p) => p.amount), [40000]);
  assert.deepEqual(deposits[0].timing, { mode: "date", date: isoLocal(addDays(V2_BASE, 56)) });
  const progress = run.payments.filter((p) => p.kind === "progress");
  assert.deepEqual(progress.map((p) => p.amount), [10000]);
  const comp = run.payments.filter((p) => p.kind === "completion");
  assert.equal(comp.length, 1);
  assert.equal(comp[0].amount, 35000);

  // review report: only 'out' events that landed in a generic extra line ('in' events always become a payment)
  assert.deepEqual(
    unmapped.map((u) => [u.label, u.dir, u.amount]),
    [["COGS", "out", 9000], ["Pinned bill", "out", 700]],
  );

  // NO MONEY LOST
  const inSum = sum(events.filter((e) => e.dir === "in"), (e) => e.amount);
  const outSum = sum(events.filter((e) => e.dir === "out"), (e) => e.amount);
  assert.equal(sum(run.payments, (p) => p.amount), inSum);
  assert.equal(materialsTotal(run) + run.taxes, outSum);
  assert.equal(run.value, inSum);
  assert.equal(run.tolling, inSum - outSum);
  // source run untouched
  assert.equal(events.length, 11);
  assert.equal(v2.startWeek, 8);
});

test("migrateRunFromV2: no completion event → balanced completion appended; SEED_RUNS shape", () => {
  const newId = mkId();
  const seedLike = {
    id: 1, name: "Seed", color: "#000000", startWeek: 1, duration: 3,
    events: [
      { id: 1, label: "Client deposit", dir: "in", amount: 50000, anchor: "start", offset: 0 },
      { id: 2, label: "Ingredients", dir: "out", amount: 20000, anchor: "start", offset: -3 },
    ],
  };
  const { run } = migrateRunFromV2(seedLike, { base: V2_BASE, epoch: E, newId });
  assert.equal(run.sprints, 2);
  const comp = run.payments.filter((p) => p.kind === "completion");
  assert.equal(comp.length, 1);
  assert.equal(comp[0].amount, 0);
  assert.equal(sum(run.payments, (p) => p.amount), 50000);
  assert.equal(byLabel(run, "Soft goods").leadWeeks, Math.round(daysBetween(addDays(V2_BASE, -14), sprintStart(run.startSprint, E)) / 7));
  assert.equal(run.tolling, 30000);
});

/* ---------------------------------------------------------------- coverage */

test("runCoverage: counts, overdue and firstDue", () => {
  const run = {
    startSprint: 2, sprints: 1, // starts 2026-10-05
    materials: [
      { id: "a", label: "Soft goods", amount: 1000, leadWeeks: 3, feedsSprint: 1, status: "planned" },  // 2026-09-14 → overdue
      { id: "b", label: "Cans", amount: 2000, leadWeeks: 4, feedsSprint: 1, status: "ordered" },        // 2026-09-07 → ordered, ignored
      { id: "c", label: "Cartons", amount: 0, leadWeeks: 3, feedsSprint: 1, status: "planned" },        // $0, ignored
      { id: "d", label: "Imported spirits", amount: 500, leadWeeks: 4, feedsSprint: 1, status: "linked" }, // linked, ignored
      { id: "e", label: "Domestic spirits", amount: 300, leadWeeks: 1, feedsSprint: 1 },                 // 2026-09-28 → pending, not overdue
    ],
  };
  const cov = runCoverage(run, E, "2026-09-20");
  assert.equal(cov.total, 4);
  assert.deepEqual(cov.overdue.map((l) => l.id), ["a"]);
  assert.equal(isoLocal(cov.firstDue), "2026-09-14");

  const later = runCoverage(run, E, "2026-10-01");
  assert.deepEqual(later.overdue.map((l) => l.id), ["a", "e"]);

  const allOrdered = runCoverage({ ...run, materials: run.materials.map((l) => ({ ...l, status: "ordered" })) }, E, "2026-10-01");
  assert.equal(allOrdered.total, 4);
  assert.equal(allOrdered.overdue.length, 0);
  assert.equal(allOrdered.firstDue, null);
});
