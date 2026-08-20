// Client Portal endpoint — the only server surface a client's browser touches.
//
// Authenticated by a per-client share token, never by a login. Everything it
// returns is scoped to the one client that token was minted for, server-side:
// the client name comes from the database row behind the token, never from
// anything the caller sends. There is no parameter here that widens the scope.
//
// What a client can do: read their own POs, bills and attachments, and post
// comments. What they cannot do: see another client's data, see internal-only
// comments, see anything else in the manufacturing suite, or change approval
// state.

import {
  credentials,
  loadProcurement,
  scopeToClient,
  parseClientFields,
  applyCors,
  redact,
  streamDocument,
} from './_ramp.js';
import {
  resolvePortalLink,
  touchPortalLink,
  listComments,
  addComment,
  listDeadlines,
  listDecisions,
  readBillDecisions,
  storeUnavailableReason,
} from './_portalStore.js';
import { lockForTarget, lockedResponse } from './_reviewLock.js';

// A reserved token that previews the portal against the bundled demo dataset.
// It only works when there is no link store AND no Ramp credentials — i.e.
// when there is no real data on this deployment that could possibly leak.
const DEMO_TOKEN = 'demo';

function tokenFrom(req) {
  const header = req.headers['x-portal-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

function demoModeAvailable() {
  return !credentials() && Boolean(storeUnavailableReason());
}

/**
 * Resolve the caller to a client, or explain why not.
 * @returns {Promise<{status: number, body?: object, link?: object, clientName?: string, demo?: boolean}>}
 */
async function authenticate(req) {
  const token = tokenFrom(req);
  if (!token) {
    return { status: 401, body: { error: 'This link is missing its access token.', code: 'no_token' } };
  }

  if (token === DEMO_TOKEN && demoModeAvailable()) {
    return { status: 200, demo: true, clientName: null };
  }

  const reason = storeUnavailableReason();
  if (reason) {
    return {
      status: 503,
      body: {
        error: 'Client portal links are not available on this deployment yet.',
        detail: reason,
        code: 'store_unavailable',
      },
    };
  }

  const result = await resolvePortalLink(token);
  if (!result.ok) {
    // Deliberately uniform: an attacker learns whether a link is dead, not
    // whether some other client's link exists.
    const messages = {
      revoked: 'This link has been revoked. Ask your contact for a new one.',
      expired: 'This link has expired. Ask your contact for a new one.',
      invalid: 'This link is not valid. Check that you copied the whole URL.',
      store_unavailable: 'Client portal links are not available on this deployment yet.',
    };
    return { status: 403, body: { error: messages[result.reason] || messages.invalid, code: result.reason } };
  }

  return { status: 200, link: result.link, clientName: result.link.client_name };
}

/**
 * The set of bill and PO ids this client may touch. Recomputed per request
 * rather than trusted from the caller — an attachment link is just a URL, and
 * a client must not be able to reach another client's file by editing one.
 */
async function scopedIds(clientName, clientFields) {
  const { bills, purchaseOrders } = await loadProcurement({});
  const scoped = scopeToClient(bills, purchaseOrders, clientName, clientFields);
  return {
    billIds: new Set(scoped.bills.map((b) => String(b.id))),
    poIds: new Set(scoped.purchaseOrders.map((p) => String(p.id))),
  };
}

export default async function handler(req, res) {
  applyCors(res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await authenticate(req);
    if (auth.status !== 200) return res.status(auth.status).json(auth.body);

    const { link, clientName, demo } = auth;
    const clientFields = parseClientFields(process.env.RAMP_CLIENT_FIELDS);

    // ── POST: leave a comment ────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (demo) {
        return res.status(503).json({
          error: 'Comments need a database. This is a preview of the portal against demo data.',
          code: 'demo_readonly',
        });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { targetType, targetId, authorName } = body;

      // Ownership check: a client may only comment on their own records.
      const ids = await scopedIds(clientName, clientFields);
      const allowed = targetType === 'purchase_order'
        ? ids.poIds.has(String(targetId))
        : ids.billIds.has(String(targetId));
      if (!allowed) {
        return res.status(403).json({ error: 'That record is not on this portal.', code: 'not_in_scope' });
      }

      // The review deadline closes the dispute window. A client posting after
      // it is refused here, not merely discouraged by a disabled textarea.
      const { lock, inherited } = await lockForTarget(targetType, targetId);
      if (lock.locked) {
        return res.status(423).json({
          ...lockedResponse(lock, 'This review'),
          remedy: 'Contact your account manager if you still need to raise something.',
          inheritedFromPurchaseOrder: inherited,
        });
      }

      const comment = await addComment({
        targetType,
        targetId,
        clientName,
        authorType: 'client',
        authorName: authorName || link.label || clientName,
        body: body.body,
        portalLinkId: link.id,
      });
      return res.status(201).json({ comment });
    }

    const resource = String(req.query?.resource || 'bootstrap');

    // ── GET document: stream one attachment ──────────────────────────────────
    if (resource === 'document') {
      if (demo) {
        return res.status(404).json({ error: 'Demo attachments have no file behind them.', code: 'demo_no_file' });
      }
      const parentId = String(req.query.parent_id || '');
      const documentId = String(req.query.document_id || '');
      const parentType = req.query.parent_type === 'purchase_order' ? 'purchase_order' : 'bill';
      if (!parentId || !documentId) {
        return res.status(400).json({ error: 'document requires parent_id and document_id' });
      }

      const ids = await scopedIds(clientName, clientFields);
      const owns = parentType === 'purchase_order' ? ids.poIds.has(parentId) : ids.billIds.has(parentId);
      if (!owns) {
        return res.status(403).json({ error: 'That file is not on this portal.', code: 'not_in_scope' });
      }

      return await streamDocument(req, res, {
        parentType, parentId, documentId, disposition: req.query.disposition,
      });
    }

    // ── GET bootstrap: everything the portal page renders ────────────────────
    if (resource !== 'bootstrap') {
      return res.status(400).json({ error: `Unknown resource "${resource}"` });
    }

    if (demo) {
      return res.status(200).json({
        configured: false,
        demo: true,
        client: null,
        reason: 'Previewing the client portal against demo data. Configure Ramp and Supabase to serve a real client.',
        bills: [],
        purchaseOrders: [],
        comments: [],
        decisions: {},
        deadlines: [],
        warnings: [],
      });
    }

    if (!credentials()) {
      return res.status(503).json({
        error: 'This portal is not connected to Ramp yet.',
        detail: 'RAMP_CLIENT_ID / RAMP_CLIENT_SECRET are not set on this deployment.',
        code: 'ramp_unconfigured',
      });
    }

    const [{ bills, purchaseOrders, warnings }, comments, tableDecisions, legacyDecisions, deadlines] =
      await Promise.all([
        loadProcurement({}),
        // includeInternal: false — internal notes are never sent to a client.
        listComments({ clientName, includeInternal: false }),
        listDecisions({}),
        // Anything not yet carried over from the pre-table blob still counts.
        readBillDecisions(),
        listDeadlines({ clientName }),
      ]);
    const decisions = { ...legacyDecisions, ...tableDecisions };

    const scoped = scopeToClient(bills, purchaseOrders, clientName, clientFields);

    // Trim the decision map to this client's bills, so nothing about another
    // client's spend rides along in the response.
    const scopedBillIds = new Set(scoped.bills.map((b) => String(b.id)));
    const scopedDecisions = {};
    for (const [billId, decision] of Object.entries(decisions)) {
      if (scopedBillIds.has(String(billId))) scopedDecisions[billId] = decision;
    }

    // Deadlines are already filtered to this client, but a PO-level deadline
    // must also survive the bill/PO scoping to be useful on the page.
    const scopedPoIds = new Set(scoped.purchaseOrders.map((p) => String(p.id)));
    const scopedDeadlines = deadlines.filter((d) => (
      d.targetType === 'bill' ? scopedBillIds.has(String(d.targetId)) : scopedPoIds.has(String(d.targetId))
    ));

    touchPortalLink(link.id).catch(() => {});

    return res.status(200).json({
      configured: true,
      demo: false,
      client: clientName,
      linkLabel: link.label || null,
      fetchedAt: new Date().toISOString(),
      warnings,
      bills: scoped.bills,
      purchaseOrders: scoped.purchaseOrders,
      comments,
      decisions: scopedDecisions,
      deadlines: scopedDeadlines,
    });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error('[API] portal error:', redact(err.message));
    return res.status(status).json({ error: redact(err.message) });
  }
}
