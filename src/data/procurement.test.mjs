// Run with: node src/data/procurement.test.mjs
//
// No test runner is installed in the repo; this file is a self-contained smoke
// check for the pure procurement helpers. Exits non-zero on failure so it
// composes with CI later.

import {
  toMoney,
  formatMoney,
  resolveClientName,
  resolvePoReference,
  normalizeBill,
  normalizeDocuments,
  resolveApproval,
  buildProcurementModel,
  billMatchesQuery,
  toCsvRows,
  UNASSIGNED_CLIENT,
} from './procurement.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n   → ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  assert(label, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Money ───────────────────────────────────────────────────────────────────
eq('CurrencyAmount object reads as minor units', toMoney({ amount: 12345, currency_code: 'USD' }).cents, 12345);
eq('bare number reads as dollars', toMoney(123.45).cents, 12345);
eq('numeric string reads as dollars', toMoney('99.99').cents, 9999);
eq('null is zero', toMoney(null).cents, 0);
eq('garbage is zero', toMoney({ amount: 'abc' }).cents, 0);
eq('currency falls through', toMoney({ amount: 100 }, 'CAD').currency, 'CAD');
eq('formats USD', formatMoney(12345, 'USD'), '$123.45');
eq('unknown currency does not throw', typeof formatMoney(12345, 'ZZZ'), 'string');

// Rounding: half-cent inputs must not leak fractional cents into subtotals.
eq('rounds to whole cents', toMoney(0.005).cents, 1);

// ── Client resolution ───────────────────────────────────────────────────────
eq('top-level accounting field wins',
  resolveClientName({
    accounting_field_selections: [
      { category_info: { name: 'GL Account' }, option_name: '5000 COGS' },
      { category_info: { name: 'Client' }, option_name: 'Cascade Cold Brew' },
    ],
  }),
  'Cascade Cold Brew');

eq('line-item majority wins when no top-level field',
  resolveClientName({
    line_items: [
      { accounting_field_selections: [{ field_name: 'Client', option_name: 'Alpine Tonic' }] },
      { accounting_field_selections: [{ field_name: 'Client', option_name: 'Harbor Kombucha' }] },
      { accounting_field_selections: [{ field_name: 'Client', option_name: 'Harbor Kombucha' }] },
    ],
  }),
  'Harbor Kombucha');

eq('memo tag is the last text fallback',
  resolveClientName({ memo: 'Cans for run 42 [Client: Solstice Seltzer]' }),
  'Solstice Seltzer');

eq('bare "Client: X" memo also parses',
  resolveClientName({ memo: 'Client: Nine Mile Cider, run 7' }),
  'Nine Mile Cider');

eq('entity only used when opted in',
  resolveClientName({ entity: { name: 'Drayhorse LLC' } }),
  null);
eq('entity used when opted in',
  resolveClientName({ entity: { name: 'Drayhorse LLC' } }, { useEntityAsClient: true }),
  'Drayhorse LLC');

eq('override beats everything',
  resolveClientName({ id: 'bill_1', memo: 'Client: Wrong' }, { overrides: { bill_1: 'Right Co' } }),
  'Right Co');

eq('custom field name is honored',
  resolveClientName(
    { accounting_field_selections: [{ field_name: 'Brand Owner', option_name: 'Tidewater' }] },
    { clientFieldNames: ['brand owner'] }
  ),
  'Tidewater');

eq('unrelated fields are ignored',
  resolveClientName({ accounting_field_selections: [{ field_name: 'Department', option_name: 'Ops' }] }),
  null);

// ── PO reference ────────────────────────────────────────────────────────────
eq('structured PO id', resolvePoReference({ purchase_order_id: 'po_9' }).id, 'po_9');
eq('PO number from memo', resolvePoReference({ memo: 'against PO 1042 for cans' }).number, 'PO-1042');
eq('no PO reference', resolvePoReference({ memo: 'misc supplies' }), { id: null, number: null });

