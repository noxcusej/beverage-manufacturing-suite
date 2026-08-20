-- Review deadlines, the lock they impose, and the approval decisions they lock.
--
-- SECURITY NOTE — same rule as migration 003: these tables have RLS enabled
-- with **no policy for the anon role**. They are reachable only through the
-- service key, from api/. A lock that the browser could write around would not
-- be a lock, so approval decisions move here out of the anon-writable
-- app_data blob they previously lived in.

-- ── Deadlines ───────────────────────────────────────────────────────────────
-- One row per reviewable record. A deadline may hang off a bill or off a whole
-- purchase order; a bill with no deadline of its own inherits its PO's, so a
-- run can be put on a single review clock. See src/data/reviewLock.js.
CREATE TABLE IF NOT EXISTS review_deadlines (
  id              TEXT PRIMARY KEY,
  target_type     TEXT NOT NULL CHECK (target_type IN ('bill', 'purchase_order')),
  target_id       TEXT NOT NULL,
  client_name     TEXT NOT NULL,
  due_at          TIMESTAMPTZ NOT NULL,
  note            TEXT,
  set_by          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An admin can lift the lock for a while WITHOUT moving the original due
  -- date, so the record still shows when review was meant to close.
  reopened_until  TIMESTAMPTZ,
  reopened_by     TEXT,
  reopened_reason TEXT,
  UNIQUE (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS review_deadlines_client_idx ON review_deadlines (client_name);
CREATE INDEX IF NOT EXISTS review_deadlines_due_idx ON review_deadlines (due_at);

ALTER TABLE review_deadlines ENABLE ROW LEVEL SECURITY;

-- ── Audit trail ─────────────────────────────────────────────────────────────
-- "Only an admin can edit or reopen a deadline" is only meaningful if it is
-- visible afterwards who did what. Every mutation appends a row here; nothing
-- ever updates or deletes one.
CREATE TABLE IF NOT EXISTS review_deadline_events (
  id           TEXT PRIMARY KEY,
  deadline_id  TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('set', 'edited', 'reopened', 'cleared')),
  -- 'staff' for the initial set, 'admin' for anything after it.
  actor_role   TEXT NOT NULL CHECK (actor_role IN ('staff', 'admin')),
  actor        TEXT,
  previous_due_at TIMESTAMPTZ,
  new_due_at   TIMESTAMPTZ,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_deadline_events_target_idx
  ON review_deadline_events (target_type, target_id, created_at DESC);

ALTER TABLE review_deadline_events ENABLE ROW LEVEL SECURITY;

-- ── Approval decisions ──────────────────────────────────────────────────────
-- Previously a JSONB blob under app_data('bill_decisions'), which the public
-- anon key can write. Moved here so the deadline lock can actually be enforced
-- on the write path. The dashboard now goes through /api/decisions.
--
-- The absence of a row still means "approved automatically" — only exceptions
-- are stored, exactly as before.
CREATE TABLE IF NOT EXISTS bill_decisions (
  bill_id     TEXT PRIMARY KEY,
  client_name TEXT,
  status      TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  reason      TEXT,
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bill_decisions_client_idx ON bill_decisions (client_name);

ALTER TABLE bill_decisions ENABLE ROW LEVEL SECURITY;

-- No policies on any of the three tables: service key only.
