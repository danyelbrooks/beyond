-- 023_resident_health_v2.sql
-- Upgrades the Resident Health system to service-quality scoring.
--
-- Changes:
--   residents              → adds appfolio_tenant_id (for Stack API upserts)
--   resident_health_scores → adds score_email_response, score_open_threads,
--                            avg_response_hours, open_thread_count
--   v_resident_health view → rebuilt to expose new columns

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENTS — add AppFolio tenant ID column
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE residents ADD COLUMN IF NOT EXISTS appfolio_tenant_id text;

CREATE UNIQUE INDEX IF NOT EXISTS residents_appfolio_tenant_id_idx
  ON residents (appfolio_tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RESIDENT HEALTH SCORES — add service-quality columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE resident_health_scores
  ADD COLUMN IF NOT EXISTS score_email_response integer NOT NULL DEFAULT 0;

ALTER TABLE resident_health_scores
  ADD COLUMN IF NOT EXISTS score_open_threads integer NOT NULL DEFAULT 0;

ALTER TABLE resident_health_scores
  ADD COLUMN IF NOT EXISTS avg_response_hours float;

ALTER TABLE resident_health_scores
  ADD COLUMN IF NOT EXISTS open_thread_count integer;

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: v_resident_health — rebuilt with new scoring columns
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
  r.appfolio_tenant_id,
  r.appfolio_unit_id,
  -- Latest score (LATERAL join — most recent score row)
  s.score,
  s.tier,
  s.score_email_response,
  s.score_open_threads,
  s.avg_response_hours,
  s.open_thread_count,
  s.legal_threat_detected,
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
