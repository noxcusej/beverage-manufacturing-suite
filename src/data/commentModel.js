// Pure comment helpers — no store, no network, no browser APIs, so they can be
// exercised directly by procurement.test.mjs.

/** Stable key for grouping comments against the record they belong to. */
export function commentKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

/** @returns {Map<string, object[]>} key -> comments, oldest first */
export function groupComments(comments) {
  const map = new Map();
  for (const c of comments || []) {
    const key = commentKey(c.targetType, c.targetId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  return map;
}

/**
 * What a client portal is allowed to see. The server already filters, but the
 * rule is written once, here, so both sides agree on it: internal notes never
 * cross to a client, and a client only sees their own thread.
 */
export function visibleToClient(comments, clientName) {
  return (comments || []).filter(
    (c) => c.visibility !== 'internal' && (!clientName || c.clientName === clientName)
  );
}
