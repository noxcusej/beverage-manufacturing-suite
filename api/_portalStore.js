// Server-side store for client portal links and procurement comments.
//
// Uses the Supabase **service** key, never the public anon key. The
// portal_links and procurement_comments tables have RLS on with no anon policy
// (see supabase/migrations/003_create_portal_tables.sql), so this module is the
// only way in — and it runs on the server, where the client's browser cannot
// reach past the scoping applied here.
//
// The leading underscore keeps Vercel from serving this file as a route.

import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
// Service key first: the anon key cannot read these tables, by design.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client = null;

export function store() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  return _client;
}

export function storeUnavailableReason() {
  if (!SUPABASE_URL) return 'SUPABASE_URL is not set on this deployment.';
  if (!SUPABASE_KEY) return 'SUPABASE_SERVICE_KEY is not set on this deployment. The portal needs the service key — the anon key cannot read portal_links or procurement_comments.';
  return null;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/** 32 bytes of randomness, URL-safe. Shown to the operator once, never stored. */
export function mintToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time compare, so a mismatch tells an attacker nothing about where. */
export function tokensMatch(aHex, bHex) {
  const a = Buffer.from(String(aHex), 'hex');
  const b = Buffer.from(String(bHex), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

// ── Portal links ────────────────────────────────────────────────────────────

/**
 * Resolve a raw token to the link it belongs to.
 * @returns {Promise<{ok: true, link: object} | {ok: false, reason: string}>}
 */
export async function resolvePortalLink(rawToken) {
  const db = store();
  if (!db) return { ok: false, reason: 'store_unavailable' };
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 20) {
    return { ok: false, reason: 'invalid' };
  }

  const hash = hashToken(rawToken);
  const { data, error } = await db
    .from('portal_links')
    .select('*')
    .eq('token_hash', hash)
    .maybeSingle();

  if (error) throw new Error(`portal_links lookup failed: ${error.message}`);
  // No row, or a row whose hash somehow differs — same answer either way.
  if (!data || !tokensMatch(data.token_hash, hash)) return { ok: false, reason: 'invalid' };
  if (data.revoked_at) return { ok: false, reason: 'revoked' };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  return { ok: true, link: data };
}

/** Best-effort last-seen stamp; a failure here must never block a page load. */
export async function touchPortalLink(linkId) {
  const db = store();
  if (!db) return;
  await db.from('portal_links').update({ last_seen_at: new Date().toISOString() }).eq('id', linkId);
}

export async function createPortalLink({ clientName, label, createdBy, expiresAt }) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  const token = mintToken();
  const row = {
    id: newId('plink'),
    client_name: clientName,
    token_hash: hashToken(token),
    token_prefix: token.slice(0, 6),
    label: label || null,
    created_by: createdBy || null,
    expires_at: expiresAt || null,
  };

  const { data, error } = await db.from('portal_links').insert(row).select().single();
  if (error) throw new Error(`portal_links insert failed: ${error.message}`);

  // The only time the raw token exists outside the operator's clipboard.
  return { link: data, token };
}

export async function listPortalLinks(clientName) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  let query = db.from('portal_links')
    .select('id, client_name, token_prefix, label, created_by, created_at, last_seen_at, expires_at, revoked_at')
    .order('created_at', { ascending: false });
  if (clientName) query = query.eq('client_name', clientName);

  const { data, error } = await query;
  if (error) throw new Error(`portal_links list failed: ${error.message}`);
  return data || [];
}

export async function revokePortalLink(id) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());
  const { data, error } = await db
    .from('portal_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`portal_links revoke failed: ${error.message}`);
  return data;
}

// ── Comments ────────────────────────────────────────────────────────────────

export const MAX_COMMENT_LENGTH = 4000;

function rowToComment(row) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    clientName: row.client_name,
    authorType: row.author_type,
    authorName: row.author_name,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.clientName] restrict to one client — always set for portal reads
 * @param {boolean} [opts.includeInternal] false for portal reads, so internal notes never leak
 */
export async function listComments({ clientName, includeInternal = true } = {}) {
  const db = store();
  if (!db) return [];

  let query = db.from('procurement_comments')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(2000);

  if (clientName) query = query.eq('client_name', clientName);
  if (!includeInternal) query = query.eq('visibility', 'shared');

  const { data, error } = await query;
  if (error) throw new Error(`comments list failed: ${error.message}`);
  return (data || []).map(rowToComment);
}

