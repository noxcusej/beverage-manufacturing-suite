import { createClient } from '@supabase/supabase-js';

/**
 * Katana Webhook Receiver
 *
 * Make.com scenario: Katana trigger → HTTP module → this endpoint
 *
 * Katana sends events for:
 * - material.created / material.updated / material.deleted
 * - stock_adjustment.created
 * - purchase_order.completed
 *
 * This endpoint normalizes Katana's data format into our inventory schema.
 */

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
);

const API_KEY = process.env.MAKE_API_KEY || '';

function checkAuth(req) {
  if (!API_KEY) return true;
  const header = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return header === API_KEY;
}

// Map Katana unit names to our unit system
const UNIT_MAP = {
  'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
  'g': 'g', 'gram': 'g', 'grams': 'g',
  'lb': 'lbs', 'lbs': 'lbs', 'pound': 'lbs', 'pounds': 'lbs',
  'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
  'l': 'L', 'liter': 'L', 'litre': 'L', 'liters': 'L', 'litres': 'L',
  'ml': 'ml', 'milliliter': 'ml', 'millilitre': 'ml',
  'gal': 'gal', 'gallon': 'gal', 'gallons': 'gal',
  'unit': 'ea', 'units': 'ea', 'each': 'ea', 'ea': 'ea', 'pcs': 'ea',
};

function normalizeUnit(katanaUnit) {
  if (!katanaUnit) return 'ea';
  return UNIT_MAP[katanaUnit.toLowerCase().trim()] || katanaUnit.toLowerCase();
}

function katanaMaterialToInventory(material) {
  const now = new Date().toISOString();
  const unit = normalizeUnit(material.default_uom || material.unit);

  return {
    id: `KATANA-${material.id}`,
    name: material.name || material.product_name,
    sku: material.sku || material.internal_code || null,
    category: material.category?.name || material.type || 'ingredient',
    unit: unit,
    current_stock: material.in_stock ?? material.available_stock ?? 0,
    reorder_point: material.reorder_point ?? 0,
    price_tiers: material.default_supplier_cost ? [{
      minQty: 1,
      maxQty: null,
      price: material.default_supplier_cost,
      buyUnit: unit,
      moq: material.minimum_order_quantity || 1,
      setupFee: 0,
    }] : [],
    vendor_id: null,
    katana_id: String(material.id),
    katana_variant_id: material.variant_id ? String(material.variant_id) : null,
    katana_last_sync: now,
    data: {
      katana_category: material.category?.name,
      katana_notes: material.notes,
      katana_barcode: material.barcode,
      katana_supplier: material.default_supplier?.name,
    },
    updated_at: now,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;

    // Support both single event and batch from Make
    const events = Array.isArray(body) ? body : [body];
    const results = [];

    for (const event of events) {
      const eventType = event.event || event.type || 'sync';
      const material = event.material || event.data || event;

      if (eventType.includes('deleted') || eventType === 'delete') {
        // Delete
        const katanaId = String(material.id || material.katana_id);
        const { error } = await supabase
          .from('inventory')
          .delete()
          .eq('katana_id', katanaId);

        results.push({
          action: 'deleted',
          katana_id: katanaId,
          success: !error,
          error: error?.message,
        });
      } else {
        // Create or update
        const row = katanaMaterialToInventory(material);

        // Check if exists by katana_id
        const { data: existing } = await supabase
          .from('inventory')
          .select('id')
          .eq('katana_id', row.katana_id)
          .maybeSingle();

        if (existing) {
          // Update existing — keep our local ID
          const { id, ...updateFields } = row;
          const { error } = await supabase
            .from('inventory')
            .update(updateFields)
            .eq('katana_id', row.katana_id)
            .select();

          results.push({
            action: 'updated',
            katana_id: row.katana_id,
            id: existing.id,
            success: !error,
            error: error?.message,
          });
        } else {
          // Insert new
          const { error } = await supabase
            .from('inventory')
            .insert(row)
            .select();

          results.push({
            action: 'created',
            katana_id: row.katana_id,
            id: row.id,
            success: !error,
            error: error?.message,
          });
        }
      }
    }

    return res.status(200).json({
      processed: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Katana Webhook] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
