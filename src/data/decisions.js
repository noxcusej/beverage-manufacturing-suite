// Approval decisions — browser side.
//
// Prefers /api/decisions, which enforces the review deadline lock before it
// writes. Falls back to the app's own store when that route is unavailable (no
// service key, or a dev server with no serverless runtime) — in which case the
// UI says plainly that locks are advisory, because a browser-side check is not
// something anyone should rely on.

import {
  getBillDecisions,
  setBillDecision,
  clearBillDecision,
} from './store';

const ENDPOINT = '/api/decisions';

export const SOURCE_ENFORCED = 'enforced';
export const SOURCE_LOCAL = 'local';

export const LOCKED_CODE = 'review_locked';

async function readJson(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return res.json().catch(() => null);
}

function lockedError(json) {
  const err = new Error(json?.error || 'This bill is locked — its review deadline has passed.');
  err.code = LOCKED_CODE;
  err.dueAt = json?.dueAt || null;
  err.remedy = json?.remedy || null;
  return err;
}

/**
 * @returns {Promise<{source: string, decisions: object, reason: string|null, auth: object}>}
 */
export async function loadDecisions({ client, signal } = {}) {
  const params = new URLSearchParams();
  if (client) params.set('client', client);

  try {
    const res = await fetch(`${ENDPOINT}${params.toString() ? `?${params}` : ''}`, { signal });
    const json = await readJson(res);
    if (res.ok && json?.available) {
      return {
        source: SOURCE_ENFORCED,
        decisions: json.decisions || {},
        reason: null,
        auth: { adminKeyConfigured: json.adminKeyConfigured, keysCollide: json.keysCollide },
      };
    }
    return {
      source: SOURCE_LOCAL,
      decisions: getBillDecisions(),
      reason: json?.reason
        || 'Approvals are stored on this device. Review deadlines will be shown but cannot be enforced.',
      auth: {},
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      source: SOURCE_LOCAL,
      decisions: getBillDecisions(),
      reason: `Could not reach ${ENDPOINT}. Approvals are stored locally and review deadlines cannot be enforced.`,
      auth: {},
    };
  }
}

/**
 * Record a decision. Throws with `code === LOCKED_CODE` when the bill's review
 * deadline has passed — the caller shows that, it is not a failure to retry.
 */
export async function saveDecision({ billId, poId, clientName, status, reason, decidedBy }) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billId, poId, clientName, status, reason, decidedBy }),
    });
    if (res.status === 423) throw lockedError(await readJson(res));

    const json = await readJson(res);
    if (res.ok && json?.decision) return { decision: json.decision, source: SOURCE_ENFORCED, caveat: json.caveat };
    if (json?.error) throw new Error(json.error);
  } catch (err) {
    if (err.code === LOCKED_CODE) throw err;
    if (err instanceof Error && err.message && !/fetch|network|Failed to/i.test(err.message)) throw err;
  }

  setBillDecision(billId, { status, by: decidedBy, reason });
  return { decision: getBillDecisions()[billId], source: SOURCE_LOCAL };
}

export async function removeDecision({ billId, poId }) {
  try {
    const params = new URLSearchParams({ bill_id: billId });
    if (poId) params.set('po_id', poId);
    const res = await fetch(`${ENDPOINT}?${params}`, { method: 'DELETE' });
    if (res.status === 423) throw lockedError(await readJson(res));

    const json = await readJson(res);
    if (res.ok && json?.cleared) return { source: SOURCE_ENFORCED, caveat: json.caveat };
    if (json?.error) throw new Error(json.error);
  } catch (err) {
    if (err.code === LOCKED_CODE) throw err;
    if (err instanceof Error && err.message && !/fetch|network|Failed to/i.test(err.message)) throw err;
  }

  clearBillDecision(billId);
  return { source: SOURCE_LOCAL };
}
