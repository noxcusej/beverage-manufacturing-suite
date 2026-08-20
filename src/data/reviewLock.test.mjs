// Run with: node src/data/reviewLock.test.mjs
//
// Boundary behaviour of the review deadline and the lock it imposes.

import {
  resolveDeadline,
  lockState,
  isLocked,
  permissions,
  formatRemaining,
  validateDueAt,
  indexDeadlines,
  summarize,
  LOCK_NONE, LOCK_OPEN, LOCK_DUE_SOON, LOCK_LOCKED, LOCK_REOPENED,
} from './reviewLock.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n   → ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  assert(label, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = Date.parse('2026-08-20T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();
const DAY = 86400000;
const HOUR = 3600000;

// ── lockState ───────────────────────────────────────────────────────────────
eq('no deadline is not a lock', lockState(null, NOW).state, LOCK_NONE);
assert('and is not locked', lockState(null, NOW).locked === false);
eq('a deadline with no date is not a lock', lockState({ dueAt: null }, NOW).state, LOCK_NONE);
eq('an unparseable date is not a lock', lockState({ dueAt: 'soon-ish' }, NOW).state, LOCK_NONE);

eq('a distant deadline is open', lockState({ dueAt: iso(10 * DAY) }, NOW).state, LOCK_OPEN);
eq('a near deadline is due soon', lockState({ dueAt: iso(2 * DAY) }, NOW).state, LOCK_DUE_SOON);
eq('exactly 3 days out is still due soon', lockState({ dueAt: iso(3 * DAY) }, NOW).state, LOCK_DUE_SOON);
eq('just over 3 days out is open', lockState({ dueAt: iso(3 * DAY + 1) }, NOW).state, LOCK_OPEN);

eq('a past deadline locks', lockState({ dueAt: iso(-1) }, NOW).state, LOCK_LOCKED);
// The boundary matters: "review by 5pm" means 5pm is closed, not still open.
eq('the exact instant of the deadline is locked', lockState({ dueAt: iso(0) }, NOW).state, LOCK_LOCKED);
eq('one millisecond before is not', lockState({ dueAt: iso(1) }, NOW).state, LOCK_DUE_SOON);
assert('a locked record reports no time remaining', lockState({ dueAt: iso(-DAY) }, NOW).msRemaining === 0);

// ── Reopening ───────────────────────────────────────────────────────────────
const reopened = { dueAt: iso(-5 * DAY), reopenedUntil: iso(2 * DAY) };
eq('an admin reopen lifts the lock', lockState(reopened, NOW).state, LOCK_REOPENED);
assert('and it is genuinely unlocked', lockState(reopened, NOW).locked === false);
eq('the original due date is still reported', lockState(reopened, NOW).dueAt, NOW - 5 * DAY);
eq('an expired reopen locks again',
  lockState({ dueAt: iso(-5 * DAY), reopenedUntil: iso(-1) }, NOW).state, LOCK_LOCKED);
eq('a reopen on a record that is not yet due changes nothing',
  lockState({ dueAt: iso(10 * DAY), reopenedUntil: iso(1 * DAY) }, NOW).state, LOCK_REOPENED);

// ── Inheritance: a bill falls back to its PO's deadline ─────────────────────
const rows = [
  { targetType: 'purchase_order', targetId: 'po_1', dueAt: iso(5 * DAY) },
  { targetType: 'bill', targetId: 'b2', dueAt: iso(1 * DAY) },
];
const byTarget = indexDeadlines(rows);

eq('a bill with no deadline inherits its PO',
  resolveDeadline({ id: 'b1', poId: 'po_1' }, byTarget),
  { deadline: rows[0], inherited: true });
eq('a bill with its own deadline keeps it',
  resolveDeadline({ id: 'b2', poId: 'po_1' }, byTarget),
  { deadline: rows[1], inherited: false });
eq('a bill on no PO and with no deadline has none',
  resolveDeadline({ id: 'b3', poId: null }, byTarget),
  { deadline: null, inherited: false });
