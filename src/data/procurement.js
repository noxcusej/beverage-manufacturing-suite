// Procurement domain logic — pure functions, no DOM, no network.
//
// Turns raw Ramp payloads (bills, purchase orders, vendors, entities) into the
// shape the Procurement Dashboard renders, and computes the roll-ups. Kept
// free of React/browser APIs so it can be exercised by procurement.test.mjs.
//
// ── Money ──────────────────────────────────────────────────────────────────
// Everything is carried internally as integer **cents** (minor units) so that
// subtotals never drift the way repeated float addition does. Format only at
// the edge, with formatMoney().
//
// Ramp's CurrencyAmount object is `{ amount, currency_code }` with `amount` in
// the currency's minor unit — 12345 means $123.45. Bare numbers coming from
// hand-authored or legacy payloads are treated as major units (dollars).
// If a given Ramp tenant turns out to return major units in the object form,
// flip AMOUNT_OBJECTS_ARE_MINOR_UNITS below; it is the single place that
// assumption lives.

export const AMOUNT_OBJECTS_ARE_MINOR_UNITS = true;

/** Names of Ramp accounting fields that carry the client a spend is billed to. */
export const DEFAULT_CLIENT_FIELD_NAMES = ['client', 'client name', 'customer', 'brand'];

export const UNASSIGNED_CLIENT = 'Unassigned';

/**
 * Coerce any of Ramp's money shapes to integer cents.
 * Accepts { amount, currency_code }, a number, a numeric string, or null.
 * @returns {{ cents: number, currency: string|null }}
 */
export function toMoney(value, fallbackCurrency = null) {
  if (value === null || value === undefined || value === '') {
    return { cents: 0, currency: fallbackCurrency };
  }
  if (typeof value === 'object') {
    const raw = Number(value.amount ?? value.value ?? 0);
    const currency = value.currency_code || value.currency || fallbackCurrency;
    if (!Number.isFinite(raw)) return { cents: 0, currency };
    const cents = AMOUNT_OBJECTS_ARE_MINOR_UNITS ? Math.round(raw) : Math.round(raw * 100);
    return { cents, currency };
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) return { cents: 0, currency: fallbackCurrency };
  return { cents: Math.round(raw * 100), currency: fallbackCurrency };
}

export function formatMoney(cents, currency = 'USD') {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Unknown currency code — fall back to a plain number with the code appended.
    return `${amount.toFixed(2)} ${currency || ''}`.trim();
  }
}

function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Client resolution ────────────────────────────────────────────────────────

/**
 * Ramp exposes custom accounting dimensions as `accounting_field_selections`.
 * The shape varies by tenant and by API version, so read tolerantly: the field
 * *name* may sit on the selection itself, on `category_info`, or on a nested
 * `field` object, and the selected *value* may be `option_name`, `name`, or
 * `value`.
 */
function selectionFieldName(sel) {
  return firstString(
    sel?.field_name,
    sel?.category_info?.name,
    sel?.category_info?.type,
    sel?.field?.name,
    sel?.type,
    sel?.name
  );
}

function selectionValue(sel) {
  return firstString(
    sel?.option_name,
    sel?.value,
    sel?.category_info?.option_name,
    sel?.selected_option?.name,
    sel?.name
  );
}

function matchesClientField(name, clientFieldNames) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return clientFieldNames.some((f) => lower === f || lower.includes(f));
}

/**
 * Pull the client name out of a raw Ramp bill / purchase order.
 *
 * Resolution order — first hit wins:
 *   1. an explicit override supplied by the app (billId -> client)
 *   2. a top-level accounting field selection whose field name looks like a client field
 *   3. the same, on any line item (the most common single value wins)
 *   4. a `[Client: X]` / `Client: X` tag in the memo
 *   5. the Ramp entity name, when the tenant models each client as an entity
 *
 * @returns {string|null} null when nothing matched — callers show UNASSIGNED_CLIENT.
 */
