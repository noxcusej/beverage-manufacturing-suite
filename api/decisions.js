// Approval decisions — staff route, gated by the review deadline lock.
//
//   GET    /api/decisions[?client=Name]   billId -> decision
//   POST   /api/decisions                 reject / confirm a bill
//   DELETE /api/decisions?bill_id=...     restore a bill to automatic approval
//
// These writes used to happen straight from the browser into the app_data blob.
// They live here now because a lock the browser can write around is not a lock:
// once a bill's review deadline has passed, its approval state is final until
// an admin reopens it.

import {
  listDecisions,
  setDecision,
  clearDecision,
  migrateLegacyDecisions,
  storeUnavailableReason,
} from './_portalStore.js';
import { checkStaffAuth, authStatus } from './_staffAuth.js';
import { lockForBill, lockedResponse } from './_reviewLock.js';

function readBody(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkStaffAuth(req)) return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });

  const unavailable = storeUnavailableReason();
  if (unavailable) {
    // The dashboard falls back to its local store and tells the operator that
    // locks are advisory there — see src/data/decisions.js.
    return res.status(200).json({ available: false, reason: unavailable, decisions: {}, ...authStatus() });
  }

  try {
    if (req.method === 'GET') {
      // Carry over anything still sitting in the pre-table app_data blob, so an
      // existing deployment does not appear to lose its rejections on upgrade.
      await migrateLegacyDecisions();
      const decisions = await listDecisions({
        clientName: req.query?.client ? String(req.query.client) : null,
      });
      return res.status(200).json({ available: true, decisions, ...authStatus() });
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = req.method === 'POST' ? readBody(req) : {};
      const billId = String(body.billId || req.query?.bill_id || '');
      if (!billId) return res.status(400).json({ error: 'billId is required.' });

      const { lock, deadline, inherited, authoritative } = await lockForBill(billId, {
        poIdHint: body.poId || req.query?.po_id || null,
      });

      if (lock.locked) {
        return res.status(423).json({
          ...lockedResponse(lock, 'This bill'),
          inheritedFromPurchaseOrder: inherited,
        });
      }

      // If we could not confirm the bill's PO with Ramp, an inherited lock may
      // not have been visible. Say so rather than implying a clean check.
      const caveat = authoritative ? undefined
        : 'Ramp was unreachable, so a purchase-order-level deadline could not be confirmed for this bill.';

      if (req.method === 'DELETE') {
        await clearDecision(billId);
        return res.status(200).json({ cleared: billId, caveat });
      }

      const decision = await setDecision({
        billId,
        clientName: body.clientName || null,
        status: body.status,
        reason: body.reason || null,
        decidedBy: body.decidedBy || null,
      });
      return res.status(200).json({ decision, dueAt: deadline?.dueAt || null, caveat });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[API] decisions error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
