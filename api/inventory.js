import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
);

const API_KEY = process.env.MAKE_API_KEY || '';

function unauthorized(res) {
  return res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });
}

function checkAuth(req) {
  if (!API_KEY) return true; // No key configured = open (dev mode)
  const header = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return header === API_KEY;
}

export default async function handler(req, res) {
  // CORS for browser access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!checkAuth(req)) return unauthorized(res);

  try {
    // GET /api/inventory — list all items
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('inventory')
        .select('*')
        .order('updated_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data, count: data.length });
    }

    // POST /api/inventory — create or update item(s)
    // Accepts single item or array of items
    if (req.method === 'POST') {
      const body = req.body;
      const items = Array.isArray(body) ? body : (body.items || [body]);
      const now = new Date().toISOString();

      const rows = items.map(item => ({
        id: item.id || item.katana_id || `INV-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        name: item.name,
        sku: item.sku || null,
        category: item.category || 'ingredient',
        unit: item.unit || 'gal',
        current_stock: item.currentStock ?? item.current_stock ?? 0,
        reorder_point: item.reorderPoint ?? item.reorder_point ?? 0,
        price_tiers: item.priceTiers || item.price_tiers || [],
        vendor_id: item.vendorId || item.vendor_id || null,
        katana_id: item.katana_id || item.katanaId || null,
        katana_variant_id: item.katana_variant_id || item.katanaVariantId || null,
        katana_last_sync: now,
        data: item.data || {},
        updated_at: now,
      }));

      const { data, error } = await supabase
        .from('inventory')
        .upsert(rows, { onConflict: 'id' })
        .select();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ upserted: data.length, items: data });
    }

    // PUT /api/inventory — update stock levels only (lightweight sync)
    // Body: { updates: [{ id: "INV-001", current_stock: 500 }, ...] }
    if (req.method === 'PUT') {
      const { updates } = req.body;
      if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ error: 'Missing updates array' });
      }

      const now = new Date().toISOString();
      const results = [];
      for (const upd of updates) {
        const { id, katana_id, ...fields } = upd;
        const matchField = id ? 'id' : 'katana_id';
        const matchValue = id || katana_id;

        const updateData = { ...fields, katana_last_sync: now, updated_at: now };

        const { data, error } = await supabase
          .from('inventory')
          .update(updateData)
          .eq(matchField, matchValue)
          .select();

        if (error) results.push({ match: matchValue, error: error.message });
        else results.push({ match: matchValue, updated: data.length > 0 });
      }

      return res.status(200).json({ results });
    }

    // DELETE /api/inventory?id=INV-001
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Missing id parameter' });

      const { error } = await supabase
        .from('inventory')
        .delete()
        .eq('id', id);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[API] inventory error:', err);
    return res.status(500).json({ error: err.message });
  }
}
