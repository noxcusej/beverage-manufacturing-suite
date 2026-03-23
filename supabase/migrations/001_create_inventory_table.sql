-- Inventory table for Katana ↔ Make ↔ App sync
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT DEFAULT 'ingredient',
  unit TEXT DEFAULT 'gal',
  current_stock NUMERIC DEFAULT 0,
  reorder_point NUMERIC DEFAULT 0,
  price_tiers JSONB DEFAULT '[]'::jsonb,
  vendor_id TEXT,
  katana_id TEXT UNIQUE,
  katana_variant_id TEXT,
  katana_last_sync TIMESTAMPTZ,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for Katana lookups
CREATE INDEX IF NOT EXISTS idx_inventory_katana_id ON inventory (katana_id);

-- Index for category filtering
CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory (category);

-- Enable RLS
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;

-- Allow authenticated and anon reads/writes (tighten in production)
CREATE POLICY "Allow all access to inventory" ON inventory
  FOR ALL USING (true) WITH CHECK (true);
