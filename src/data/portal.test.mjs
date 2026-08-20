// Run with: node src/data/portal.test.mjs
//
// Covers the client-portal invariants: one client's data never reaches
// another's portal, internal notes never reach any client, and share tokens
// are compared safely.

import { scopeToClient, clientOf, DEFAULT_CLIENT_FIELDS, matchPoInText } from '../../api/_ramp.js';
import { hashToken, mintToken, tokensMatch } from '../../api/_portalStore.js';
import { commentKey, groupComments, visibleToClient } from './commentModel.js';
import { demoBills, demoPurchaseOrders } from './procurementDemo.js';

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

// ── Tokens ──────────────────────────────────────────────────────────────────
const token = mintToken();
assert('a minted token is long enough to be unguessable', token.length >= 40, `${token.length} chars`);
assert('two mints differ', mintToken() !== mintToken());
eq('hashing is stable', hashToken('abc'), hashToken('abc'));
assert('hashing is one-way in shape (hex, 64 chars)', /^[0-9a-f]{64}$/.test(hashToken(token)));
assert('the hash is not the token', hashToken(token) !== token);
assert('matching hashes compare equal', tokensMatch(hashToken('x'), hashToken('x')));
assert('different hashes do not', !tokensMatch(hashToken('x'), hashToken('y')));
assert('a malformed hash does not throw or pass', tokensMatch('nothex', hashToken('x')) === false);
assert('an empty hash never matches', tokensMatch('', '') === false);

// ── Client isolation — the core portal guarantee ────────────────────────────
const fields = DEFAULT_CLIENT_FIELDS;

const harbor = scopeToClient(demoBills, demoPurchaseOrders, 'Harbor Kombucha', fields);
const cascade = scopeToClient(demoBills, demoPurchaseOrders, 'Cascade Cold Brew', fields);
const solstice = scopeToClient(demoBills, demoPurchaseOrders, 'Solstice Seltzer', fields);

eq('Harbor sees only its own bills', harbor.bills.map((b) => b.id).sort(), ['bill_demo_07', 'bill_demo_08']);
eq('Harbor sees only its own POs', harbor.purchaseOrders.map((p) => p.number).sort(), ['PO-2001', 'PO-2002']);
eq('Cascade sees its own six', cascade.bills.length, 6);
eq('Solstice sees its own one', solstice.bills.map((b) => b.id), ['bill_demo_09']);

// No overlap between any two clients' scoped sets.
const ids = (r) => new Set(r.bills.map((b) => b.id));
const overlap = (a, b) => [...ids(a)].filter((id) => ids(b).has(id));
eq('Harbor and Cascade share no bill', overlap(harbor, cascade), []);
eq('Harbor and Solstice share no bill', overlap(harbor, solstice), []);
eq('Cascade and Solstice share no bill', overlap(cascade, solstice), []);

// The untagged plant-general bill belongs to nobody's portal.
const allScoped = new Set([...ids(harbor), ...ids(cascade), ...ids(solstice)]);
assert('an untagged bill reaches no client portal', !allScoped.has('bill_demo_10'));

// A bill with no client field of its own still reaches the right client
// through its PO — and only that client.
assert('memo-linked freight lands on Cascade', ids(cascade).has('bill_demo_06'));
assert('and nowhere else', !ids(harbor).has('bill_demo_06') && !ids(solstice).has('bill_demo_06'));

// Scoping is exact, not fuzzy: a near-miss name gets nothing.
eq('a partial client name matches nothing',
  scopeToClient(demoBills, demoPurchaseOrders, 'Harbor', fields).bills.length, 0);
eq('an unknown client gets an empty portal',
  scopeToClient(demoBills, demoPurchaseOrders, 'Not A Client', fields).bills.length, 0);
// Case differences are tolerated — the value comes from a Ramp field, not a user.
eq('case-insensitive on the client name',
  scopeToClient(demoBills, demoPurchaseOrders, 'harbor kombucha', fields).bills.length, 2);

// ── clientOf ────────────────────────────────────────────────────────────────
eq('reads a top-level field',
  clientOf({ accounting_field_selections: [{ field_name: 'Client', option_name: 'Acme' }] }, fields), 'Acme');
eq('reads a line-item field',
  clientOf({ line_items: [{ accounting_field_selections: [{ field_name: 'Client', option_name: 'Acme' }] }] }, fields), 'Acme');
eq('reads a memo tag', clientOf({ memo: '[Client: Acme]' }, fields), 'Acme');
eq('ignores unrelated fields',
  clientOf({ accounting_field_selections: [{ field_name: 'Department', option_name: 'Ops' }] }, fields), null);