export async function addComment({
  targetType, targetId, clientName, authorType, authorName, body, visibility, portalLinkId,
}) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  const text = String(body || '').trim();
  if (!text) throw Object.assign(new Error('A comment cannot be empty.'), { status: 400 });
  if (text.length > MAX_COMMENT_LENGTH) {
    throw Object.assign(new Error(`A comment cannot exceed ${MAX_COMMENT_LENGTH} characters.`), { status: 400 });
  }
  if (targetType !== 'bill' && targetType !== 'purchase_order') {
    throw Object.assign(new Error('targetType must be "bill" or "purchase_order".'), { status: 400 });
  }
  if (!targetId) throw Object.assign(new Error('targetId is required.'), { status: 400 });

  const row = {
    id: newId('cmt'),
    target_type: targetType,
    target_id: String(targetId),
    client_name: clientName,
    author_type: authorType === 'client' ? 'client' : 'internal',
    author_name: authorName || null,
    body: text,
    // A client's comment is always shared — there is no such thing as a client
    // note the client cannot see.
    visibility: authorType === 'client' ? 'shared' : (visibility === 'internal' ? 'internal' : 'shared'),
    portal_link_id: portalLinkId || null,
  };

  const { data, error } = await db.from('procurement_comments').insert(row).select().single();
  if (error) throw new Error(`comment insert failed: ${error.message}`);
  return rowToComment(data);
}

/** Soft delete. Only ever called from the internal route. */
export async function deleteComment(id) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());
  const { error } = await db
    .from('procurement_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`comment delete failed: ${error.message}`);
}

// ── Approval decisions ──────────────────────────────────────────────────────
//
// The staff dashboard writes these through the browser's Supabase client into
// app_data. The portal reads them here so a client sees the same approval
// state the co-packer sees — read-only: rejecting is a staff action.

export async function readBillDecisions() {
  const db = store();
  if (!db) return {};
  const { data, error } = await db.from('app_data').select('data').eq('key', 'bill_decisions').maybeSingle();
  if (error) {
    console.error('[portal] bill_decisions read failed:', error.message);
    return {};
  }
  return data?.data && typeof data.data === 'object' ? data.data : {};
}

// ── Review deadlines ────────────────────────────────────────────────────────
//
// Lock semantics live in src/data/reviewLock.js and are imported here rather
// than restated, so the server and the browser cannot drift apart on what
// "locked" means.

function rowToDeadline(row) {
  if (!row) return null;
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    clientName: row.client_name,
    dueAt: row.due_at,
    note: row.note,
    setBy: row.set_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reopenedUntil: row.reopened_until,
    reopenedBy: row.reopened_by,
    reopenedReason: row.reopened_reason,
  };
}

export async function listDeadlines({ clientName } = {}) {
  const db = store();
  if (!db) return [];
  let query = db.from('review_deadlines').select('*').limit(2000);
  if (clientName) query = query.eq('client_name', clientName);
  const { data, error } = await query;
  if (error) throw new Error(`deadlines list failed: ${error.message}`);
  return (data || []).map(rowToDeadline);
}

export async function getDeadline(targetType, targetId) {
  const db = store();
  if (!db) return null;
  const { data, error } = await db
    .from('review_deadlines')
    .select('*')
    .eq('target_type', targetType)
    .eq('target_id', String(targetId))
    .maybeSingle();
  if (error) throw new Error(`deadline lookup failed: ${error.message}`);
  return rowToDeadline(data);
}

async function recordDeadlineEvent(db, {
  deadlineId, targetType, targetId, clientName, action, actorRole, actor,
  previousDueAt, newDueAt, reason,
}) {
  const { error } = await db.from('review_deadline_events').insert({
    id: newId('rde'),
    deadline_id: deadlineId,
    target_type: targetType,
    target_id: String(targetId),
    client_name: clientName || 'Unassigned',
    action,
    actor_role: actorRole,
    actor: actor || null,
    previous_due_at: previousDueAt || null,
    new_due_at: newDueAt || null,
    reason: reason || null,
  });
  // The audit row is the point of the admin restriction, so a failure to write
  // it is worth shouting about — but not worth losing the operator's change.
  if (error) console.error('[portal] deadline audit write failed:', error.message);
}

export async function listDeadlineEvents({ targetType, targetId } = {}) {
  const db = store();
  if (!db) return [];
  let query = db.from('review_deadline_events').select('*').order('created_at', { ascending: false }).limit(200);
  if (targetType) query = query.eq('target_type', targetType);
  if (targetId) query = query.eq('target_id', String(targetId));
  const { data, error } = await query;
  if (error) throw new Error(`deadline events list failed: ${error.message}`);
  return data || [];
}

/**
 * Create or move a review deadline.
 *
 * @param {'staff'|'admin'} actorRole recorded on the audit row. Whether a given
 *   caller is allowed to be here at all is decided by the route, not here.
 */
export async function upsertDeadline({
  targetType, targetId, clientName, dueAt, note, actor, actorRole,
}) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  const existing = await getDeadline(targetType, targetId);
  const now = new Date().toISOString();

  const row = {
    id: existing?.id || newId('rdl'),
    target_type: targetType,
    target_id: String(targetId),
    client_name: clientName || 'Unassigned',
    due_at: dueAt,
    note: note || null,
    set_by: actor || null,
    updated_at: now,
    // Moving a deadline supersedes any reopen window: the new date is now the
    // single answer to "when does review close?".
    reopened_until: null,
    reopened_by: null,
    reopened_reason: null,
  };

  const { data, error } = await db
    .from('review_deadlines')
    .upsert(row, { onConflict: 'target_type,target_id' })
    .select()
    .single();
  if (error) throw new Error(`deadline write failed: ${error.message}`);

  await recordDeadlineEvent(db, {
    deadlineId: row.id,
    targetType,
    targetId,
    clientName,
    action: existing ? 'edited' : 'set',
    actorRole,
    actor,
    previousDueAt: existing?.dueAt || null,
    newDueAt: dueAt,
    reason: note || null,
  });

  return rowToDeadline(data);
}

