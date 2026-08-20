// Two-tier auth for the procurement routes.
//
//   staff — read and write the day-to-day: comments, decisions, minting portal
//           links, setting a review deadline that does not exist yet.
//   admin — the operations the deadline lock exists to restrict: moving a
//           deadline that is already set, reopening a locked record, and
//           clearing a deadline outright.
//
// These are shared keys checked on the server, not per-user identity. That is
// the strongest control available in an application with no login; it means
// "an admin" is really "someone holding the admin key". Per-person attribution
// and revocation need a real auth layer — see docs/CLIENT_PORTAL.md.
//
// The leading underscore keeps Vercel from serving this file as a route.

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare, so a wrong key leaks nothing about how wrong.
 * Lengths are compared first and non-secretly — that much is unavoidable.
 */
function secretEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function presented(req) {
  return req.headers['x-api-key']
    || String(req.headers.authorization || '').replace('Bearer ', '')
    || '';
}

export function staffKeyConfigured() {
  return Boolean(process.env.PROCUREMENT_STAFF_KEY);
}

export function adminKeyConfigured() {
  return Boolean(process.env.PROCUREMENT_ADMIN_KEY);
}

/**
 * The two keys must differ. If they are the same value then every staff member
 * is an admin and the deadline lock restricts nobody, so we refuse the admin
 * tier outright rather than pretend it is enforced.
 */
export function keysCollide() {
  const staff = process.env.PROCUREMENT_STAFF_KEY;
  const admin = process.env.PROCUREMENT_ADMIN_KEY;
  return Boolean(staff && admin && staff === admin);
}

/**
 * Staff access. Following the convention in api/inventory.js, an unconfigured
 * key means the route is open — fine for an internal-only deployment, not fine
 * once portal links exist. The dashboard warns while it is unset.
 */
export function checkStaffAuth(req) {
  const key = process.env.PROCUREMENT_STAFF_KEY || '';
  if (!key) return true;
  return secretEquals(presented(req), key);
}

/**
 * Admin access, for editing or reopening a deadline.
 *
 * Unlike the staff check this FAILS CLOSED: an unconfigured admin key means
 * nobody is an admin, so a deadline can be set once and then never moved. That
 * is the safe direction for a control whose whole purpose is to stop a lock
 * being casually undone, and it is reported to the UI so an operator is told
 * why the buttons are refusing rather than left guessing.
 */
export function checkAdminAuth(req) {
  const key = process.env.PROCUREMENT_ADMIN_KEY || '';
  if (!key) return { ok: false, reason: 'admin_key_unset' };
  if (keysCollide()) return { ok: false, reason: 'keys_collide' };
  const supplied = req.headers['x-admin-key'] || presented(req);
  if (!secretEquals(supplied, key)) return { ok: false, reason: 'bad_admin_key' };
  return { ok: true };
}

export const ADMIN_REFUSALS = {
  admin_key_unset:
    'No admin key is configured on this deployment, so nobody can edit or reopen a review deadline. '
    + 'Set PROCUREMENT_ADMIN_KEY to enable it.',
  keys_collide:
    'PROCUREMENT_ADMIN_KEY is set to the same value as PROCUREMENT_STAFF_KEY, which would make every '
    + 'staff member an admin. Give the admin key a different value.',
  bad_admin_key: 'That admin key was not accepted.',
};

/** Describe the auth posture to the dashboard, without revealing any key. */
export function authStatus() {
  return {
    staffKeyConfigured: staffKeyConfigured(),
    adminKeyConfigured: adminKeyConfigured(),
    keysCollide: keysCollide(),
  };
}