export function resolveClientName(raw, options = {}) {
  const {
    clientFieldNames = DEFAULT_CLIENT_FIELD_NAMES,
    overrides = {},
    useEntityAsClient = false,
  } = options;

  const fields = clientFieldNames.map((f) => String(f).toLowerCase().trim()).filter(Boolean);

  const override = overrides[raw?.id];
  if (override) return override;

  const topLevel = (raw?.accounting_field_selections || []).find((sel) =>
    matchesClientField(selectionFieldName(sel), fields)
  );
  if (topLevel && selectionValue(topLevel)) return selectionValue(topLevel);

  // Line-item level: count occurrences so a bill split across clients reports
  // the dominant one rather than whichever line happens to be first.
  const tally = new Map();
  for (const li of raw?.line_items || []) {
    for (const sel of li?.accounting_field_selections || []) {
      if (!matchesClientField(selectionFieldName(sel), fields)) continue;
      const val = selectionValue(sel);
      if (val) tally.set(val, (tally.get(val) || 0) + 1);
    }
  }
  if (tally.size) {
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }

  const memo = firstString(raw?.memo, raw?.notes, raw?.description);
  if (memo) {
    const tagged = memo.match(/\[\s*client\s*[:=]\s*([^\]]+)\]/i) || memo.match(/\bclient\s*[:=]\s*([^\n,;|]+)/i);
    if (tagged?.[1]?.trim()) return tagged[1].trim();
  }

  if (useEntityAsClient) {
    const entity = firstString(raw?.entity?.name, raw?.entity_name);
    if (entity) return entity;
  }

  return null;
}

// ── Purchase-order reference on a bill ───────────────────────────────────────

/**
 * Find which PO a bill belongs to. Ramp may hand back a structured reference,
 * or the number may only exist as text in the memo / invoice number.
 * @returns {{ id: string|null, number: string|null }}
 */
