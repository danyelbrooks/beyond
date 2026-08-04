-- 018_owner_911.sql
-- 911 Take to 100% — urgent owner escalation list

CREATE TABLE IF NOT EXISTS owner_911 (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid        NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  concern          text        NOT NULL,
  flagged_by       uuid        REFERENCES auth.users(id),
  flagged_at       timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'resolved', 'email_sent')),
  resolved_by      uuid        REFERENCES auth.users(id),
  resolved_at      timestamptz,
  resolution_notes text,
  email_sent_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Index for fast active-list queries
CREATE INDEX IF NOT EXISTS owner_911_status_idx ON owner_911 (status, flagged_at DESC);
CREATE INDEX IF NOT EXISTS owner_911_owner_idx  ON owner_911 (owner_id);

-- RLS
ALTER TABLE owner_911 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read owner_911"
  ON owner_911 FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert owner_911"
  ON owner_911 FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update owner_911"
  ON owner_911 FOR UPDATE TO authenticated USING (true);
