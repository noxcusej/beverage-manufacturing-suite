// Review deadlines — browser side.
//
// Setting a deadline that does not exist yet is ordinary staff work. Moving
// one, reopening a locked record, or clearing a deadline are admin actions:
// this module attaches the tab's admin key to those requests, and clears a
// rejected key so the next attempt asks again rather than looping on a stale
// one. The server is what actually decides — see api/deadlines.js.

import { adminHeaders, requireAdminKey, clearAdminKey } from './adminSession';

const ENDPOINT = '/api/deadlines';

async function readJson(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return res.json().catch(() => null);
}

function toError(json, res) {
  const err = new Error(json?.error || `Request failed (${res.status}).`);
  err.code = json?.code || null;
  err.status = res.status;
  return err;
}

/** A rejected key is worse than no key: drop it so the user is re-prompted. */
function handleAdminFailure(err) {
  if (err.code === 'bad_admin_key') clearAdminKey();
  return err;
}

export async function loadDeadlines({ client, signal } = {}) {
  const params = new URLSearchParams();
  if (client) params.set('client', client);
  try {
    const res = await fetch(`${ENDPOINT}${params.toString() ? `?${params}` : ''}`, { signal });
    const json = await readJson(res);
    if (!json) {
      return { available: false, deadlines: [], reason: 'The deadlines API is not running here (try `vercel dev`).' };
    }
    if (!res.ok) throw toError(json, res);
    return json;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { available: false, deadlines: [], reason: err.message };
  }
}

export async function loadDeadlineEvents({ targetType, targetId }) {
  const params = new URLSearchParams({ events: '1', target_type: targetType, target_id: targetId });
  const res = await fetch(`${ENDPOINT}?${params}`);
  const json = await readJson(res);
  if (!res.ok) throw toError(json, res);
  return json.events || [];
}

/**
 * Create a deadline, or move an existing one.
 * @param {boolean} isEdit true when a deadline already exists — the request
 *   then carries the admin key, because the server will require it.
 */
export async function saveDeadline({ targetType, targetId, clientName, dueAt, note, actor, isEdit }) {
  if (isEdit && !requireAdminKey('editing a review deadline')) return null;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(isEdit ? adminHeaders() : {}) },
    body: JSON.stringify({ targetType, targetId, clientName, dueAt, note, actor }),
  });
  const json = await readJson(res);
  if (!res.ok) throw handleAdminFailure(toError(json, res));
  return json.deadline;
}

export async function reopenDeadline({ targetType, targetId, reopenedUntil, reason, actor }) {
  if (!requireAdminKey('reopening a locked review')) return null;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ action: 'reopen', targetType, targetId, reopenedUntil, reason, actor }),
  });
  const json = await readJson(res);
  if (!res.ok) throw handleAdminFailure(toError(json, res));
  return json.deadline;
}

export async function clearDeadline({ targetType, targetId, actor }) {
  if (!requireAdminKey('removing a review deadline')) return null;

  const params = new URLSearchParams({ target_type: targetType, target_id: targetId });
  if (actor) params.set('actor', actor);
  const res = await fetch(`${ENDPOINT}?${params}`, { method: 'DELETE', headers: adminHeaders() });
  const json = await readJson(res);
  if (!res.ok) throw handleAdminFailure(toError(json, res));
  return json.cleared;
}
