// Server-side lock resolution.
//
// The lock rules themselves are imported from src/data/reviewLock.js rather
// than restated here, so the routes and the UI cannot disagree about what
// "locked" means. This file only answers the question the routes actually ask:
// *which* deadline applies to the record in front of me?
//
// The leading underscore keeps Vercel from serving this file as a route.

import { lockState, permissions } from '../src/data/reviewLock.js';
import { resolvePoReference } from '../src/data/procurement.js';
import { getDeadline } from './_portalStore.js';
import { credentials, rampGet } from './_ramp.js';

/**
 * Which purchase order a bill belongs to.
 *
 * Asks Ramp when we can, because that is authoritative and a caller must not be
 * able to dodge a PO-level lock by simply omitting the link. The hint is used
 * only when Ramp is unreachable, and that fallback is reported so a route can
 * say so rather than quietly enforcing less than it claims.
 */
async function poIdForBill(billId, poIdHint) {
  if (!credentials()) {
    return { poId: poIdHint || null, authoritative: false };
  }
  try {
    const bill = await rampGet(`/bills/${encodeURIComponent(billId)}`);
    return { poId: resolvePoReference(bill).id, authoritative: true };
  } catch (err) {
    // A missing or unreadable bill must not silently unlock it.
    console.error(`[lock] could not read bill ${billId} from Ramp:`, err.message);
    return { poId: poIdHint || null, authoritative: false };
  }
}

/**
 * The lock in force on one bill: its own deadline if it has one, otherwise the
 * deadline on its purchase order.
 *
 * @returns {Promise<{lock: object, deadline: object|null, inherited: boolean, authoritative: boolean}>}
 */
export async function lockForBill(billId, { poIdHint = null } = {}) {
  const own = await getDeadline('bill', billId);
  if (own) {
    return { lock: lockState(own), deadline: own, inherited: false, authoritative: true };
  }

  const { poId, authoritative } = await poIdForBill(billId, poIdHint);
  if (!poId) {
    return { lock: lockState(null), deadline: null, inherited: false, authoritative };
  }

  const fromPo = await getDeadline('purchase_order', poId);
  return {
    lock: lockState(fromPo),
    deadline: fromPo,
    inherited: Boolean(fromPo),
    authoritative,
  };
}

/** The lock in force on a purchase order — no inheritance, a PO is the root. */
export async function lockForPurchaseOrder(poId) {
  const deadline = await getDeadline('purchase_order', poId);
  return { lock: lockState(deadline), deadline, inherited: false, authoritative: true };
}

export async function lockForTarget(targetType, targetId, opts = {}) {
  return targetType === 'purchase_order'
    ? lockForPurchaseOrder(targetId)
    : lockForBill(targetId, opts);
}

/**
 * Standard 423 body. Says what closed the review and when, so the caller can
 * show something useful instead of a bare refusal.
 */
export function lockedResponse(lock, what = 'This record') {
  return {
    error: `${what} is locked — its review deadline has passed.`,
    code: 'review_locked',
    dueAt: lock?.dueAt ? new Date(lock.dueAt).toISOString() : null,
    // Named so the UI can point the operator at the one way out.
    remedy: 'An admin can reopen it from the Procurement dashboard.',
  };
}

export { permissions };