eq('a bill on a PO that has no deadline has none',
  resolveDeadline({ id: 'b4', poId: 'po_other' }, byTarget),
  { deadline: null, inherited: false });
eq('an empty index resolves nothing',
  resolveDeadline({ id: 'b1', poId: 'po_1' }, indexDeadlines([])),
  { deadline: null, inherited: false });
eq('malformed rows are skipped', indexDeadlines([{ targetId: 'x' }, null]).size, 0);

// A bill's own deadline overrides its PO's even when the PO's is stricter.
const strictPo = indexDeadlines([
  { targetType: 'purchase_order', targetId: 'po_1', dueAt: iso(-DAY) },
  { targetType: 'bill', targetId: 'b1', dueAt: iso(DAY) },
]);
assert('a bill-level deadline wins over a locked PO',
  !isLocked(resolveDeadline({ id: 'b1', poId: 'po_1' }, strictPo).deadline, NOW));
assert('a sibling bill still inherits the locked PO',
  isLocked(resolveDeadline({ id: 'b9', poId: 'po_1' }, strictPo).deadline, NOW));

// ── What the lock permits ───────────────────────────────────────────────────
const openPerms = permissions(lockState({ dueAt: iso(DAY) }, NOW));
eq('an open review allows everything',
  [openPerms.canComment, openPerms.canChangeApproval, openPerms.canCommentInternally],
  [true, true, true]);

const lockedPerms = permissions(lockState({ dueAt: iso(-DAY) }, NOW));
eq('a lock closes comments and approval changes',
  [lockedPerms.canComment, lockedPerms.canChangeApproval], [false, false]);
assert('but never internal notes', lockedPerms.canCommentInternally === true);
eq('no deadline permits everything',
  permissions(lockState(null, NOW)).canChangeApproval, true);
eq('an undefined lock permits everything', permissions(undefined).canComment, true);

// ── Validation ──────────────────────────────────────────────────────────────
eq('an empty deadline is rejected', validateDueAt('', { now: NOW }).ok, false);
eq('gibberish is rejected', validateDueAt('next tuesday-ish', { now: NOW }).ok, false);
eq('a past deadline is rejected — it would lock on arrival',
  validateDueAt(iso(-DAY), { now: NOW }).ok, false);
eq('the current instant is rejected too', validateDueAt(iso(0), { now: NOW }).ok, false);
eq('a future deadline is accepted', validateDueAt(iso(DAY), { now: NOW }).ok, true);
eq('and normalizes to ISO', validateDueAt(iso(DAY), { now: NOW }).iso, new Date(NOW + DAY).toISOString());
eq('a past deadline is allowed when explicitly permitted',
  validateDueAt(iso(-DAY), { now: NOW, allowPast: true }).ok, true);

// ── Formatting ──────────────────────────────────────────────────────────────
eq('no deadline formats to nothing', formatRemaining(lockState(null, NOW)), '');
assert('days remaining reads naturally',
  formatRemaining(lockState({ dueAt: iso(3 * DAY) }, NOW)) === '3 days left');
assert('one day is singular',
  formatRemaining(lockState({ dueAt: iso(1 * DAY + HOUR) }, NOW)) === '1 day left');
assert('hours are used inside a day',
  formatRemaining(lockState({ dueAt: iso(5 * HOUR) }, NOW)).endsWith('h left'));
assert('a closed review says so',
  formatRemaining(lockState({ dueAt: new Date(Date.now() - 2 * DAY).toISOString() })).startsWith('closed'));

// ── Summary roll-up ─────────────────────────────────────────────────────────
const bills = [
  { id: 'b1', poId: 'po_1' },   // inherits PO, 5 days out → open
  { id: 'b2', poId: 'po_1' },   // own, 1 day out → due soon
  { id: 'b3', poId: null },     // none
];
eq('summary counts each bucket', summarize(bills, byTarget, NOW),
  { locked: 0, dueSoon: 1, open: 1, none: 1, reopened: 0, total: 3 });
eq('an empty list summarizes to zeroes', summarize([], byTarget, NOW),
  { locked: 0, dueSoon: 0, open: 0, none: 0, reopened: 0, total: 0 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
