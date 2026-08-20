// Client Portal — browser client.
//
// This module is what the portal bundle uses instead of src/data/ramp.js and
// src/data/comments.js. It talks to exactly one endpoint, /api/portal, and
// sends a share token with every request. It deliberately has no Supabase
// import and no way to ask for a client other than the one behind the token:
// the server decides that from the database row, not from anything here.

const ENDPOINT = '/api/portal';

async function readJson(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return res.json().catch(() => null);
}

function failure(json, res) {
  const err = new Error(json?.error || `The portal could not load (${res.status}).`);
  err.code = json?.code || null;
  err.detail = json?.detail || null;
  err.status = res.status;
  return err;
}

/** Everything the portal page renders, scoped server-side to one client. */
export async function fetchPortalData(token, { signal } = {}) {
  const res = await fetch(`${ENDPOINT}?resource=bootstrap`, {
    signal,
    headers: { Accept: 'application/json', 'x-portal-token': token },
  });

  const json = await readJson(res);
  if (!json) {
    const err = new Error('The portal API is not running on this deployment.');
    err.code = 'no_api';
    throw err;
  }
  if (!res.ok) throw failure(json, res);
  return json;
}

export async function postPortalComment(token, { targetType, targetId, body, authorName }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-portal-token': token },
    body: JSON.stringify({ targetType, targetId, body, authorName }),
  });
  const json = await readJson(res);
  if (!res.ok) throw failure(json, res);
  return json.comment;
}

/**
 * Attachment links are plain anchors, so the token has to travel in the query
 * string rather than a header. That is no more exposed than the portal URL the
 * client is already looking at, and the server still re-checks that the file
 * belongs to this client before streaming a byte.
 */
export function portalAttachmentUrl(token, doc, { inline = false } = {}) {
  if (!doc?.downloadPath) return null;
  const params = new URLSearchParams({
    resource: 'document',
    parent_type: doc.parentType || 'bill',
    parent_id: doc.parentId,
    document_id: doc.id,
    token,
  });
  if (inline) params.set('disposition', 'inline');
  return `${ENDPOINT}?${params}`;
}

// ── Staff side: minting and revoking links ──────────────────────────────────

const LINKS_ENDPOINT = '/api/portal-links';

export async function listPortalLinks({ client, signal } = {}) {
  const params = new URLSearchParams();
  if (client) params.set('client', client);
  try {
    const res = await fetch(`${LINKS_ENDPOINT}${params.toString() ? `?${params}` : ''}`, { signal });
    const json = await readJson(res);
    if (!json) {
      return { available: false, links: [], reason: 'The portal-links API is not running here (try `vercel dev`).' };
    }
    if (!res.ok) throw failure(json, res);
    return json;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { available: false, links: [], reason: err.message };
  }
}

/** Returns { link, url } — the URL is shown once and cannot be re-read later. */
export async function createPortalLink({ clientName, label, createdBy, expiresAt }) {
  const res = await fetch(LINKS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName, label, createdBy, expiresAt }),
  });
  const json = await readJson(res);
  if (!res.ok) throw failure(json, res);
  return json;
}

export async function revokePortalLink(id) {
  const res = await fetch(`${LINKS_ENDPOINT}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const json = await readJson(res);
  if (!res.ok) throw failure(json, res);
  return json.link;
}