eq('server and client agree on PO-in-memo parsing',
  matchPoInText({ memo: 'Inbound freight against PO 1003' }), 'PO-1003');

// ── Comment visibility ──────────────────────────────────────────────────────
const comments = [
  { id: 'c1', targetType: 'bill', targetId: 'b1', clientName: 'Acme', visibility: 'shared', createdAt: '2026-01-02' },
  { id: 'c2', targetType: 'bill', targetId: 'b1', clientName: 'Acme', visibility: 'internal', createdAt: '2026-01-01' },
  { id: 'c3', targetType: 'bill', targetId: 'b9', clientName: 'Other', visibility: 'shared', createdAt: '2026-01-03' },
  { id: 'c4', targetType: 'purchase_order', targetId: 'p1', clientName: 'Acme', visibility: 'shared', createdAt: '2026-01-04' },
];

eq('internal notes never reach a client',
  visibleToClient(comments, 'Acme').map((c) => c.id), ['c1', 'c4']);
eq('another client’s thread never reaches this one',
  visibleToClient(comments, 'Acme').every((c) => c.clientName === 'Acme'), true);
eq('with no client set, only the internal filter applies',
  visibleToClient(comments).map((c) => c.id), ['c1', 'c3', 'c4']);

const grouped = groupComments(comments);
eq('grouped by target', [...grouped.keys()].sort(), ['bill:b1', 'bill:b9', 'purchase_order:p1']);
eq('oldest first within a thread', grouped.get('bill:b1').map((c) => c.id), ['c2', 'c1']);
eq('key is stable', commentKey('bill', 'b1'), 'bill:b1');
eq('an empty list groups to nothing', groupComments([]).size, 0);
eq('null groups to nothing', groupComments(null).size, 0);

// ── Admin tier: the gate behind "only an admin can edit or reopen" ──────────
const { checkAdminAuth, checkStaffAuth, keysCollide, authStatus } =
  await import('../../api/_staffAuth.js');

const req = (headers = {}) => ({ headers });

// Fails closed: with no admin key configured, nobody is an admin, so a
// deadline once set can never be moved. That is the safe direction.
delete process.env.PROCUREMENT_ADMIN_KEY;
delete process.env.PROCUREMENT_STAFF_KEY;
eq('no admin key means nobody is an admin', checkAdminAuth(req()).ok, false);
eq('and it says why', checkAdminAuth(req()).reason, 'admin_key_unset');
eq('an admin key presented against no configured key is still refused',
  checkAdminAuth(req({ 'x-admin-key': 'anything' })).ok, false);

// Staff, by contrast, is open when unconfigured — the existing convention.
assert('staff access is open when unconfigured', checkStaffAuth(req()) === true);

process.env.PROCUREMENT_STAFF_KEY = 'staff-secret';
assert('a configured staff key is then required', checkStaffAuth(req()) === false);
assert('and accepts the right one', checkStaffAuth(req({ 'x-api-key': 'staff-secret' })) === true);
assert('and rejects a near miss', checkStaffAuth(req({ 'x-api-key': 'staff-secrat' })) === false);
assert('and rejects a prefix', checkStaffAuth(req({ 'x-api-key': 'staff-secre' })) === false);
assert('and accepts it as a bearer token',
  checkStaffAuth(req({ authorization: 'Bearer staff-secret' })) === true);

process.env.PROCUREMENT_ADMIN_KEY = 'admin-secret';
eq('the right admin key is accepted', checkAdminAuth(req({ 'x-admin-key': 'admin-secret' })).ok, true);
eq('a wrong admin key is refused', checkAdminAuth(req({ 'x-admin-key': 'nope' })).reason, 'bad_admin_key');
eq('the staff key is NOT an admin key',
  checkAdminAuth(req({ 'x-admin-key': 'staff-secret' })).reason, 'bad_admin_key');
eq('an empty admin key is refused', checkAdminAuth(req({ 'x-admin-key': '' })).reason, 'bad_admin_key');

// If the two keys are the same, every staff member is an admin and the lock
// restricts nobody — refuse the admin tier rather than pretend it is enforced.
process.env.PROCUREMENT_ADMIN_KEY = 'staff-secret';
assert('identical keys are detected', keysCollide() === true);
eq('and the admin tier refuses outright',
  checkAdminAuth(req({ 'x-admin-key': 'staff-secret' })).reason, 'keys_collide');
eq('the collision is reported to the UI', authStatus().keysCollide, true);

process.env.PROCUREMENT_ADMIN_KEY = 'admin-secret';
eq('distinct keys clear the collision', keysCollide(), false);
eq('status never leaks a key value',
  Object.values(authStatus()).every((v) => typeof v === 'boolean'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
