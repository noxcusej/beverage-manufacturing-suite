import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORE_KEY,
  LEGACY_KEY,
  newId,
  canon,
  storeSig,
  isV3,
  migrateLegacyToV3,
  normalizeStore,
  mergeScenarios,
  emptyScenarioState,
  newScenario,
} from "./store.js";
import { STANDARD_MATERIALS } from "./runs.js";
import { BURN_CATEGORIES } from "./burn.js";

const EPOCH = "2026-09-07"; // Monday, sprint 0
const TODAY = "2026-08-29"; // Saturday → base Monday 2026-08-24 (sprint −1)
const mkId = () => { let n = 0; return (p) => `${p}_${++n}`; };
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const byLabel = (lines, label) => lines.find((l) => l.label.toLowerCase() === label.toLowerCase());

/* ---------------------------------------------------------------- fixtures */

function v2Fixture() {
  const scenarioA = {
    id: 1,
    name: "Base case",
    group: "2026",
    notes: "primary plan",
    updatedAt: 1000,
    state: {
      openingCash: 60000,
      floor: 25000,
      tab: "fixed",
      selId: 10,
      projects: [
        {
          id: 10, name: "Tiki Haka R1", color: "#586A8C", startWeek: 4, duration: 3,
          events: [
            { id: 101, label: "Client deposit", dir: "in", amount: 41000, anchor: "start", offset: 0 },
            { id: 102, label: "Client balance", dir: "in", amount: 52500, anchor: "end", offset: 0 },
            { id: 103, label: "Ingredients", dir: "out", amount: 19500, anchor: "start", offset: 0 },
            { id: 104, label: "Packaging", dir: "out", amount: 48000, anchor: "start", offset: -2 },
            { id: 105, label: "Cartoning", dir: "out", amount: 6000, anchor: "start", offset: 1 },
          ],
        },
      ],
      fixed: [
        { id: 40, label: "Production payroll", cat: "Payroll", cadence: "biweekly", amount: 22000, anchorWeek: 0, from: 0, to: null },
        { id: 41, label: "Facility lease", cat: "Facilities", cadence: "monthly", amount: 16000, day: 1, from: 0, to: null },
        { id: 42, label: "Equipment loan", cat: "Debt service", cadence: "monthly", amount: 8000, day: 5, from: 0, to: null },
      ],
      capital: [
        { id: 20, type: "equity", label: "Seed bridge", amount: 200000, date: "2026-09-05", rate: 0, termMonths: 0, repay: "none" },
        { id: 21, type: "debt", label: "Term loan", amount: 250000, date: "2026-10-01", rate: 9, termMonths: 36, repay: "amortizing" },
      ],
      ap: [
        { id: 30, xeroId: "x-30", vendor: "Ball Corp", ref: "INV-1", billDate: "2026-08-20", dueDate: "2026-09-20", amount: 12000, status: "AUTHORISED", include: true, runId: 10, eventId: 104 },
        { id: 31, vendor: "Misc Supply", ref: "INV-2", billDate: "2026-08-21", dueDate: "2026-09-25", amount: 900, status: "AUTHORISED" },
      ],
      manualAdj: { 3: -7500, 4: 2000, 5: 500 },
    },
  };
  const scenarioB = {
    id: 2,
    name: "Downside",
    updatedAt: 2000,
    state: {
      openingCash: 40000,
      floor: 20000,
      tab: "plan",
      selId: null,
      projects: [
        {
          id: 11, name: "Pilot", color: "#8A6D5B", startWeek: 6, duration: 2,
          events: [
            { id: 111, label: "Milestone", dir: "in", amount: 5000, anchor: "start", offset: 0 },
            { id: 112, label: "Lab testing", dir: "out", amount: 1200, anchor: "start", offset: -1 },
            { id: 113, label: "Taxes (TTB)", dir: "out", amount: 800, anchor: "end", offset: 0 },
          ],
        },
      ],
      fixed: [],
      capital: [
        { id: 22, type: "debt", label: "Bridge note", amount: 100000, date: "2026-09-15", rate: 12, termMonths: 12, repay: "interest-only" },
      ],
      ap: [
        { id: 32, vendor: "TTB", ref: "TAX-1", billDate: "2026-09-01", dueDate: "2026-10-01", amount: 800, status: "AUTHORISED", runId: 11, eventId: 113 },
      ],
      manualAdj: {},
    },
  };
  return { version: 2, activeId: 1, scenarios: [scenarioA, scenarioB] };
}

