// Collision-safe ID generation for catalog items.
//
// `prefix + (items.length+1).padStart(3,'0')` is NOT safe: deleting one
// item then adding a new one reuses an ID that already exists on another
// row. From that point, every `.find(id===…)` resolves to the first match
// and the second row silently mutates the wrong record.
//
// nextId() walks all existing IDs in `items`, finds the largest numeric
// suffix matching `prefix`, and returns prefix + (max+1).padStart(width).

/**
 * @param {string} prefix - e.g. "INV-", "PKG-", "SVC-"
 * @param {Array<{id?: string}>} items - existing items to inspect
 * @param {number} [width=3] - zero-pad width
 * @returns {string} next collision-safe id
 */
export function nextId(prefix, items, width = 3) {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  let max = 0;
  for (const it of items || []) {
    const m = typeof it?.id === 'string' ? it.id.match(re) : null;
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}