export function resolvePoReference(raw) {
  const id = firstString(
    raw?.purchase_order_id,
    raw?.purchase_order?.id,
    raw?.po_id,
    Array.isArray(raw?.purchase_orders) ? raw.purchase_orders[0]?.id : null
  );
  let number = firstString(
    raw?.purchase_order_number,
    raw?.purchase_order?.number,
    raw?.purchase_order?.po_number,
    raw?.po_number,
    Array.isArray(raw?.purchase_orders) ? raw.purchase_orders[0]?.number : null
  );

  if (!number) {
    const haystack = [raw?.memo, raw?.notes, raw?.invoice_number, raw?.description]
      .filter((s) => typeof s === 'string')
      .join(' ');
    const match = haystack.match(/\bPO[\s#:-]*([A-Z0-9][A-Z0-9-]{2,})\b/i);
    if (match) number = `PO-${match[1].replace(/^-+/, '')}`.toUpperCase();
  }

  return { id: id || null, number: number || null };
}

// ── Documents / attachments ──────────────────────────────────────────────────

/**
 * Normalize the several shapes Ramp uses for attached files. The presigned
 * download URLs Ramp returns expire, so the dashboard never links to them
 * directly — it links back through our own proxy, which re-resolves the URL
 * server-side at click time.
 */
export function normalizeDocuments(raw, { parentType, parentId }) {
  const buckets = [
    raw?.documents,
    raw?.invoice_documents,
    raw?.attachments,
    raw?.receipts,
    raw?.files,
  ].filter(Array.isArray);

  const seen = new Set();
  const docs = [];

  for (const bucket of buckets) {
    for (const doc of bucket) {
      if (!doc) continue;
      const id = firstString(doc.id, doc.document_id, doc.receipt_id, doc.file_id, doc.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const name = firstString(doc.filename, doc.file_name, doc.name, doc.title) || `${id}`;
      docs.push({
        id,
        name,
        // Carried so a caller can rebuild the download URL for a different
        // surface (the client portal routes through /api/portal instead).
        parentType,
        parentId,
        type: firstString(doc.attachment_type, doc.document_type, doc.type) || 'FILE',
        contentType: firstString(doc.content_type, doc.mime_type) || null,
        uploadedAt: isoOrNull(doc.created_at || doc.uploaded_at),
        // Resolved lazily through the proxy; never a bare presigned URL.
        downloadPath: `/api/ramp?resource=document&parent_type=${encodeURIComponent(parentType)}` +
          `&parent_id=${encodeURIComponent(parentId)}&document_id=${encodeURIComponent(id)}`,
      });
    }
  }

  return docs;
}

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeLineItems(raw, currency) {
  return (raw?.line_items || []).map((li, i) => {
    const money = toMoney(li?.amount ?? li?.total, currency);
    const unit = li?.unit_price !== undefined ? toMoney(li.unit_price, currency) : null;
    const quantity = Number(li?.quantity ?? li?.qty);
    return {
      id: firstString(li?.id, li?.line_item_id) || `${raw?.id || 'line'}-${i}`,
      description: firstString(li?.memo, li?.description, li?.name) || `Line ${i + 1}`,
      quantity: Number.isFinite(quantity) ? quantity : null,
      unitPriceCents: unit ? unit.cents : null,
      amountCents: money.cents,
      currency: money.currency || currency,
      category: firstString(
        li?.category_info?.name,
        li?.accounting_field_selections?.[0] && selectionValue(li.accounting_field_selections[0])
      ),
    };
  });
}

/** Ramp bill/payment statuses we treat as "money already out the door". */
const PAID_STATUSES = new Set(['PAID', 'PAYMENT_COMPLETED', 'COMPLETED', 'SETTLED']);

export function normalizeBill(raw, options = {}) {
  const money = toMoney(raw?.amount, raw?.invoice_currency || raw?.currency_code || 'USD');
  const currency = money.currency || 'USD';
  const po = resolvePoReference(raw);
  const paymentStatus = firstString(
    raw?.payment_status,
    raw?.payment?.status,
    raw?.status?.status,
    typeof raw?.status === 'string' ? raw.status : null
  );

  return {
    kind: 'bill',
    id: firstString(raw?.id) || '',
    number: firstString(raw?.invoice_number, raw?.number, raw?.bill_number) || null,
    vendorName: firstString(raw?.vendor?.remote_name, raw?.vendor?.name, raw?.vendor_name) || 'Unknown vendor',
    vendorId: firstString(raw?.vendor?.id, raw?.vendor_id) || null,
    entityName: firstString(raw?.entity?.name, raw?.entity_name) || null,
    clientName: resolveClientName(raw, options),
    poId: po.id,
    poNumber: po.number,
    issuedAt: isoOrNull(raw?.issued_at || raw?.invoice_date || raw?.created_at),
    dueAt: isoOrNull(raw?.due_at || raw?.due_date),
    paidAt: isoOrNull(raw?.payment?.effective_date || raw?.paid_at),
    memo: firstString(raw?.memo, raw?.notes) || null,
    paymentStatus: paymentStatus ? paymentStatus.toUpperCase() : null,
    isPaid: PAID_STATUSES.has((paymentStatus || '').toUpperCase()),
    amountCents: money.cents,
    currency,
    deepLink: firstString(raw?.deep_link_url) || null,
    lineItems: normalizeLineItems(raw, currency),
    documents: normalizeDocuments(raw, { parentType: 'bill', parentId: raw?.id }),
  };
}

export function normalizePurchaseOrder(raw, options = {}) {
  const money = toMoney(raw?.amount ?? raw?.total_amount, raw?.currency_code || raw?.currency || 'USD');
  const currency = money.currency || 'USD';

  return {
    kind: 'purchase_order',
    id: firstString(raw?.id) || '',
    number: firstString(raw?.number, raw?.po_number, raw?.purchase_order_number, raw?.id) || null,
    vendorName: firstString(raw?.vendor?.remote_name, raw?.vendor?.name, raw?.vendor_name) || 'Unknown vendor',
    vendorId: firstString(raw?.vendor?.id, raw?.vendor_id) || null,
    entityName: firstString(raw?.entity?.name, raw?.entity_name) || null,
    clientName: resolveClientName(raw, options),
    status: (firstString(raw?.status, raw?.state) || 'OPEN').toUpperCase(),
    issuedAt: isoOrNull(raw?.issued_at || raw?.created_at),
    memo: firstString(raw?.memo, raw?.notes, raw?.description) || null,
    amountCents: money.cents,
    currency,
    deepLink: firstString(raw?.deep_link_url) || null,
    lineItems: normalizeLineItems(raw, currency),
    documents: normalizeDocuments(raw, { parentType: 'purchase_order', parentId: raw?.id }),
  };
}

// ── Approval: approved by default, rejection is the only opt-out ─────────────

export const APPROVED = 'approved';
export const REJECTED = 'rejected';

/**
 * The dashboard's contract: a bill counts as approved the moment it lands,
 * and stays approved unless somebody explicitly rejects it. A stored decision
 * of `approved` means a human confirmed it — worth surfacing separately from
 * the automatic case, but identical for totals.
 *
 * @param {object} bill normalized bill
 * @param {Record<string, {status: string, by?: string, at?: string, reason?: string}>} decisions
 */
export function resolveApproval(bill, decisions = {}) {
  const decision = decisions?.[bill?.id];
  if (decision?.status === REJECTED) {
    return {
      state: REJECTED,
      auto: false,
      by: decision.by || null,
      at: decision.at || null,
      reason: decision.reason || null,
    };
  }
  if (decision?.status === APPROVED) {
    return { state: APPROVED, auto: false, by: decision.by || null, at: decision.at || null, reason: decision.reason || null };
  }
  return { state: APPROVED, auto: true, by: null, at: null, reason: null };
}

// ── Roll-ups ─────────────────────────────────────────────────────────────────

function emptyTotals() {
  return {
    approvedCents: 0,
    rejectedCents: 0,
    paidCents: 0,
    outstandingCents: 0,
    billCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    currencies: new Set(),
  };
}

function addBill(totals, bill) {
  totals.billCount += 1;
  totals.currencies.add(bill.currency);
  if (bill.approval.state === REJECTED) {
    totals.rejectedCents += bill.amountCents;
    totals.rejectedCount += 1;
    return totals;
  }
  totals.approvedCents += bill.amountCents;
  totals.approvedCount += 1;
  if (bill.isPaid) totals.paidCents += bill.amountCents;
  else totals.outstandingCents += bill.amountCents;
  return totals;
}

function sealTotals(totals) {
  const currencies = [...totals.currencies].filter(Boolean).sort();
  return {
    ...totals,
    currencies,
    currency: currencies[0] || 'USD',
    // Summing across currencies would be nonsense; the UI warns instead of
    // silently presenting a meaningless number.
    mixedCurrency: currencies.length > 1,
  };
}

/**
 * Assemble the dashboard model.
 *
 * @param {object} input
 * @param {object[]} input.bills          raw Ramp bills
 * @param {object[]} input.purchaseOrders raw Ramp purchase orders
 * @param {object}   input.decisions      billId -> { status, by, at, reason }
 * @param {object}   input.options        client-resolution options
 * @param {string|null} input.client      when set, scope everything to this client
 */
export function buildProcurementModel({
  bills = [],
  purchaseOrders = [],
  decisions = {},
  options = {},
  client = null,
} = {}) {
  const normalizedBills = bills.map((b) => {
    const bill = normalizeBill(b, options);
    bill.approval = resolveApproval(bill, decisions);
    bill.clientLabel = bill.clientName || UNASSIGNED_CLIENT;
    return bill;
  });

  const normalizedPOs = purchaseOrders.map((p) => {
    const po = normalizePurchaseOrder(p, options);
    po.clientLabel = po.clientName || UNASSIGNED_CLIENT;
    return po;
  });

  const scope = client ? String(client) : null;
  const inScope = (record) => !scope || record.clientLabel === scope;

  // A bill inherits its PO's client when it carries none of its own — the PO is
  // where the client assignment usually lives in a co-packing workflow.
  const poByNumber = new Map();
  const poById = new Map();
  normalizedPOs.forEach((po) => {
    if (po.number) poByNumber.set(po.number.toUpperCase(), po);
    if (po.id) poById.set(po.id, po);
  });

  normalizedBills.forEach((bill) => {
    if (bill.clientName) return;
    const po = (bill.poId && poById.get(bill.poId)) ||
      (bill.poNumber && poByNumber.get(bill.poNumber.toUpperCase()));
    if (po?.clientName) {
      bill.clientName = po.clientName;
      bill.clientLabel = po.clientName;
      bill.clientInherited = true;
    }
  });

  const scopedBills = normalizedBills.filter(inScope);
  const billsByPoKey = new Map();
  const unlinkedBills = [];

  scopedBills.forEach((bill) => {
    const key = (bill.poId && poById.has(bill.poId)) ? bill.poId
      : (bill.poNumber && poByNumber.has(bill.poNumber.toUpperCase())) ? poByNumber.get(bill.poNumber.toUpperCase()).id
        : null;
    if (!key) { unlinkedBills.push(bill); return; }
    if (!billsByPoKey.has(key)) billsByPoKey.set(key, []);
    billsByPoKey.get(key).push(bill);
  });

  const purchaseOrdersOut = normalizedPOs
    .filter((po) => inScope(po) || billsByPoKey.has(po.id))
    .map((po) => {
      const poBills = (billsByPoKey.get(po.id) || []).sort(
        (a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '')
      );
      const subtotal = sealTotals(poBills.reduce(addBill, emptyTotals()));
      return {
        ...po,
        bills: poBills,
        subtotal,
        // What is still un-billed against the PO's committed amount. Rejected
        // bills don't consume the PO, so they don't reduce the remainder.
        remainingCents: po.amountCents - subtotal.approvedCents,
        overBilled: subtotal.approvedCents > po.amountCents,
      };
    })
    .sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''));

  const totals = sealTotals(scopedBills.reduce(addBill, emptyTotals()));
  const poCommittedCents = purchaseOrdersOut
    .filter((po) => !scope || po.clientLabel === scope)
    .reduce((sum, po) => sum + po.amountCents, 0);

  const byClient = new Map();
  normalizedBills.forEach((bill) => {
    const key = bill.clientLabel;
    if (!byClient.has(key)) byClient.set(key, emptyTotals());
    addBill(byClient.get(key), bill);
  });

  return {
    purchaseOrders: purchaseOrdersOut,
    unlinkedBills: unlinkedBills.sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '')),
    bills: scopedBills,
    totals: {
      ...totals,
      poCount: purchaseOrdersOut.length,
      poCommittedCents,
      poRemainingCents: poCommittedCents - totals.approvedCents,
    },
    clients: [...byClient.entries()]
      .map(([name, t]) => ({ name, ...sealTotals(t) }))
      .sort((a, b) => b.approvedCents - a.approvedCents || a.name.localeCompare(b.name)),
  };
}

