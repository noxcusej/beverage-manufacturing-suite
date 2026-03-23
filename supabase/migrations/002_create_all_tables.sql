-- Generic app data table - each domain stored as a JSONB blob
-- This avoids needing per-item tables and works exactly like localStorage but in Supabase
CREATE TABLE IF NOT EXISTS app_data (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to app_data" ON app_data
  FOR ALL USING (true) WITH CHECK (true);

-- Seed empty rows for each domain
INSERT INTO app_data (key, data) VALUES
  ('inventory', '[]'::jsonb),
  ('packaging', '[]'::jsonb),
  ('services', '[]'::jsonb),
  ('vendors', '[]'::jsonb),
  ('runs', '[]'::jsonb),
  ('clients', '[]'::jsonb),
  ('tank_config', '[]'::jsonb),
  ('current_batch', 'null'::jsonb),
  ('mission_control', '{"tasks":[],"cronJobs":[],"team":[],"officeStatus":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
