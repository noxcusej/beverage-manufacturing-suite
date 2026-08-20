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