/** Case-insensitive substring match across the fields a user would search by. */
export function billMatchesQuery(bill, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [
    bill.number, bill.vendorName, bill.poNumber, bill.memo,
    bill.clientLabel, bill.entityName, bill.paymentStatus,
    ...(bill.documents || []).map((d) => d.name),
  ].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

export function poMatchesQuery(po, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const own = [po.number, po.vendorName, po.memo, po.clientLabel, po.entityName, po.status]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
  return own || (po.bills || []).some((b) => billMatchesQuery(b, q));
}

/** Rows for the CSV export — flat, one line per bill, subtotals excluded. */
export function toCsvRows(model) {
  const rows = [[
    'PO Number', 'PO Status', 'Client', 'Vendor', 'Bill Number', 'Invoice Date',
    'Due Date', 'Payment Status', 'Approval', 'Approved By', 'Amount', 'Currency', 'Attachments',
  ]];
  const push = (po, bill) => rows.push([
    po?.number || '', po?.status || '', bill.clientLabel, bill.vendorName,
    bill.number || bill.id, bill.issuedAt?.slice(0, 10) || '', bill.dueAt?.slice(0, 10) || '',
    bill.paymentStatus || '', bill.approval.state + (bill.approval.auto ? ' (auto)' : ''),
    bill.approval.by || '', (bill.amountCents / 100).toFixed(2), bill.currency,
    (bill.documents || []).map((d) => d.name).join('; '),
  ]);
  model.purchaseOrders.forEach((po) => po.bills.forEach((bill) => push(po, bill)));
  model.unlinkedBills.forEach((bill) => push(null, bill));
  return rows;
}
