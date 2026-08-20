// Shared, read-only Ramp access layer.
//
// Imported by api/ramp.js (internal dashboard) and api/portal.js (client
// portal). The leading underscore keeps Vercel from serving this file as a
// route of its own.
//
// The browser never talks to Ramp directly: the client credentials would have
// to ship to the client, Ramp does not send CORS headers for browser origins,
// and the presigned attachment URLs Ramp returns expire. This function holds
// the credentials, caches the OAuth token, and re-resolves attachment URLs at
// click time.
//
// Everything here is GET-only. Nothing in this file can mutate Ramp data —
// approvals and rejections live in this app's own store, by design (see
// src/data/procurement.js).
//
// ── Environment ─────────────────────────────────────────────────────────────
//   RAMP_CLIENT_ID       OAuth client id       (required for live data)
//   RAMP_CLIENT_SECRET   OAuth client secret   (required for live data)
//   RAMP_ENV             'demo' (default) | 'production'
//   RAMP_API_BASE        overrides the base URL entirely
//   RAMP_SCOPES          space-separated; defaults to the read scopes below
//   RAMP_PROXY_API_KEY   when set, callers must send it as x-api-key
//
// Without credentials the endpoint reports { configured: false } and the
// dashboard falls back to its bundled demo dataset.

const API_BASES = {
  demo: 'https://demo-api.ramp.com/developer/v1',
  production: 'https://api.ramp.com/developer/v1',
};

const DEFAULT_SCOPES = 'bills:read vendors:read entities:read accounting:read';

// Ramp has shipped purchase orders under more than one path. Try each in turn
// and remember which one answered, so a tenant on a different revision still
// works and the dashboard can say which path it used.
const PO_PATH_CANDIDATES = ['/purchase-orders', '/purchase_orders', '/bill-purchase-orders'];

const MAX_PAGES = 20; // hard stop so a runaway cursor can't hang the function

export function apiBase() {
  if (process.env.RAMP_API_BASE) return process.env.RAMP_API_BASE.replace(/\/$/, '');
  const env = (process.env.RAMP_ENV || 'demo').toLowerCase();
  return API_BASES[env] || API_BASES.demo;
}

