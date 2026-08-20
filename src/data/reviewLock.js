// Review deadlines and the lock they impose — pure logic, no store, no network.
//
// A review deadline gives a client a window to look at a bill and dispute it.
// When the window closes the record LOCKS: the review outcome is final.
//
// What the lock freezes:
//   - client comments                (the dispute window is closed)
//   - client-visible staff replies   (so is the conversation)
//   - approval changes               (reject / confirm / restore)
//
// What it deliberately leaves open:
//   - internal-only staff notes. They are your own record, the client never
//     sees them, and blocking them helps nobody.
//
// Only an admin can move a deadline once set, or reopen a locked record. That
// is enforced on the server (see api/deadlines.js); the UI merely reflects it.

export const LOCK_NONE = 'none';        // no deadline set
export const LOCK_OPEN = 'open';        // deadline set, comfortably ahead
export const LOCK_DUE_SOON = 'due-soon';// deadline set, inside the warning window
export const LOCK_REOPENED = 'reopened';// past due, but an admin lifted the lock
export const LOCK_LOCKED = 'locked';    // past due, frozen

/** How close to the deadline counts as "due soon". */
export const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000;

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Which deadline applies to a bill.
 *
 * A bill's own deadline wins. Failing that it inherits the deadline on its
 * purchase order, so a whole PO can be put on one review clock without
 * touching each bill.
 *
 * @param {object} bill normalized bill (needs id, and poId when linked)
 * @param {Map<string, object>} byTarget key `${targetType}:${targetId}` -> deadline row
 * @returns {{deadline: object|null, inherited: boolean}}
 */
export function resolveDeadline(bill, byTarget) {
  if (!byTarget || !bill) return { deadline: null, inherited: false };

  const own = byTarget.get(`bill:${bill.id}`);
  if (own) return { deadline: own, inherited: false };

  if (bill.poId) {
    const fromPo = byTarget.get(`purchase_order:${bill.poId}`);
    if (fromPo) return { deadline: fromPo, inherited: true };
  }
  return { deadline: null, inherited: false };
}

/**
 * Evaluate a deadline against the clock.
 *
 * @param {object|null} deadline row with dueAt, and optionally reopenedUntil
 * @param {number} [now] epoch ms — passed in so tests are not clock-dependent
 */
export function lockState(deadline, now = Date.now()) {
  const dueAt = toTime(deadline?.dueAt);
  if (!deadline || dueAt === null) {
    return { state: LOCK_NONE, locked: false, dueAt: null, msRemaining: null, reopenedUntil: null };
  }

  const reopenedUntil = toTime(deadline.reopenedUntil);
  const base = {
    dueAt,
    reopenedUntil,
    note: deadline.note || null,
    setBy: deadline.setBy || null,
  };

  // A reopen lifts the lock until its own expiry, without moving the original
  // due date — so the record still shows when review was meant to close.
  if (reopenedUntil !== null && reopenedUntil > now) {
    return { ...base, state: LOCK_REOPENED, locked: false, msRemaining: reopenedUntil - now };
  }

  // Exactly at the deadline counts as closed: "review by 5pm" means 5pm is out.
  if (dueAt <= now) {
    return { ...base, state: LOCK_LOCKED, locked: true, msRemaining: 0 };
  }

  const msRemaining = dueAt - now;
  return {
    ...base,
    state: msRemaining <= DUE_SOON_MS ? LOCK_DUE_SOON : LOCK_OPEN,
    locked: false,
    msRemaining,
  };
}

/** Convenience: is this record frozen right now? */
export function isLocked(deadline, now = Date.now()) {
  return lockState(deadline, now).locked;
}

/**
 * Which actions a lock permits. One place, so the server routes and the UI
 * cannot drift apart on what "locked" means.
 */
export function permissions(lock) {
  const locked = Boolean(lock?.locked);
  return {
    canComment: !locked,          // client, and client-visible staff replies
    canCommentInternally: true,   // never blocked — see the note at the top
    canChangeApproval: !locked,   // reject / confirm / restore
  };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 days left", "6 hours left", "closed 2 days ago". */
export function formatRemaining(lock, { closedWord = 'closed' } = {}) {
  if (!lock || lock.state === LOCK_NONE) return '';
  if (lock.locked) {
    const ago = Date.now() - lock.dueAt;
    if (ago < HOUR) return `${closedWord} just now`;
    if (ago < DAY) return `${closedWord} ${Math.floor(ago / HOUR)}h ago`;
    return `${closedWord} ${Math.floor(ago / DAY)}d ago`;
  }
  const ms = lock.msRemaining;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m left`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h left`;
  const days = Math.floor(ms / DAY);
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/**
 * Validate a proposed deadline before it is sent to the server.
 * @returns {{ok: true, iso: string} | {ok: false, error: string}}
 */
export function validateDueAt(input, { now = Date.now(), allowPast = false } = {}) {
  if (!input) return { ok: false, error: 'Pick a date for the review deadline.' };
  const t = toTime(input);
  if (t === null) return { ok: false, error: 'That is not a date we can read.' };
  if (!allowPast && t <= now) {
    return { ok: false, error: 'A review deadline has to be in the future — it would lock immediately.' };
  }
  return { ok: true, iso: new Date(t).toISOString() };
}

/** Index deadline rows for resolveDeadline(). */
export function indexDeadlines(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.targetType || !row?.targetId) continue;
    map.set(`${row.targetType}:${row.targetId}`, row);
  }
  return map;
}

/**
 * Roll up how a client's review is tracking, for the dashboard summary.
 */
export function summarize(bills, byTarget, now = Date.now()) {
  let locked = 0;
  let dueSoon = 0;
  let open = 0;
  let none = 0;
  let reopened = 0;

  for (const bill of bills || []) {
    const { deadline } = resolveDeadline(bill, byTarget);
    const lock = lockState(deadline, now);
    if (lock.state === LOCK_LOCKED) locked += 1;
    else if (lock.state === LOCK_DUE_SOON) dueSoon += 1;
    else if (lock.state === LOCK_REOPENED) reopened += 1;
    else if (lock.state === LOCK_OPEN) open += 1;
    else none += 1;
  }

  return { locked, dueSoon, open, none, reopened, total: (bills || []).length };
}
