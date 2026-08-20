// Staff route: mint, list and revoke per-client portal links.
//
//   GET    /api/portal-links[?client=Name]  list links (never the tokens)
//   POST   /api/portal-links                mint a link — returns the URL ONCE
//   DELETE /api/portal-links?id=plink_...   revoke a link
//
// The raw token is returned by POST and never again: only its SHA-256 hash is
// stored, so a leaked database row cannot be turned back into a working link.

import {
  createPortalLink,
  listPortalLinks,
  revokePortalLink,
  storeUnavailableReason,
} from './_portalStore.js';
import { checkStaffAuth, authStatus } from './_staffAuth.js';

function portalUrl(req, token) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}/portal/${token}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkStaffAuth(req)) return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });

  const unavailable = storeUnavailableReason();
  if (unavailable) {
    return res.status(200).json({
      available: false,
      reason: unavailable,
      links: [],
      // Surfaced in the UI so an operator is told before they share anything.
      ...authStatus(),
    });
  }

  try {
    if (req.method === 'GET') {
      const links = await listPortalLinks(req.query?.client ? String(req.query.client) : null);
      return res.status(200).json({ available: true, links, ...authStatus() });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const clientName = String(body.clientName || '').trim();
      if (!clientName) return res.status(400).json({ error: 'clientName is required.' });

      const { link, token } = await createPortalLink({
        clientName,
        label: body.label,
        createdBy: body.createdBy,
        expiresAt: body.expiresAt || null,
      });

      return res.status(201).json({
        link,
        // Shown once. There is no endpoint that can return this again.
        url: portalUrl(req, token),
        notice: 'Copy this link now — only a hash of it is stored, so it cannot be shown again.',
      });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) return res.status(400).json({ error: 'id is required.' });
      const link = await revokePortalLink(id);
      return res.status(200).json({ link });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[API] portal-links error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
