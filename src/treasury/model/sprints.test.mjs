import { test } from "node:test";
import assert from "node:assert/strict";
import { sprintIndex, sprintStart, sprintEnd, weekInSprint, sprintOfToday, sprintColumns, rangeLabel, parseLocalDate, isoLocal, mondayOf, addDays } from "./sprints.js";

const E = "2026-09-07"; // Monday

test("epoch is sprint 0 and spans Mon–Sun", () => {
  assert.equal(sprintIndex("2026-09-07", E), 0);
  assert.equal(sprintIndex("2026-09-20", E), 0);
  assert.equal(sprintIndex("2026-09-21", E), 1);
  assert.equal(isoLocal(sprintStart(0, E)), "2026-09-07");
  assert.equal(isoLocal(sprintEnd(0, E)), "2026-09-20");
});

test("negative sprints before the epoch", () => {
  assert.equal(sprintIndex("2026-09-06", E), -1);   // Sunday before epoch
  assert.equal(sprintIndex("2026-08-24", E), -1);   // Monday two weeks before
  assert.equal(sprintIndex("2026-08-23", E), -2);
  assert.equal(isoLocal(sprintStart(-1, E)), "2026-08-24");
  assert.equal(isoLocal(sprintEnd(-1, E)), "2026-09-06");
});

test("today Aug 29 2026 is in sprint -1, week 0", () => {
  const today = parseLocalDate("2026-08-29");
  assert.equal(sprintOfToday(E, today), -1);
  assert.equal(weekInSprint(today, E), 0);
  assert.equal(weekInSprint("2026-09-02", E), 1);
});

test("columns and labels", () => {
  const cols = sprintColumns(E, -1, 3);
  assert.equal(cols.length, 3);
  assert.deepEqual(cols.map((c) => c.ordinal), [0, 1, 2]);
  assert.equal(cols[0].range, "Aug 24 – Sep 6");
  assert.equal(cols[1].range, "Sep 7 – 20");
  assert.equal(rangeLabel(parseLocalDate("2026-12-28"), parseLocalDate("2027-01-10")), "Dec 28 – Jan 10");
});

test("DST boundary does not shift sprint math (Nov 1 2026 fall-back)", () => {
  const k = sprintIndex("2026-11-02", E);
  assert.equal(isoLocal(sprintStart(k, E)), "2026-11-02");
  assert.equal(isoLocal(addDays(mondayOf(parseLocalDate("2026-11-05")), 7)), "2026-11-09");
});
