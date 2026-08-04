-- 019_resident_health.sql
-- Resident Health Score — Phase 1
-- Residents are sourced from the units table (raw_payload).
-- Phase 2 will add email-based signals (open thread age, legal threat detection)
-- once resident email addresses are available.

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENTS
-- One row per occupied unit / current tenant.
-- Populated by: node src/residents/sync-residents.js
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS residents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id          uuid        REFERENCES units(id) ON DELETE SET NULL,
  name             text,
  email            text,        -- populated when AppFolio email sync is available
  move_in_date     date,
  lease_start      date,
  lease_end        date,
  late_count       integer     NOT NULL DEFAULT 0,
  past_due_cents   integer     NOT NULL DEFAULT 0,  -- stored in cents; negative = credit
  property_name    text,
  unit_number      text,
  property_manager text,        -- from AppFolio tags
  appfolio_unit_id text,        -- for re-sync matching
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS residents_unit_id_idx ON residents (unit_id);
CREATE INDEX IF NOT EXISTS residents_name_idx ON residents (name);

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENT PROFILES
-- Staff-entered metadata and observations.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resident_profiles (
  resident_id        uuid        PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  communication_pref text        CHECK (communication_pref IN ('text', 'email', 'phone')),
  notes              text,
  written_review     boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENT HEALTH SCORES
-- Historical record of scores. One row per scoring run per resident.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resident_health_scores (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resident_id           uuid        NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  score                 integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier                  text        NOT NULL CHECK (tier IN ('advocate', 'stable', 'watch', 'at_risk')),
  score_lease_timeline  integer     NOT NULL DEFAULT 0,
  score_payment         integer     NOT NULL DEFAULT 0,
  score_tenure          integer     NOT NULL DEFAULT 0,
  days_until_lease_end  integer,
  legal_threat_detected boolean     NOT NULL DEFAULT false,  -- Phase 2
  open_thread_days      integer,                             -- Phase 2
  scored_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rhs_resident_id_idx ON resident_health_scores (resident_id, scored_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENT 911
-- Urgent escalation list — mirrors the owner_911 pattern.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resident_911 (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resident_id      uuid        NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS r911_status_idx ON resident_911 (status, flagged_at DESC);
CREATE INDEX IF NOT EXISTS r911_resident_idx ON resident_911 (resident_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: v_resident_health
-- One row per resident — latest score joined with profile and unit data.
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_resident_health;

CREATE VIEW public.v_resident_health AS
SELECT
  r.id                                AS resident_id,
  r.name                              AS resident_name,
  r.email                             AS resident_email,
  r.property_name,
  r.unit_number,
  r.property_manager,
  r.move_in_date,
  r.lease_start,
  r.lease_end,
  r.late_count,
  r.past_due_cents,
  -- Latest score (LATERAL join)
  s.score,
  s.tier,
  s.score_lease_timeline,
  s.score_payment,
  s.score_tenure,
  s.days_until_lease_end,
  s.legal_threat_detected,
  s.open_thread_days,
  s.scored_at,
  -- Profile
  p.communication_pref,
  p.notes,
  p.written_review,
  -- Active 911 flag
  EXISTS (
    SELECT 1 FROM resident_911 r9
    WHERE r9.resident_id = r.id AND r9.status = 'active'
  ) AS on_911_list
FROM residents r
LEFT JOIN LATERAL (
  SELECT * FROM resident_health_scores rhs
  WHERE rhs.resident_id = r.id
  ORDER BY rhs.scored_at DESC
  LIMIT 1
) s ON true
LEFT JOIN resident_profiles p ON p.resident_id = r.id;

GRANT SELECT ON public.v_resident_health TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE residents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_911        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read residents"            ON residents           FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert residents"          ON residents           FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update residents"          ON residents           FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth read resident_profiles"    ON resident_profiles   FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth upsert resident_profiles"  ON resident_profiles   FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update resident_profiles"  ON resident_profiles   FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth read rhs"                  ON resident_health_scores FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert rhs"                ON resident_health_scores FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth read r911"                 ON resident_911        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert r911"               ON resident_911        FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update r911"               ON resident_911        FOR UPDATE TO authenticated USING (true);