// ── Documents ───────────────────────────────────────────────────────────────
const docs = normalizeDocuments(
  {
    documents: [{ id: 'doc_1', filename: 'invoice.pdf', attachment_type: 'INVOICE' }],
    attachments: [{ id: 'doc_1', filename: 'dupe.pdf' }, { id: 'doc_2', name: 'packing-slip.png' }],
  },
  { parentType: 'bill', parentId: 'bill_1' }
);
eq('documents dedupe by id', docs.map((d) => d.id), ['doc_1', 'doc_2']);
assert('download goes through our proxy, not a presigned URL',
  docs[0].downloadPath.startsWith('/api/ramp?resource=document') &&
  docs[0].downloadPath.includes('parent_id=bill_1'),
  docs[0].downloadPath);

// ── Approval defaults ───────────────────────────────────────────────────────
const plainBill = normalizeBill({ id: 'bill_1', amount: { amount: 5000, currency_code: 'USD' } });
eq('an untouched bill is approved automatically', resolveApproval(plainBill, {}).state, 'approved');
assert('and is flagged as automatic', resolveApproval(plainBill, {}).auto === true);
eq('an explicit rejection sticks',
  resolveApproval(plainBill, { bill_1: { status: 'rejected', by: 'ops@x.com', reason: 'wrong qty' } }).state,
  'rejected');
assert('an explicit approval is not automatic',
  resolveApproval(plainBill, { bill_1: { status: 'approved', by: 'ops@x.com' } }).auto === false);
eq('an unrecognized decision falls back to approved',
  resolveApproval(plainBill, { bill_1: { status: 'sideways' } }).state, 'approved');

// ── Model + totals ──────────────────────────────────────────────────────────
const rawPOs = [
  {
    id: 'po_1', number: 'PO-1001', vendor: { name: 'Ball Corporation' },
    amount: { amount: 500000, currency_code: 'USD' }, status: 'OPEN', issued_at: '2026-06-01',
    accounting_field_selections: [{ field_name: 'Client', option_name: 'Cascade Cold Brew' }],
  },
  {
    id: 'po_2', number: 'PO-1002', vendor: { name: 'Pacific Labels' },
    amount: { amount: 120000, currency_code: 'USD' }, status: 'OPEN', issued_at: '2026-06-05',
    accounting_field_selections: [{ field_name: 'Client', option_name: 'Harbor Kombucha' }],
  },
];
const rawBills = [
  // Two bills on PO-1001; one rejected.
  { id: 'b1', invoice_number: 'INV-1', purchase_order_id: 'po_1', vendor: { name: 'Ball Corporation' },
    amount: { amount: 300000, currency_code: 'USD' }, issued_at: '2026-06-10', payment_status: 'PAID' },
  { id: 'b2', invoice_number: 'INV-2', purchase_order_id: 'po_1', vendor: { name: 'Ball Corporation' },
    amount: { amount: 150000, currency_code: 'USD' }, issued_at: '2026-06-20', payment_status: 'OPEN' },
  // Linked by memo text only.
  { id: 'b3', invoice_number: 'INV-3', memo: 'PO 1002 label run', vendor: { name: 'Pacific Labels' },
    amount: { amount: 60000, currency_code: 'USD' }, issued_at: '2026-06-22', payment_status: 'OPEN' },
  // No PO at all.
  { id: 'b4', invoice_number: 'INV-4', vendor: { name: 'Freight Co' },
    amount: { amount: 25000, currency_code: 'USD' }, issued_at: '2026-06-25', payment_status: 'OPEN',
    accounting_field_selections: [{ field_name: 'Client', option_name: 'Cascade Cold Brew' }] },
];
const decisions = { b2: { status: 'rejected', by: 'ap@drayhorse.com', at: '2026-06-21', reason: 'duplicate' } };

const model = buildProcurementModel({ bills: rawBills, purchaseOrders: rawPOs, decisions });

