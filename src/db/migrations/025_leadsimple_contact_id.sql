-- 025_leadsimple_contact_id.sql
-- Adds leadsimple_contact_id to residents table and rebuilds v_resident_health view.

ALTER TABLE residents ADD COLUMN IF NOT EXISTS leadsimple_contact_id text;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rebuild view to expose leadsimple_contact_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_resident_health;

CREATE VIEW public.v_resident_health AS
SELECT
  r.id                                AS resident_id,
  r.name                              AS resident_name,
  r.email                             AS resident_email,
  r.property_name,
  r.property_address,
  r.unit_number,
  r.property_manager,
  r.move_in_date,
  r.lease_start,
  r.lease_end,
  r.appfolio_tenant_id,
  r.appfolio_unit_id,
  r.leadsimple_contact_id,
  -- Latest score
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
