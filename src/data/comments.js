// Comments on bills and purchase orders — browser side.
//
// Two storage paths, deliberately:
//
//  1. `/api/comments`, backed by the procurement_comments table through the
//     Supabase **service** key. This is the shared path — the only one the
//     client portal can read or write.
//  2. The app's own store, used when that route is unavailable (no service key
//     configured, or a dev server without a serverless runtime). Commenting
//     keeps working internally; the UI labels those comments as local, because
//     a client will not see them.
//
// The portal never uses this module — see src/data/portalClient.js.

import { getLocalComments, addLocalComment, deleteLocalComment } from './store';

const ENDPOINT = '/api/comments';

export const SOURCE_SHARED = 'shared';
export const SOURCE_LOCAL = 'local';

// The pure helpers live in commentModel.js so they stay testable outside a
// browser; re-exported here so callers have one import.
export { commentKey, groupComments, visibleToClient } from './commentModel';

function localId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readJson(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return res.json().catch(() => null);
}

/**
 * Load every comment the staff view may see, internal notes included.
 * @returns {Promise<{source: string, comments: object[], reason: string|null}>}
 */
export async function loadComments({ client, signal } = {}) {
  const params = new URLSearchParams();
  if (client) params.set('client', client);

  try {
    const res = await fetch(`${ENDPOINT}${params.toString() ? `?${params}` : ''}`, { signal });
    const json = await readJson(res);
    if (res.ok && json?.available) {
      return { source: SOURCE_SHARED, comments: json.comments || [], reason: null };
    }
    return {
      source: SOURCE_LOCAL,
      comments: getLocalComments(),
      reason: json?.reason
        || 'Comments are stored on this device only — they are not shared with client portals.',
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      source: SOURCE_LOCAL,
      comments: getLocalComments(),
      reason: `Could not reach ${ENDPOINT}. Comments are stored locally and are not shared with client portals.`,
    };
  }
}

/**
 * Post a staff comment. Falls back to local storage using the same shape the
 * API returns, so callers never branch on where it landed.
 */
export async function postComment({ targetType, targetId, clientName, authorName, body, visibility }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('A comment cannot be empty.');

  const payload = {
    targetType, targetId, clientName, authorName, body: text,
    visibility: visibility === 'internal' ? 'internal' : 'shared',
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await readJson(res);
    if (res.ok && json?.comment) return { comment: json.comment, source: SOURCE_SHARED };
    if (json?.error) throw new Error(json.error);
  } catch (err) {
    // A thrown validation error from the API above should surface, not be
    // silently swallowed into a local write.
    if (err instanceof Error && err.message && !/fetch|network|Failed to/i.test(err.message)) throw err;
  }

  const comment = {
    id: localId(),
    ...payload,
    authorType: 'internal',
    createdAt: new Date().toISOString(),
    local: true,
  };
  addLocalComment(comment);
  return { comment, source: SOURCE_LOCAL };
}

export async function removeComment(comment) {
  if (comment?.local) {
    deleteLocalComment(comment.id);
    return;
  }
  const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const json = await readJson(res);
    throw new Error(json?.error || `Could not delete the comment (${res.status}).`);
  }
}
