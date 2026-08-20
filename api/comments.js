// Staff route: read and write comments on bills and purchase orders.
//
//   GET    /api/comments[?client=Name]   every comment, internal notes included
//   POST   /api/comments                 add a comment (shared or internal)
//   DELETE /api/comments?id=cmt_...      soft-delete a comment
//
// The client-facing counterpart lives in api/portal.js, which only ever reads
// `visibility: 'shared'` comments for the one client behind the share token.

import {
  listComments,
  addComment,
  deleteComment,
  storeUnavailableReason,
} from './_portalStore.js';
import { checkStaffAuth } from './_staffAuth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkStaffAuth(req)) return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });

  const unavailable = storeUnavailableReason();
  if (unavailable) {
    // Not an error: without the service key the dashboard keeps working and
    // simply says commenting is unavailable.
    return res.status(200).json({ available: false, reason: unavailable, comments: [] });
  }

  try {
    if (req.method === 'GET') {
      const comments = await listComments({
        clientName: req.query?.client ? String(req.query.client) : null,
        includeInternal: true,
      });
      return res.status(200).json({ available: true, comments });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const comment = await addComment({
        targetType: body.targetType,
        targetId: body.targetId,
        clientName: body.clientName || 'Unassigned',
        authorType: 'internal',
        authorName: body.authorName,
        body: body.body,
        visibility: body.visibility,
      });
      return res.status(201).json({ comment });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) return res.status(400).json({ error: 'id is required.' });
      await deleteComment(id);
      return res.status(200).json({ deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[API] comments error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