/* ---------------------------------------------------------------- keys / ids */

test("keys", () => {
  assert.equal(STORE_KEY, "treasury_cockpit_v3");
  assert.equal(LEGACY_KEY, "treasury_cockpit");
});

test("newId: 1000 unique string ids with a prefix, never numeric-only", () => {
  const ids = Array.from({ length: 1000 }, () => newId());
  assert.equal(new Set(ids).size, 1000);
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.match(id, /^[a-z]+_/);
    assert.ok(!/^\d+$/.test(id));
  }
  assert.match(newId("run"), /^run_/);
});

/* ---------------------------------------------------------------- canon / storeSig */

test("canon/storeSig: key-order independent, ignores updatedAt at any depth, arrays keep order", () => {
  const a = { version: 3, activeId: "1", updatedAt: 5, scenarios: [{ id: "1", updatedAt: 10, state: { floor: 1, openingCash: 2, runs: [{ b: 1, a: 2, updatedAt: 3 }] } }] };
  const b = { scenarios: [{ state: { runs: [{ updatedAt: 99, a: 2, b: 1 }], openingCash: 2, floor: 1 }, updatedAt: 20, id: "1" }], activeId: "1", version: 3 };
  assert.equal(storeSig(a), storeSig(b));
  assert.deepEqual(canon({ z: 1, a: [3, 2, 1], updatedAt: 7 }), { a: [3, 2, 1], z: 1 });
  assert.equal(JSON.stringify(canon({ z: 1, a: 2 })), '{"a":2,"z":1}');
  // array order matters
  assert.notEqual(storeSig({ x: [1, 2] }), storeSig({ x: [2, 1] }));
  // a content change is detected
  assert.notEqual(storeSig(a), storeSig({ ...a, activeId: "2" }));
  // primitives / null pass through
  assert.equal(canon(null), null);
  assert.equal(canon(3), 3);
});

test("isV3", () => {
  assert.equal(isV3({ version: 3, scenarios: [{}] }), true);
  assert.equal(isV3({ version: 3, scenarios: [] }), false);
  assert.equal(isV3({ version: 2, scenarios: [{}] }), false);
  assert.equal(isV3(null), false);
});

/* ---------------------------------------------------------------- migration: v2 store */