export function credentials() {
  const id = process.env.RAMP_CLIENT_ID;
  const secret = process.env.RAMP_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

// ── Token cache ─────────────────────────────────────────────────────────────
// Module scope survives between invocations on a warm serverless instance, so
// most requests skip the token round trip. A cold start just fetches again.

let _token = null; // { value, expiresAt }

async function getAccessToken() {
  const creds = credentials();
  if (!creds) throw httpError(503, 'Ramp credentials are not configured on this deployment.');

  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.value;

  const basic = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: process.env.RAMP_SCOPES || DEFAULT_SCOPES,
  });

  const res = await fetch(`${apiBase()}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw httpError(res.status === 401 ? 401 : 502,
      `Ramp token request failed (${res.status}). ${redact(detail).slice(0, 300)}`);
  }

  const json = await res.json();
  if (!json.access_token) throw httpError(502, 'Ramp token response had no access_token.');

  _token = {
    value: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  return _token.value;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Never let a client id/secret echo back through an error message. */
export function redact(text) {
  let out = String(text || '');
  for (const secret of [process.env.RAMP_CLIENT_SECRET, process.env.RAMP_CLIENT_ID]) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}

// ── Ramp fetch helpers ──────────────────────────────────────────────────────

export async function rampGet(path, { raw = false } = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${apiBase()}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (raw) return res;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw httpError(res.status, `Ramp GET ${path} failed (${res.status}). ${redact(detail).slice(0, 300)}`);
  }
  return res.json();
}

/** Walk Ramp's cursor pagination (`page.next`) and concatenate `data`. */
export async function rampGetAll(path, { pageSize = 100 } = {}) {
  const joiner = path.includes('?') ? '&' : '?';
  let next = `${path}${joiner}page_size=${pageSize}`;
  const items = [];

  for (let i = 0; i < MAX_PAGES && next; i += 1) {
    const json = await rampGet(next);
    const page = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    items.push(...page);
    next = json?.page?.next || null;
  }
  return items;
}

/** Resolve the purchase-order path this tenant actually serves. */
let _poPath = null;
export async function fetchPurchaseOrders() {
  const paths = _poPath ? [_poPath] : PO_PATH_CANDIDATES;
  const attempted = [];

  for (const path of paths) {
    try {
      const items = await rampGetAll(path);
      _poPath = path;
      return { items, path, warning: null };
    } catch (err) {
      attempted.push(`${path} → ${err.status || 'error'}`);
      // 404/403 means "not this path / not entitled" — keep trying. Anything
      // else (429, 500, auth) is a real failure worth surfacing immediately.
      if (err.status !== 404 && err.status !== 403) throw err;
    }
  }

  return {
    items: [],
    path: null,
    warning:
      'No Ramp purchase-order endpoint responded (' + attempted.join(', ') + '). ' +
      'Purchase orders were derived from the PO references on each bill instead.',
  };
}

/**
 * When Ramp serves no PO endpoint, still give the dashboard something to group
 * by: synthesize a PO per distinct PO number referenced by the bills. The
 * committed amount is unknown in that case and reported as 0, which the UI
 * renders as "not available" rather than as a zero budget.
 */
export function derivePurchaseOrdersFromBills(bills) {
  const byNumber = new Map();
  for (const bill of bills) {
    const number = String(
      bill?.purchase_order_number || bill?.purchase_order?.number || bill?.po_number || ''
    ).trim() || matchPoInText(bill);
    // A bill may reference its PO by id only. Key the derived PO by that id so
    // it still matches, and fall back to the number when there is no id.
    const poId = bill?.purchase_order_id || bill?.purchase_order?.id || null;
    if (!number && !poId) continue;
    const key = (number || poId).toUpperCase();
    if (!byNumber.has(key)) {
      byNumber.set(key, {
        id: poId || `derived:${key}`,
        number: number || key,
        derived: true,
        vendor: bill.vendor,
        entity: bill.entity,
        status: 'UNKNOWN',
        issued_at: bill.issued_at || bill.created_at,
        amount: null,
        accounting_field_selections: bill.accounting_field_selections || [],
        line_items: [],
      });
    }
  }
  return [...byNumber.values()];
}

export function matchPoInText(bill) {
  const haystack = [bill?.memo, bill?.notes, bill?.invoice_number, bill?.description]
    .filter((s) => typeof s === 'string').join(' ');
  const m = haystack.match(/\bPO[\s#:-]*([A-Z0-9][A-Z0-9-]{2,})\b/i);
  return m ? `PO-${m[1].replace(/^-+/, '')}`.toUpperCase() : '';
}

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * Find a document on a bill or purchase order and hand back a URL we can
 * fetch. Ramp returns presigned links inside the parent record, so we always
 * re-read the parent instead of trusting a URL supplied by the caller — that
 * keeps this endpoint from being turned into an open fetch proxy.
 */
async function resolveDocumentUrl(parentType, parentId, documentId) {
  const parent = parentType === 'purchase_order'
    ? await getPurchaseOrder(parentId)
    : await rampGet(`/bills/${encodeURIComponent(parentId)}`);

  const buckets = [parent?.documents, parent?.invoice_documents, parent?.attachments, parent?.receipts, parent?.files]
    .filter(Array.isArray);

  for (const bucket of buckets) {
    for (const doc of bucket) {
      const id = doc?.id || doc?.document_id || doc?.receipt_id || doc?.file_id;
      if (String(id) !== String(documentId)) continue;
      const url = doc?.download_url || doc?.url || doc?.presigned_url || doc?.file_url;
      if (!url) throw httpError(502, 'Ramp returned the document but no download URL.');
      return {
        url,
        name: doc?.filename || doc?.file_name || doc?.name || `${documentId}`,
        contentType: doc?.content_type || doc?.mime_type || null,
      };
    }
  }
  throw httpError(404, `Document ${documentId} was not found on ${parentType} ${parentId}.`);
}

/**
 * Read one purchase order. A document request can be the first call on a cold
 * instance, so the tenant's PO path may not be known yet — try each candidate
 * rather than guessing.
 */
async function getPurchaseOrder(id) {
  const paths = _poPath ? [_poPath] : PO_PATH_CANDIDATES;
  let lastErr = null;
  for (const base of paths) {
    try {
      const po = await rampGet(`${base}/${encodeURIComponent(id)}`);
      _poPath = base;
      return po;
    } catch (err) {
      lastErr = err;
      if (err.status !== 404 && err.status !== 403) throw err;
    }
  }
  throw lastErr || httpError(404, `Purchase order ${id} was not found.`);
}

export async function streamDocument(req, res, { parentType, parentId, documentId, disposition }) {
  const doc = await resolveDocumentUrl(parentType, parentId, documentId);

  // The presigned URL is already authorized; sending our bearer token to S3
  // would only get the request rejected.
  const upstream = await fetch(doc.url);
  if (!upstream.ok) {
    return res.status(502).json({ error: `Attachment fetch failed (${upstream.status}).` });
  }

  const contentType = upstream.headers.get('content-type') || doc.contentType || 'application/octet-stream';
  const safeName = doc.name.replace(/[^\w.\- ]+/g, '_');
  const mode = disposition === 'inline' ? 'inline' : 'attachment';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${mode}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);

  const buffer = Buffer.from(await upstream.arrayBuffer());
  return res.status(200).send(buffer);
}

// ── Client scoping ──────────────────────────────────────────────────────────
//
// When the caller asks for one client's view, filter here rather than in the
// browser: a client-facing dashboard should never receive another client's
// bills in its network response, whatever the UI chooses to render.

export const DEFAULT_CLIENT_FIELDS = ['client', 'client name', 'customer', 'brand'];

export function clientOf(record, fields) {
  const match = (sel) => {
    const name = String(
      sel?.field_name || sel?.category_info?.name || sel?.field?.name || sel?.type || sel?.name || ''
    ).toLowerCase();
    return name && fields.some((f) => name === f || name.includes(f));
  };
  const valueOf = (sel) =>
    sel?.option_name || sel?.value || sel?.category_info?.option_name || sel?.selected_option?.name || sel?.name || null;

  const top = (record?.accounting_field_selections || []).find(match);
  if (top && valueOf(top)) return String(valueOf(top));

  for (const li of record?.line_items || []) {
    const hit = (li?.accounting_field_selections || []).find(match);
    if (hit && valueOf(hit)) return String(valueOf(hit));
  }

  const memo = [record?.memo, record?.notes].find((s) => typeof s === 'string') || '';
  const tagged = memo.match(/\[\s*client\s*[:=]\s*([^\]]+)\]/i) || memo.match(/\bclient\s*[:=]\s*([^\n,;|]+)/i);
  return tagged?.[1]?.trim() || null;
}

export function scopeToClient(bills, purchaseOrders, client, fields) {
  const wanted = String(client).trim().toLowerCase();
  const poClient = new Map();
  purchaseOrders.forEach((po) => poClient.set(po.id, clientOf(po, fields)));

  const keptPOs = purchaseOrders.filter((po) => (poClient.get(po.id) || '').toLowerCase() === wanted);
  const keptPoIds = new Set(keptPOs.map((po) => po.id));
  const keptPoNumbers = new Set(
    keptPOs.map((po) => String(po.number || po.po_number || '').toUpperCase()).filter(Boolean)
  );

  const keptBills = bills.filter((bill) => {
    const own = clientOf(bill, fields);
    if (own) return own.toLowerCase() === wanted;
    // No client of its own — it belongs to the client on its PO.
    const poId = bill?.purchase_order_id || bill?.purchase_order?.id;
    if (poId && keptPoIds.has(poId)) return true;
    const number = String(bill?.purchase_order_number || bill?.po_number || matchPoInText(bill) || '').toUpperCase();
    return Boolean(number) && keptPoNumbers.has(number);
  });

  return { bills: keptBills, purchaseOrders: keptPOs };
}

// ── Combined load ───────────────────────────────────────────────────────────

/**
 * Fetch bills and purchase orders together — the one call both routes make.
 * Falls back to POs derived from the bills' own references when the tenant
 * serves no purchase-order endpoint.
 *
 * @param {object} filters optional from_issued_date / to_issued_date / entity_id
 * @returns {Promise<{bills: object[], purchaseOrders: object[], warnings: string[], poEndpoint: string|null}>}
 */
export async function loadProcurement(filters = {}) {
  const parts = [];
  if (filters.from_issued_date) parts.push(`from_issued_date=${encodeURIComponent(filters.from_issued_date)}`);
  if (filters.to_issued_date) parts.push(`to_issued_date=${encodeURIComponent(filters.to_issued_date)}`);
  if (filters.entity_id) parts.push(`entity_id=${encodeURIComponent(filters.entity_id)}`);
  const billPath = `/bills${parts.length ? `?${parts.join('&')}` : ''}`;

  const [bills, poResult] = await Promise.all([rampGetAll(billPath), fetchPurchaseOrders()]);

  const warnings = [];
  let purchaseOrders = poResult.items;
  if (poResult.warning) {
    warnings.push(poResult.warning);
    purchaseOrders = derivePurchaseOrdersFromBills(bills);
  }

  return { bills, purchaseOrders, warnings, poEndpoint: poResult.path };
}

/** Parse a comma-separated client-field override, falling back to the defaults. */
export function parseClientFields(raw) {
  if (!raw) return DEFAULT_CLIENT_FIELDS;
  const fields = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return fields.length ? fields : DEFAULT_CLIENT_FIELDS;
}

/** Standard CORS + method guard for the read-only routes built on this module. */
export function applyCors(res, methods = 'GET,OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-portal-token, Authorization');
}
