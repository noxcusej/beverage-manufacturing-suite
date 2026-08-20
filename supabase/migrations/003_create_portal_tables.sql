-- Client Portal: per-client share links and procurement comments.
--
-- SECURITY NOTE — read before changing the policies below.
--
-- The existing tables in this project (app_data, formulas, inventory) carry
-- `FOR ALL USING (true)` policies, so anyone holding the public anon key can
-- read every row. That is acceptable for the internal suite, which is only
-- ever loaded by staff.
--
-- These two tables must NOT follow that pattern. A client portal is loaded by
-- people outside the company, and portal_links in particular is the thing that
-- decides who may see what. Both tables therefore have RLS enabled with **no
-- policy granting the anon role anything** — the only way in is the service
-- key, which lives on the server in api/. The portal browser bundle never
-- talks to Supabase directly; it goes through /api/portal.

-- ── Per-client share links ──────────────────────────────────────────────────
-- The raw token is never stored. We keep a SHA-256 hash of it, so a leaked
-- database row cannot be turned back into a working link. The full URL is
-- shown once, at creation, and a new one can be minted at any time.
CREATE TABLE IF NOT EXISTS portal_links (
  id            TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,          -- first few chars, to identify a link in a list
  label         TEXT,                   -- e.g. "Accounts payable, Cascade"
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,            -- null = no expiry
  revoked_at    TIMESTAMPTZ             -- null = active
);

CREATE INDEX IF NOT EXISTS portal_links_token_hash_idx ON portal_links (token_hash);
CREATE INDEX IF NOT EXISTS portal_links_client_idx ON portal_links (client_name);

ALTER TABLE portal_links ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service key only. See the note above.

-- ── Comments on bills and purchase orders ───────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_comments (
  id           TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL CHECK (target_type IN ('bill', 'purchase_order')),
  target_id    TEXT NOT NULL,
  -- Denormalized so a portal request can filter by client without first
  -- fetching every bill from Ramp to work out which ones belong to it.
  client_name  TEXT NOT NULL,
  author_type  TEXT NOT NULL CHECK (author_type IN ('client', 'internal')),
  author_name  TEXT,
  body         TEXT NOT NULL,
  -- 'internal' comments are never returned to a portal request. Client-authored
  -- comments are always 'shared'.
  visibility   TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'internal')),
  portal_link_id TEXT REFERENCES portal_links (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS procurement_comments_target_idx
  ON procurement_comments (target_type, target_id);
CREATE INDEX IF NOT EXISTS procurement_comments_client_idx
  ON procurement_comments (client_name);

ALTER TABLE procurement_comments ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service key only. See the note above.
