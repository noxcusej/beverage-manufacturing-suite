// Demo procurement dataset.
//
// Shaped exactly like raw Ramp API payloads so the normalizer in
// procurement.js is exercised the same way it is against live data — the only
// difference between demo mode and live mode is where the array came from.
//
// Used when RAMP_CLIENT_ID / RAMP_CLIENT_SECRET are not configured, or when
// /api/ramp is unreachable (e.g. `npm run dev` without `vercel dev`).

const usd = (dollars) => ({ amount: Math.round(dollars * 100), currency_code: 'USD' });
const clientField = (name) => ({ field_name: 'Client', option_name: name });
const glField = (name) => ({ field_name: 'GL Account', option_name: name });

export const demoPurchaseOrders = [
  {
    id: 'po_demo_1001',
    number: 'PO-1001',
    vendor: { id: 'ven_ball', name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'OPEN',
    issued_at: '2026-05-04T16:20:00Z',
    amount: usd(48750),
    memo: '12 oz sleek cans — Q3 build, 3 releases',
    accounting_field_selections: [clientField('Cascade Cold Brew')],
    line_items: [
      { id: 'poli_1', memo: '12 oz sleek can, brite', quantity: 375000, unit_price: usd(0.11), amount: usd(41250) },
      { id: 'poli_2', memo: 'Can end, 202 LOE', quantity: 375000, unit_price: usd(0.02), amount: usd(7500) },
    ],
    documents: [
      { id: 'doc_po1001_a', filename: 'PO-1001-signed.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-05-04T16:22:00Z' },
    ],
  },
  {
    id: 'po_demo_1002',
    number: 'PO-1002',
    vendor: { id: 'ven_pacific', name: 'Pacific Label & Print' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'OPEN',
    issued_at: '2026-05-11T15:00:00Z',
    amount: usd(16400),
    memo: 'Pressure-sensitive labels, 4 SKUs',
    accounting_field_selections: [clientField('Cascade Cold Brew')],
    line_items: [
      { id: 'poli_3', memo: 'PS label, 4 SKU changeover', quantity: 320000, unit_price: usd(0.05), amount: usd(16000) },
      { id: 'poli_4', memo: 'Plate & die setup', quantity: 4, unit_price: usd(100), amount: usd(400) },
    ],
    documents: [],
  },
  {
    id: 'po_demo_1003',
    number: 'PO-1003',
    vendor: { id: 'ven_ninemile', name: 'Nine Mile Ingredients' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'OPEN',
    issued_at: '2026-05-19T13:45:00Z',
    amount: usd(22800),
    memo: 'Green coffee concentrate + cane sugar',
    accounting_field_selections: [clientField('Cascade Cold Brew')],
    line_items: [
      { id: 'poli_5', memo: 'Cold brew concentrate, 55 gal drum', quantity: 24, unit_price: usd(825), amount: usd(19800) },
      { id: 'poli_6', memo: 'Cane sugar, 50 lb bag', quantity: 400, unit_price: usd(7.5), amount: usd(3000) },
    ],
    documents: [
      { id: 'doc_po1003_a', filename: 'nine-mile-quote-Q3.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-05-19T13:50:00Z' },
    ],
  },
  {
    id: 'po_demo_2001',
    number: 'PO-2001',
    vendor: { id: 'ven_pacific', name: 'Pacific Label & Print' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'OPEN',
    issued_at: '2026-06-02T17:10:00Z',
    amount: usd(9600),
    memo: 'Shrink sleeves, 2 SKUs',
    accounting_field_selections: [clientField('Harbor Kombucha')],
    line_items: [
      { id: 'poli_7', memo: 'Shrink sleeve, 16 oz', quantity: 160000, unit_price: usd(0.06), amount: usd(9600) },
    ],
    documents: [],
  },
  {
    id: 'po_demo_2002',
    number: 'PO-2002',
    vendor: { id: 'ven_pallet', name: 'Mountain Pallet & Crating' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'CLOSED',
    issued_at: '2026-04-14T14:00:00Z',
    amount: usd(4200),
    memo: 'Heat-treated pallets, Q2',
    accounting_field_selections: [clientField('Harbor Kombucha')],
    line_items: [
      { id: 'poli_8', memo: 'GMA pallet, HT', quantity: 300, unit_price: usd(14), amount: usd(4200) },
    ],
    documents: [],
  },
  {
    id: 'po_demo_3001',
    number: 'PO-3001',
    vendor: { id: 'ven_ball', name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    status: 'OPEN',
    issued_at: '2026-06-16T16:00:00Z',
    amount: usd(31200),
    memo: '16 oz cans — summer seltzer run',
    accounting_field_selections: [clientField('Solstice Seltzer')],
    line_items: [
      { id: 'poli_9', memo: '16 oz can, brite', quantity: 240000, unit_price: usd(0.13), amount: usd(31200) },
    ],
    documents: [
      { id: 'doc_po3001_a', filename: 'PO-3001-summer-build.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-06-16T16:05:00Z' },
    ],
  },
];

export const demoBills = [
  // ── Cascade Cold Brew ──
  {
    id: 'bill_demo_01',
    invoice_number: 'BALL-884213',
    purchase_order_id: 'po_demo_1001',
    vendor: { id: 'ven_ball', remote_name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(20625),
    invoice_currency: 'USD',
    issued_at: '2026-05-28T00:00:00Z',
    due_at: '2026-06-27T00:00:00Z',
    payment_status: 'PAID',
    payment: { status: 'PAID', effective_date: '2026-06-20T00:00:00Z', method: 'ACH' },
    memo: 'Release 1 of 3 — 187,500 sleeves',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_1', memo: '12 oz sleek can, brite', quantity: 187500, unit_price: usd(0.11), amount: usd(20625) },
    ],
    documents: [
      { id: 'doc_b01_inv', filename: 'BALL-884213-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-05-28T09:12:00Z' },
      { id: 'doc_b01_bol', filename: 'BOL-884213.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-05-29T11:40:00Z' },
    ],
  },
  {
    id: 'bill_demo_02',
    invoice_number: 'BALL-889907',
    purchase_order_id: 'po_demo_1001',
    vendor: { id: 'ven_ball', remote_name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(20625),
    invoice_currency: 'USD',
    issued_at: '2026-06-24T00:00:00Z',
    due_at: '2026-07-24T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Release 2 of 3 — 187,500 sleeves',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_2', memo: '12 oz sleek can, brite', quantity: 187500, unit_price: usd(0.11), amount: usd(20625) },
    ],
    documents: [
      { id: 'doc_b02_inv', filename: 'BALL-889907-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-24T08:30:00Z' },
    ],
  },
  {
    id: 'bill_demo_03',
    invoice_number: 'BALL-889907-R',
    purchase_order_id: 'po_demo_1001',
    vendor: { id: 'ven_ball', remote_name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(20625),
    invoice_currency: 'USD',
    issued_at: '2026-06-26T00:00:00Z',
    due_at: '2026-07-26T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Duplicate of BALL-889907 — vendor re-sent',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_3', memo: '12 oz sleek can, brite', quantity: 187500, unit_price: usd(0.11), amount: usd(20625) },
    ],
    documents: [
      { id: 'doc_b03_inv', filename: 'BALL-889907-invoice-copy.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-26T10:02:00Z' },
    ],
  },
  {
    id: 'bill_demo_04',
    invoice_number: 'PLP-30114',
    purchase_order_id: 'po_demo_1002',
    vendor: { id: 'ven_pacific', remote_name: 'Pacific Label & Print' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(8400),
    invoice_currency: 'USD',
    issued_at: '2026-06-01T00:00:00Z',
    due_at: '2026-07-01T00:00:00Z',
    payment_status: 'PAID',
    payment: { status: 'PAID', effective_date: '2026-06-28T00:00:00Z', method: 'ACH' },
    memo: 'Labels — SKUs 1 & 2, plates included',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_4', memo: 'PS label, SKU 1', quantity: 80000, unit_price: usd(0.05), amount: usd(4000) },
      { id: 'bli_5', memo: 'PS label, SKU 2', quantity: 80000, unit_price: usd(0.05), amount: usd(4000) },
      { id: 'bli_6', memo: 'Plate & die setup', quantity: 4, unit_price: usd(100), amount: usd(400) },
    ],
    documents: [
      { id: 'doc_b04_inv', filename: 'PLP-30114-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-01T14:20:00Z' },
      { id: 'doc_b04_proof', filename: 'label-proof-sku1-sku2.png', attachment_type: 'FILE', content_type: 'image/png', created_at: '2026-05-26T18:05:00Z' },
    ],
  },
  {
    id: 'bill_demo_05',
    invoice_number: 'NMI-7742',
    purchase_order_id: 'po_demo_1003',
    vendor: { id: 'ven_ninemile', remote_name: 'Nine Mile Ingredients' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(11400),
    invoice_currency: 'USD',
    issued_at: '2026-06-09T00:00:00Z',
    due_at: '2026-07-09T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Half release — 12 drums concentrate',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5000 Ingredients')],
    line_items: [
      { id: 'bli_7', memo: 'Cold brew concentrate, 55 gal drum', quantity: 12, unit_price: usd(825), amount: usd(9900) },
      { id: 'bli_8', memo: 'Cane sugar, 50 lb bag', quantity: 200, unit_price: usd(7.5), amount: usd(1500) },
    ],
    documents: [
      { id: 'doc_b05_inv', filename: 'NMI-7742-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-09T09:00:00Z' },
      { id: 'doc_b05_coa', filename: 'COA-lot-CB2261.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-06-08T16:30:00Z' },
    ],
  },
  // No PO of its own — linked only by the memo text.
  {
    id: 'bill_demo_06',
    invoice_number: 'CF-55120',
    vendor: { id: 'ven_freight', remote_name: 'Cascade Freight Lines' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(2380),
    invoice_currency: 'USD',
    issued_at: '2026-06-12T00:00:00Z',
    due_at: '2026-07-12T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Inbound freight against PO 1003',
    accounting_field_selections: [clientField('Cascade Cold Brew'), glField('5300 Freight')],
    line_items: [
      { id: 'bli_9', memo: 'LTL, Spokane → Portland', quantity: 2, unit_price: usd(1190), amount: usd(2380) },
    ],
    documents: [
      { id: 'doc_b06_inv', filename: 'CF-55120-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-12T12:00:00Z' },
    ],
  },
  // ── Harbor Kombucha ──
  {
    id: 'bill_demo_07',
    invoice_number: 'PLP-30240',
    purchase_order_id: 'po_demo_2001',
    vendor: { id: 'ven_pacific', remote_name: 'Pacific Label & Print' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(4800),
    invoice_currency: 'USD',
    issued_at: '2026-06-18T00:00:00Z',
    due_at: '2026-07-18T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Shrink sleeves — SKU 1 of 2',
    accounting_field_selections: [clientField('Harbor Kombucha'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_10', memo: 'Shrink sleeve, 16 oz', quantity: 80000, unit_price: usd(0.06), amount: usd(4800) },
    ],
    documents: [
      { id: 'doc_b07_inv', filename: 'PLP-30240-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-06-18T10:15:00Z' },
    ],
  },
  {
    id: 'bill_demo_08',
    invoice_number: 'MPC-4471',
    purchase_order_id: 'po_demo_2002',
    vendor: { id: 'ven_pallet', remote_name: 'Mountain Pallet & Crating' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(4200),
    invoice_currency: 'USD',
    issued_at: '2026-05-02T00:00:00Z',
    due_at: '2026-06-01T00:00:00Z',
    payment_status: 'PAID',
    payment: { status: 'PAID', effective_date: '2026-05-30T00:00:00Z', method: 'ACH' },
    memo: 'Q2 pallets, delivered complete',
    accounting_field_selections: [clientField('Harbor Kombucha'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_11', memo: 'GMA pallet, HT', quantity: 300, unit_price: usd(14), amount: usd(4200) },
    ],
    documents: [
      { id: 'doc_b08_inv', filename: 'MPC-4471-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-05-02T15:45:00Z' },
    ],
  },
  // ── Solstice Seltzer ──
  {
    id: 'bill_demo_09',
    invoice_number: 'BALL-901556',
    purchase_order_id: 'po_demo_3001',
    vendor: { id: 'ven_ball', remote_name: 'Ball Corporation' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(15600),
    invoice_currency: 'USD',
    issued_at: '2026-07-06T00:00:00Z',
    due_at: '2026-08-05T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Half build — 120,000 cans',
    accounting_field_selections: [clientField('Solstice Seltzer'), glField('5100 Packaging')],
    line_items: [
      { id: 'bli_12', memo: '16 oz can, brite', quantity: 120000, unit_price: usd(0.13), amount: usd(15600) },
    ],
    documents: [
      { id: 'doc_b09_inv', filename: 'BALL-901556-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-07-06T08:45:00Z' },
      { id: 'doc_b09_bol', filename: 'BOL-901556.pdf', attachment_type: 'FILE', content_type: 'application/pdf', created_at: '2026-07-07T13:20:00Z' },
    ],
  },
  // Carries no client dimension at all — shows up as Unassigned so it can be
  // triaged rather than quietly disappearing from every client's totals.
  {
    id: 'bill_demo_10',
    invoice_number: 'GRN-2210',
    vendor: { id: 'ven_grainger', remote_name: 'Grainger' },
    entity: { id: 'ent_1', name: 'Drayhorse Beverage Co' },
    amount: usd(864.32),
    invoice_currency: 'USD',
    issued_at: '2026-07-02T00:00:00Z',
    due_at: '2026-08-01T00:00:00Z',
    payment_status: 'OPEN',
    memo: 'Filler spare parts — plant general',
    accounting_field_selections: [glField('6200 Maintenance')],
    line_items: [
      { id: 'bli_13', memo: 'Seal kit, rotary filler', quantity: 2, unit_price: usd(432.16), amount: usd(864.32) },
    ],
    documents: [
      { id: 'doc_b10_inv', filename: 'GRN-2210-invoice.pdf', attachment_type: 'INVOICE', content_type: 'application/pdf', created_at: '2026-07-02T11:11:00Z' },
    ],
  },
];

/**
 * One demo rejection so the "approved unless rejected" rule is visible on a
 * fresh install: the duplicate Ball invoice. Merged under any decisions the
 * user has already recorded, never over them.
 */
export const demoDecisions = {
  bill_demo_03: {
    status: 'rejected',
    by: 'ap@drayhorse.com',
    at: '2026-06-27T17:04:00Z',
    reason: 'Duplicate of BALL-889907 — vendor re-sent the same invoice.',
  },
};