test("migrateLegacyToV3: realistic v2 store with two scenarios", () => {
  const raw = v2Fixture();
  const snapshot = JSON.stringify(raw);
  const { store, report } = migrateLegacyToV3(raw, { epoch: EPOCH, today: TODAY, newId: mkId() });
  assert.equal(JSON.stringify(raw), snapshot, "input must not be mutated");

  assert.equal(store.version, 3);
  assert.equal(store.activeId, "1", "activeId preserved (stringified)");
  assert.equal(store.scenarios.length, 2);

  const A = store.scenarios[0];
  assert.equal(A.id, "1");
  assert.equal(A.name, "Base case");
  assert.equal(A.group, "2026");
  assert.equal(A.notes, "primary plan");
  assert.equal(A.updatedAt, 1000);
  assert.deepEqual(A.legacyV2, raw.scenarios[0], "legacyV2 keeps the original scenario");
  assert.notEqual(A.legacyV2, raw.scenarios[0], "…as a copy");

  const st = A.state;
  assert.equal(st.version, 3);
  assert.equal(st.sprintEpoch, EPOCH);
  assert.equal(st.horizonSprints, 13);
  assert.equal(st.openingCash, 60000);
  assert.equal(st.floor, 25000);
  assert.equal(st.tab, "burn", "v1 'fixed' tab → 'burn'");
  assert.equal(st.selId, "10");

  // runs — base Monday 2026-08-24; startWeek 4 → 2026-09-21 → sprint 1; duration 3 → 2 sprints
  assert.equal(st.runs.length, 1);
  const run = st.runs[0];
  assert.equal(run.id, "10");
  assert.equal(run.startSprint, 1);
  assert.equal(run.sprints, 2);
  const events = raw.scenarios[0].state.projects[0].events;
  const inTotal = sum(events.filter((e) => e.dir === "in"), (e) => e.amount);
  const outTotal = sum(events.filter((e) => e.dir === "out"), (e) => e.amount);
  assert.equal(sum(run.payments, (p) => p.amount), inTotal, "Σ payments == Σ in events");
  assert.equal(sum(run.materials, (l) => l.amount) + run.taxes, outTotal, "Σ materials + taxes == Σ out events");
  assert.equal(run.value, inTotal);
  for (const s of STANDARD_MATERIALS) assert.ok(byLabel(run.materials, s.label), `standard line ${s.label} present`);
  assert.equal(byLabel(run.materials, "Soft goods").amount, 19500);
  assert.equal(byLabel(run.materials, "Cans").amount, 48000);
  assert.equal(byLabel(run.materials, "Cartons").amount, 6000);
  assert.equal(run.payments.filter((p) => p.kind === "completion").length, 1);

  // bills — eventId 104 (Packaging) → lineId of the Cans line
  assert.equal(st.ap.length, 2);
  const linked = st.ap.find((b) => b.id === "30");
  assert.equal(linked.lineId, byLabel(run.materials, "Cans").id);
  assert.equal(linked.runId, "10");
  assert.ok(!("eventId" in linked), "eventId dropped");
  assert.equal(linked.xeroId, "x-30");
  assert.equal(linked.include, true);
  const unlinked = st.ap.find((b) => b.id === "31");
  assert.equal(unlinked.lineId, undefined);
  assert.ok(!("eventId" in unlinked));
  assert.equal(unlinked.amount, 900);

  // burn — three migrated fixed lines + the loan's P&I
  const debt = st.burn.filter((b) => b.category === "Debt service");
  const pni = debt.find((b) => /P&I/.test(b.label || ""));
  assert.ok(pni, "level P&I line present");
  const r = 0.09 / 12, n = 36;
  const expected = Math.round((250000 * r) / (1 - Math.pow(1 + r, -n)));
  assert.equal(expected, 7950);
  assert.equal(pni.monthly, expected);
  assert.equal(pni.label, "Term loan — P&I");
  assert.equal(pni.cadence, "monthly");
  assert.equal(pni.dayOfMonth, 1);
  assert.equal(pni.from, "2026-11-01");
  assert.equal(pni.to, "2029-10-01");
  assert.ok(debt.find((b) => b.label === "Equipment loan" && b.monthly === 8000 && b.dayOfMonth === 5), "fixed 'Debt service' item migrated as-is");
  const payroll = st.burn.find((b) => b.category === "Payroll & benefits");
  assert.equal(payroll.monthly, Math.round((22000 * 26) / 12));
  const rent = st.burn.find((b) => b.category === "Rent & facilities");
  assert.equal(rent.monthly, 16000);
  assert.equal(st.burn.length, 4, "no default $0 lines are added during migration");
  for (const c of BURN_CATEGORIES) assert.ok(typeof c === "string");

  // capital — injections only
  assert.equal(st.capital.length, 2);
  for (const c of st.capital) {
    assert.ok(!("rate" in c) && !("termMonths" in c) && !("repay" in c), "servicing fields dropped");
    assert.equal(typeof c.id, "string");
  }
  assert.deepEqual(st.capital[0], { id: "20", type: "equity", label: "Seed bridge", amount: 200000, date: "2026-09-05" });
  assert.deepEqual(st.capital[1], { id: "21", type: "debt", label: "Term loan", amount: 250000, date: "2026-10-01" });

  // manualAdj — week 3 (Sep 14) → sprint 0; weeks 4 & 5 (Sep 21 / Sep 28) → sprint 1, summed
  assert.deepEqual(st.manualAdj, { 0: -7500, 1: 2500 });

  // report
  assert.equal(report.length, 2);
  assert.deepEqual(report[0], { scenarioId: "1", scenarioName: "Base case", unmapped: [] });
  assert.equal(report[1].scenarioId, "2");
  assert.equal(report[1].scenarioName, "Downside");
  assert.deepEqual(
    report[1].unmapped.map((u) => [u.label, u.dir, u.amount, u.run]).sort(),
    [["Lab testing", "out", 1200, "Pilot"]], // 'in' events always become a payment, so they are never reported
  );

  // scenario B: money preserved through unmapped lines; tax-event bill stays unlinked;
  // interest-only debt → interest line + one-time balloon
  const B = store.scenarios[1].state;
  const pb = B.runs[0];
  assert.equal(sum(pb.payments, (p) => p.amount), 5000);
  assert.equal(sum(pb.materials, (l) => l.amount) + pb.taxes, 2000);
  assert.equal(pb.taxes, 800);
  assert.ok(byLabel(pb.materials, "Lab testing"));
  assert.equal(B.ap[0].lineId, undefined, "bill linked to a tax event has no material line");
  assert.equal(B.ap[0].runId, "11");
  const io = B.burn.filter((b) => b.category === "Debt service");
  assert.equal(io.length, 2);
  const interest = io.find((b) => b.cadence === "monthly");
  assert.equal(interest.monthly, 1000);
  assert.equal(interest.dayOfMonth, 15);
  assert.equal(interest.from, "2026-10-15");
  assert.equal(interest.to, "2027-09-15");
  const balloon = io.find((b) => b.cadence === "one-time");
  assert.equal(balloon.monthly, 100000);
  assert.equal(balloon.from, "2027-09-15");
  assert.deepEqual(B.manualAdj, {});
  assert.equal(B.selId, null);
  assert.equal(B.tab, "plan");
});

