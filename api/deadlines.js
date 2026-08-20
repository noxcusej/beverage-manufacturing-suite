// Review deadlines — staff and admin route.
//
//   GET    /api/deadlines[?client=Name]              list deadlines + auth posture
//   GET    /api/deadlines?events=1&target_type=&target_id=   audit trail for one record
//   POST   /api/deadlines                            set a deadline
//   POST   /api/deadlines  { action: 'reopen' }      lift a lock (ADMIN)
//   DELETE /api/deadlines?target_type=&target_id=    remove a deadline (ADMIN)
//
// Who may do what:
//   - Setting a deadline on a record that has none is ordinary staff work.
//   - Moving one that already exists is an EDIT and needs the admin key.
//   - Reopening a locked record needs the admin key.
//   - Clearing a deadline needs the admin key — it removes the lock entirely,
//     which is the most complete way to undo one.
//
// Every mutation appends an audit row naming the actor and their role.

import {
  listDeadlines,
  getDeadline,
  upsertDeadline,
  reopenDeadline,
  clearDeadline,
  listDeadlineEvents,
  storeUnavailableReason,
} from './_portalStore.js';
import { checkStaffAuth, checkAdminAuth, authStatus, ADMIN_REFUSALS } from './_staffAuth.js';
import { validateDueAt } from '../src/data/reviewLock.js';

function refuseAdmin(res, reason) {
  // 403 for a wrong key, 501 when the deployment simply has no admin tier
  // configured — a different problem with a different fix.
  const status = reason === 'bad_admin_key' ? 403 : 501;
  return res.status(status).json({ error: ADMIN_REFUSALS[reason], code: reason });
}

function readBody(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

function validTargetType(t) {
  return t === 'bill' || t === 'purchase_order';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkStaffAuth(req)) return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });

  const unavailable = storeUnavailableReason();
  if (unavailable) {
    // Not an error: the dashboard keeps working and reports that deadlines
    // cannot be stored, rather than showing controls that would do nothing.
    return res.status(200).json({ available: false, reason: unavailable, deadlines: [], ...authStatus() });
  }

  try {
    if (req.method === 'GET') {
      if (req.query?.events) {
        const events = await listDeadlineEvents({
          targetType: req.query.target_type,
          targetId: req.query.target_id,
        });
        return res.status(200).json({ available: true, events, ...authStatus() });
      }
      const deadlines = await listDeadlines({
        clientName: req.query?.client ? String(req.query.client) : null,
      });
      return res.status(200).json({ available: true, deadlines, ...authStatus() });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const targetType = body.targetType;
      const targetId = body.targetId ? String(body.targetId) : '';
      if (!validTargetType(targetType) || !targetId) {
        return res.status(400).json({ error: 'targetType must be "bill" or "purchase_order", and targetId is required.' });
      }

      // ── Reopen: admin only ──
      if (body.action === 'reopen') {
        const admin = checkAdminAuth(req);
        if (!admin.ok) return refuseAdmin(res, admin.reason);

        const until = validateDueAt(body.reopenedUntil, {});
        if (!until.ok) return res.status(400).json({ error: `Reopen window: ${until.error}` });
        if (!String(body.reason || '').trim()) {
          // Reopening undoes a lock somebody relied on; it should never be
          // possible to find one later with no explanation attached.
          return res.status(400).json({ error: 'Give a reason for reopening this review.' });
        }

        const deadline = await reopenDeadline({
          targetType,
          targetId,
          reopenedUntil: until.iso,
          reason: String(body.reason).trim(),
          actor: body.actor || null,
        });
        return res.status(200).json({ deadline });
      }

      // ── Set or edit ──
      const existing = await getDeadline(targetType, targetId);
      let actorRole = 'staff';

      if (existing) {
        // Moving an existing deadline is the thing the admin gate exists for.
        const admin = checkAdminAuth(req);
        if (!admin.ok) return refuseAdmin(res, admin.reason);
        actorRole = 'admin';
      }

      // A first deadline must be in the future; an admin correcting one is
      // allowed to backdate, which is a deliberate way to close review now.
      const due = validateDueAt(body.dueAt, { allowPast: actorRole === 'admin' });
      if (!due.ok) return res.status(400).json({ error: due.error });

      const deadline = await upsertDeadline({
        targetType,
        targetId,
        clientName: body.clientName || 'Unassigned',
        dueAt: due.iso,
        note: body.note || null,
        actor: body.actor || null,
        actorRole,
      });
      return res.status(existing ? 200 : 201).json({ deadline, edited: Boolean(existing) });
    }

    if (req.method === 'DELETE') {
      const admin = checkAdminAuth(req);
      if (!admin.ok) return refuseAdmin(res, admin.reason);

      const targetType = req.query?.target_type;
      const targetId = req.query?.target_id ? String(req.query.target_id) : '';
      if (!validTargetType(targetType) || !targetId) {
        return res.status(400).json({ error: 'target_type and target_id are required.' });
      }

      const cleared = await clearDeadline({
        targetType,
        targetId,
        actor: req.query.actor || null,
        reason: req.query.reason || null,
      });
      return res.status(200).json({ cleared });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[API] deadlines error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
