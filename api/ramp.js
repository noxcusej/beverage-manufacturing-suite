// Internal Ramp endpoint for the Procurement Dashboard (staff view).
//
// Read-only: every method other than GET is rejected, so nothing here can
// write to Ramp. The client-facing counterpart is api/portal.js, which
// authenticates with a per-client share token instead of the staff key and
// only ever sees one client's data.

import {
  credentials,
  loadProcurement,
  rampGetAll,
  streamDocument,
  scopeToClient,
  parseClientFields,
  applyCors,
  redact,
} from './_ramp.js';

function checkAuth(req) {
  const key = process.env.RAMP_PROXY_API_KEY || '';
  if (!key) return true; // not configured = open, matching api/inventory.js
  const header = req.headers['x-api-key'] || String(req.headers.authorization || '').replace('Bearer ', '');
  return header === key;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed — this proxy is read-only.' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });

  const q = req.query || {};
  const resource = String(q.resource || 'bootstrap');

  if (!credentials()) {
    // Not an error: a fresh deployment legitimately has no Ramp keys yet, and
    // the dashboard is expected to fall back to demo data.
    return res.status(200).json({
      configured: false,
      reason: 'RAMP_CLIENT_ID / RAMP_CLIENT_SECRET are not set on this deployment.',
      bills: [],
      purchaseOrders: [],
      warnings: [],
    });
  }

  try {
    if (resource === 'document') {
      const { parent_id: parentId, document_id: documentId } = q;
      const parentType = q.parent_type === 'purchase_order' ? 'purchase_order' : 'bill';
      if (!parentId || !documentId) {
        return res.status(400).json({ error: 'document requires parent_id and document_id' });
      }
      return await streamDocument(req, res, {
        parentType, parentId: String(parentId), documentId: String(documentId),
        disposition: q.disposition,
      });
    }

    if (resource === 'vendors') return res.status(200).json({ configured: true, data: await rampGetAll('/vendors') });
    if (resource === 'entities') return res.status(200).json({ configured: true, data: await rampGetAll('/entities') });

    if (resource === 'bills' || resource === 'purchase-orders' || resource === 'bootstrap') {
      const { bills, purchaseOrders, warnings, poEndpoint } = await loadProcurement(q);

      let payload = { bills, purchaseOrders };
      if (q.client) {
        payload = scopeToClient(bills, purchaseOrders, q.client, parseClientFields(q.client_fields));
      }

      return res.status(200).json({
        configured: true,
        env: (process.env.RAMP_ENV || 'demo').toLowerCase(),
        poEndpoint,
        fetchedAt: new Date().toISOString(),
        warnings,
        ...payload,
      });
    }

    return res.status(400).json({ error: `Unknown resource "${resource}"` });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error('[API] ramp error:', redact(err.message));
    return res.status(status).json({ error: redact(err.message) });
  }
}