/** Lift the lock until `reopenedUntil`, leaving the original due date in place. */
export async function reopenDeadline({ targetType, targetId, reopenedUntil, reason, actor }) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  const existing = await getDeadline(targetType, targetId);
  if (!existing) throw Object.assign(new Error('There is no review deadline on that record to reopen.'), { status: 404 });

  const { data, error } = await db
    .from('review_deadlines')
    .update({
      reopened_until: reopenedUntil,
      reopened_by: actor || null,
      reopened_reason: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw new Error(`deadline reopen failed: ${error.message}`);

  await recordDeadlineEvent(db, {
    deadlineId: existing.id,
    targetType,
    targetId,
    clientName: existing.clientName,
    action: 'reopened',
    actorRole: 'admin',
    actor,
    previousDueAt: existing.dueAt,
    newDueAt: reopenedUntil,
    reason,
  });

  return rowToDeadline(data);
}

export async function clearDeadline({ targetType, targetId, actor, reason }) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());

  const existing = await getDeadline(targetType, targetId);
  if (!existing) return null;

  const { error } = await db.from('review_deadlines').delete().eq('id', existing.id);
  if (error) throw new Error(`deadline clear failed: ${error.message}`);

  await recordDeadlineEvent(db, {
    deadlineId: existing.id,
    targetType,
    targetId,
    clientName: existing.clientName,
    action: 'cleared',
    actorRole: 'admin',
    actor,
    previousDueAt: existing.dueAt,
    newDueAt: null,
    reason,
  });

  return existing;
}

// ── Approval decisions ──────────────────────────────────────────────────────
//
// Moved out of the anon-writable app_data blob so that the deadline lock can be
// enforced on the write path. Absence of a row still means "approved
// automatically" — only exceptions are stored.

export async function listDecisions({ clientName } = {}) {
  const db = store();
  if (!db) return {};
  let query = db.from('bill_decisions').select('*').limit(5000);
  if (clientName) query = query.eq('client_name', clientName);
  const { data, error } = await query;
  if (error) throw new Error(`decisions list failed: ${error.message}`);

  const out = {};
  for (const row of data || []) {
    out[row.bill_id] = {
      status: row.status,
      by: row.decided_by,
      at: row.decided_at,
      reason: row.reason,
    };
  }
  return out;
}

export async function setDecision({ billId, clientName, status, reason, decidedBy }) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());
  if (status !== 'approved' && status !== 'rejected') {
    throw Object.assign(new Error('status must be "approved" or "rejected".'), { status: 400 });
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('bill_decisions')
    .upsert({
      bill_id: String(billId),
      client_name: clientName || null,
      status,
      reason: reason || null,
      decided_by: decidedBy || null,
      decided_at: now,
      updated_at: now,
    }, { onConflict: 'bill_id' })
    .select()
    .single();
  if (error) throw new Error(`decision write failed: ${error.message}`);
  return { status: data.status, by: data.decided_by, at: data.decided_at, reason: data.reason };
}

/** Remove an explicit decision, returning the bill to automatic approval. */
export async function clearDecision(billId) {
  const db = store();
  if (!db) throw new Error(storeUnavailableReason());
  const { error } = await db.from('bill_decisions').delete().eq('bill_id', String(billId));
  if (error) throw new Error(`decision clear failed: ${error.message}`);
}

/**
 * One-time carry-over of decisions that predate the bill_decisions table.
 * Reads the old app_data blob and inserts anything not already present, so an
 * existing deployment does not appear to lose its rejections on upgrade.
 * Safe to call repeatedly: existing rows are left alone.
 */
export async function migrateLegacyDecisions() {
  const db = store();
  if (!db) return { migrated: 0 };

  const legacy = await readBillDecisions();
  const billIds = Object.keys(legacy || {});
  if (!billIds.length) return { migrated: 0 };

  const { data: existing } = await db.from('bill_decisions').select('bill_id').in('bill_id', billIds);
  const have = new Set((existing || []).map((r) => r.bill_id));
  const rows = billIds
    .filter((id) => !have.has(id))
    .map((id) => ({
      bill_id: id,
      client_name: legacy[id]?.clientName || null,
      status: legacy[id]?.status === 'rejected' ? 'rejected' : 'approved',
      reason: legacy[id]?.reason || null,
      decided_by: legacy[id]?.by || null,
      decided_at: legacy[id]?.at || new Date().toISOString(),
    }));

  if (!rows.length) return { migrated: 0 };
  const { error } = await db.from('bill_decisions').insert(rows);
  if (error) {
    console.error('[portal] legacy decision carry-over failed:', error.message);
    return { migrated: 0, error: error.message };
  }
  return { migrated: rows.length };
}