eq('two POs in the model', model.purchaseOrders.length, 2);
const po1 = model.purchaseOrders.find((p) => p.number === 'PO-1001');
const po2 = model.purchaseOrders.find((p) => p.number === 'PO-1002');
eq('PO-1001 has both its bills', po1.bills.map((b) => b.id).sort(), ['b1', 'b2']);
eq('memo-linked bill lands on PO-1002', po2.bills.map((b) => b.id), ['b3']);
eq('billless PO is not invented', model.unlinkedBills.map((b) => b.id), ['b4']);

eq('rejected bill is excluded from the PO subtotal', po1.subtotal.approvedCents, 300000);
eq('rejected amount is tracked separately', po1.subtotal.rejectedCents, 150000);
eq('remaining is against approved only', po1.remainingCents, 200000);
assert('PO-1001 is not over-billed', po1.overBilled === false);

eq('paid vs outstanding split', [po1.subtotal.paidCents, po1.subtotal.outstandingCents], [300000, 0]);

eq('grand approved total', model.totals.approvedCents, 300000 + 60000 + 25000);
eq('grand rejected total', model.totals.rejectedCents, 150000);
eq('committed PO total', model.totals.poCommittedCents, 620000);
eq('PO remaining rolls up', model.totals.poRemainingCents, 620000 - 385000);

eq('bill inherits the client from its PO', po1.bills.find((b) => b.id === 'b1').clientLabel, 'Cascade Cold Brew');
assert('and is marked as inherited',
  po1.bills.find((b) => b.id === 'b1').clientInherited === true);

// Client scoping: a client sees only their own bills and their own subtotals.
const cascade = buildProcurementModel({
  bills: rawBills, purchaseOrders: rawPOs, decisions, client: 'Cascade Cold Brew',
});
eq('scoped to one PO', cascade.purchaseOrders.map((p) => p.number), ['PO-1001']);
eq('scoped bills exclude other clients', cascade.bills.map((b) => b.id).sort(), ['b1', 'b2', 'b4']);
eq('scoped approved total', cascade.totals.approvedCents, 325000);
eq('scoped committed total', cascade.totals.poCommittedCents, 500000);

const harbor = buildProcurementModel({ bills: rawBills, purchaseOrders: rawPOs, client: 'Harbor Kombucha' });
eq('other client sees only their own', harbor.bills.map((b) => b.id), ['b3']);
eq('and none of the first client money', harbor.totals.approvedCents, 60000);

// Per-client breakdown covers everyone, scoped or not.
eq('client breakdown names',
  model.clients.map((c) => c.name).sort(),
  ['Cascade Cold Brew', 'Harbor Kombucha']);

// An unassignable bill is surfaced, never silently dropped.
const orphan = buildProcurementModel({ bills: [{ id: 'b9', amount: { amount: 100, currency_code: 'USD' } }] });
eq('unassigned bills get a label', orphan.bills[0].clientLabel, UNASSIGNED_CLIENT);
eq('and still count in totals', orphan.totals.approvedCents, 100);

// Mixed currency must be flagged rather than summed into a meaningless figure.
const mixed = buildProcurementModel({
  bills: [
    { id: 'm1', amount: { amount: 1000, currency_code: 'USD' } },
    { id: 'm2', amount: { amount: 1000, currency_code: 'CAD' } },
  ],
});
assert('mixed currency is flagged', mixed.totals.mixedCurrency === true);
eq('and both currencies are listed', mixed.totals.currencies, ['CAD', 'USD']);

// ── Search + export ─────────────────────────────────────────────────────────
assert('search matches vendor', billMatchesQuery(po1.bills[0], 'ball'));
assert('search matches PO number', billMatchesQuery(po2.bills[0], 'po-1002'));
assert('empty search matches everything', billMatchesQuery(po1.bills[0], '   '));
assert('search misses non-matches', !billMatchesQuery(po1.bills[0], 'zzzz'));

const csv = toCsvRows(model);
eq('csv has a header plus every bill', csv.length, 1 + 4);
assert('csv marks the automatic approval', csv.some((r) => r.includes('approved (auto)')));
assert('csv marks the rejection', csv.some((r) => r[8] === 'rejected'));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