test("migrateLegacyToV3: bill with eventId but no runId is resolved by scanning projects", () => {
  const raw = v2Fixture();
  raw.scenarios[0].state.ap[0] = { ...raw.scenarios[0].state.ap[0], runId: undefined };
  delete raw.scenarios[0].state.ap[0].runId;
  const { store } = migrateLegacyToV3(raw, { epoch: EPOCH, today: TODAY, newId: mkId() });
  const st = store.scenarios[0].state;
  const bill = st.ap.find((b) => b.id === "30");
  assert.equal(bill.lineId, byLabel(st.runs[0].materials, "Cans").id);
  assert.equal(bill.runId, "10", "runId filled from the resolved run");
});

test("migrateLegacyToV3: activeId not present → first scenario; missing state fields default", () => {
  const raw = { version: 2, activeId: 999, scenarios: [{ id: 7, name: "Only", updatedAt: 1, state: {} }] };
  const { store } = migrateLegacyToV3(raw, { epoch: EPOCH, today: TODAY, newId: mkId() });
  assert.equal(store.activeId, "7");
  const st = store.scenarios[0].state;
  assert.equal(st.openingCash, 60000);
  assert.equal(st.floor, 25000);
  assert.deepEqual(st.runs, []);
  assert.deepEqual(st.burn, []);
  assert.deepEqual(st.capital, []);
  assert.deepEqual(st.ap, []);
  assert.deepEqual(st.manualAdj, {});
  assert.equal(st.tab, "plan");
  assert.equal(st.selId, null);
});

/* ---------------------------------------------------------------- migration: v1 flat blob & garbage */

test("migrateLegacyToV3: v1 flat blob wraps to one 'Base case' scenario", () => {
  const flat = {
    openingCash: 80000, floor: 30000, tab: "fixed", selId: null,
    projects: v2Fixture().scenarios[0].state.projects,
    fixed: [{ id: 1, label: "Rent", cat: "Facilities", cadence: "monthly", amount: 5000, day: 1, from: 0, to: null }],
    ap: [], capital: [], manualAdj: { 2: 1000 },
  };
  const { store, report } = migrateLegacyToV3(flat, { epoch: EPOCH, today: TODAY, newId: mkId() });
  assert.equal(store.version, 3);
  assert.equal(store.scenarios.length, 1);
  const sc = store.scenarios[0];
  assert.equal(sc.name, "Base case");
  assert.match(sc.id, /^sc_/);
  assert.equal(store.activeId, sc.id);
  assert.equal(sc.updatedAt, 0);
  assert.equal(sc.state.openingCash, 80000);
  assert.equal(sc.state.floor, 30000);
  assert.equal(sc.state.tab, "burn");
  assert.equal(sc.state.runs.length, 1);
  assert.equal(sc.state.burn.length, 1);
  assert.deepEqual(sc.state.manualAdj, { 0: 1000 }); // week 2 = Sep 7 → sprint 0
  assert.deepEqual(sc.legacyV2.state.projects, flat.projects);
  assert.equal(report.length, 1);
  assert.equal(report[0].scenarioName, "Base case");
});

