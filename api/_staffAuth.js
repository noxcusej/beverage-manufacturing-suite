// Shared staff-side auth for the procurement admin routes.
//
// Follows the convention already in api/inventory.js: when no key is
// configured the route is open, which is fine for an internal-only
// deployment and NOT fine once client portal links exist — anyone who can
// reach an open /api/portal-links can mint a link to any client's data.
// Set PROCUREMENT_ADMIN_KEY before sharing the first portal link.
//
// The leading underscore keeps Vercel from serving this file as a route.

export function staffKeyConfigured() {
  return Boolean(process.env.PROCUREMENT_ADMIN_KEY || process.env.RAMP_PROXY_API_KEY);
}

export function checkStaffAuth(req) {
  const key = process.env.PROCUREMENT_ADMIN_KEY || process.env.RAMP_PROXY_API_KEY || '';
  if (!key) return true;
  const header = req.headers['x-api-key'] || String(req.headers.authorization || '').replace('Bearer ', '');
  return header === key;
}