test("migrateLegacyToV3: null / garbage → { store: null, report: [] }", () => {
  const ctx = { epoch: EPOCH, today: TODAY, newId: mkId() };
  for (const junk of [null, undefined, "nope", 42, [], {}, { foo: 1 }, { version: 2, scenarios: [] }, { version: 3, scenarios: [{}] }]) {
    assert.deepEqual(migrateLegacyToV3(junk, ctx), { store: null, report: [] }, `junk: ${JSON.stringify(junk)}`);
  }
});

/* ---------------------------------------------------------------- normalizeStore */

test("normalizeStore: adds standard lines + completion, fills defaults, coerces numbers, does not mutate", () => {
  const raw = {
    version: 3,
    scenarios: [
      {
        id: 5,
        name: "Sparse",
        state: {
          openingCash: "not a number",
          runs: [
            {
              id: 77, name: "R", startSprint: "2", sprints: "0", value: "10000", tolling: "4000",
              materials: [{ id: "c1", label: "Cans", amount: "5000" }, { label: "Labels", amount: 250 }],
              payments: [{ id: "d1", kind: "deposit", label: "Deposit", amount: "2000", timing: { mode: "beforeStart", weeks: 4 } }],
            },
          ],
          burn: [{ category: "Utilities", monthly: "700" }],
          ap: [{ id: 9, vendor: "V", billDate: "2026-09-01", dueDate: "2026-09-10", amount: "100", status: "AUTHORISED" }],
        },
      },
    ],
  };
  const snapshot = JSON.stringify(raw);
  const out = normalizeStore(raw, { epoch: EPOCH, newId: mkId() });
  assert.equal(JSON.stringify(raw), snapshot, "input not mutated");
  assert.notEqual(out, raw);
  assert.notEqual(out.scenarios[0], raw.scenarios[0]);

  assert.equal(out.version, 3);
  assert.equal(out.activeId, "5", "activeId fixed up to the first scenario");
  const sc = out.scenarios[0];
  assert.equal(sc.id, "5");
  assert.equal(sc.updatedAt, 0);
  const st = sc.state;
  assert.equal(st.version, 3);
  assert.equal(st.sprintEpoch, EPOCH);
  assert.equal(st.horizonSprints, 13);
  assert.equal(st.openingCash, 60000);
  assert.equal(st.floor, 25000);
  assert.deepEqual(st.capital, []);
  assert.deepEqual(st.manualAdj, {});
  assert.equal(st.tab, "plan");
  assert.equal(st.selId, null);

  const run = st.runs[0];
  assert.equal(run.id, "77");
  assert.equal(run.startSprint, 2);
  assert.equal(run.sprints, 1);
  assert.equal(run.value, 10000);
  assert.equal(run.tolling, 4000);
  assert.equal(run.taxes, 0);
  assert.deepEqual(run.materials.slice(0, 5).map((l) => l.label), STANDARD_MATERIALS.map((s) => s.label));
  assert.equal(run.materials.length, 6);
  const cans = byLabel(run.materials, "Cans");
  assert.equal(cans.id, "c1");
  assert.equal(cans.amount, 5000);
  assert.equal(cans.standard, true);
  assert.equal(cans.status, "planned");
  assert.equal(cans.feedsSprint, 1);
  assert.equal(cans.leadWeeks, 4);
  const labels = byLabel(run.materials, "Labels");
  assert.equal(labels.standard, false);
  assert.equal(labels.status, "planned");
  assert.equal(labels.feedsSprint, 1);
  assert.match(labels.id, /^m_/);
  const completions = run.payments.filter((p) => p.kind === "completion");
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0].timing, { mode: "runEnd" });
  assert.equal(completions[0].amount, 8000, "completion balances value − deposit");
  assert.equal(run.payments[0].amount, 2000);

  assert.equal(st.burn[0].monthly, 700);
  assert.match(st.burn[0].id, /^burn_/);
  assert.equal(st.ap[0].id, "9");
  assert.equal(st.ap[0].amount, 100);

  // idempotent
  const again = normalizeStore(out, { epoch: EPOCH, newId: mkId() });
  assert.equal(storeSig(again), storeSig(out));
});

test("normalizeStore: non-v3 input → empty v3 store", () => {
  assert.deepEqual(normalizeStore(null), { version: 3, activeId: null, scenarios: [] });
  assert.deepEqual(normalizeStore({ version: 2, scenarios: [{}] }), { version: 3, activeId: null, scenarios: [] });
});

/* ---------------------------------------------------------------- mergeScenarios */

test("mergeScenarios: revert case — a stale window cannot clobber a scenario edited elsewhere", () => {
  const OLD = { version: 3, openingCash: 1, runs: [] };
  const MORNING = { version: 3, openingCash: 2, runs: [] };
  const local = {
    version: 3, activeId: "B",
    scenarios: [
      { id: "tikihaka", name: "Tiki Haka", updatedAt: 100, state: OLD },
      { id: "B", name: "B", updatedAt: 5000, state: { version: 3, openingCash: 99, runs: [] } },
    ],
  };
  const remote = {
    version: 3, activeId: "tikihaka",
    scenarios: [
      { id: "tikihaka", name: "Tiki Haka", updatedAt: 3000, state: MORNING },
      { id: "B", name: "B", updatedAt: 10, state: { version: 3, openingCash: 0, runs: [] } },
      { id: "C", name: "Created elsewhere", updatedAt: 2500, state: { version: 3, openingCash: 7, runs: [] } },
    ],
  };
  const out = mergeScenarios(local, remote, "B");
  assert.equal(out.version, 3);
  assert.equal(out.activeId, "B");
  assert.deepEqual(out.scenarios.map((s) => s.id), ["tikihaka", "B", "C"], "local order, remote-only appended");
  assert.equal(out.scenarios[0].state, MORNING, "newer remote copy wins for a non-active scenario");
  assert.equal(out.scenarios[1], local.scenarios[1], "active scenario keeps the local copy");
  assert.equal(out.scenarios[2], remote.scenarios[2]);
});

test("mergeScenarios: single window (remote == local) is a no-op on content; null remote → local", () => {
  const local = {
    version: 3, activeId: "A",
    scenarios: [
      { id: "A", name: "A", updatedAt: 10, state: { version: 3, openingCash: 1 } },
      { id: "B", name: "B", updatedAt: 20, state: { version: 3, openingCash: 2 } },
    ],
  };
  const same = mergeScenarios(local, JSON.parse(JSON.stringify(local)), "A");
  assert.equal(storeSig(same), storeSig(local));
  assert.notEqual(same, local);

  const nul = mergeScenarios(local, null, "A");
  assert.equal(storeSig(nul), storeSig(local));
  assert.notEqual(nul, local);
  assert.deepEqual(nul.scenarios, local.scenarios);

  const notV3 = mergeScenarios(local, { version: 2, scenarios: [{ id: "A", updatedAt: 999 }] }, "A");
  assert.equal(storeSig(notV3), storeSig(local));

  // older remote copy of a non-active scenario does not replace local
  const olderRemote = { version: 3, activeId: "A", scenarios: [{ id: "B", name: "B", updatedAt: 1, state: { version: 3, openingCash: 0 } }] };
  assert.equal(mergeScenarios(local, olderRemote, "A").scenarios[1], local.scenarios[1]);
});

/* ---------------------------------------------------------------- fresh state */

test("emptyScenarioState / newScenario", () => {
  const st = emptyScenarioState({ epoch: EPOCH, newId: mkId() });
  assert.equal(st.version, 3);
  assert.equal(st.sprintEpoch, EPOCH);
  assert.equal(st.horizonSprints, 13);
  assert.equal(st.openingCash, 60000);
  assert.equal(st.floor, 25000);
  assert.deepEqual(st.runs, []);
  assert.equal(st.burn.length, BURN_CATEGORIES.length);
  assert.deepEqual(st.burn.map((b) => b.category), [...BURN_CATEGORIES]);
  assert.deepEqual(st.capital, []);
  assert.deepEqual(st.ap, []);
  assert.deepEqual(st.manualAdj, {});
  assert.equal(st.tab, "plan");
  assert.equal(st.selId, null);

  const sc = newScenario("Plan A", st, mkId());
  assert.equal(sc.name, "Plan A");
  assert.match(sc.id, /^sc_/);
  assert.equal(sc.updatedAt, 0);
  assert.equal(sc.state, st);
  // default id factory works too
  assert.match(newScenario("X", st).id, /^sc_/);
  // normalizeStore accepts what we produce
  const store = normalizeStore({ version: 3, activeId: sc.id, scenarios: [sc] }, { epoch: EPOCH });
  assert.equal(store.activeId, sc.id);
  assert.equal(store.scenarios[0].state.burn.length, BURN_CATEGORIES.length);
});
