-- 028_owner_health_v2.sql
-- Adds leadsimple_contact_id to owners, risk_since to owner_profiles.
-- Rebuilds v_owner_health to expose both new columns.

ALTER TABLE public.owners ADD COLUMN IF NOT EXISTS leadsimple_contact_id text;
ALTER TABLE public.owner_profiles ADD COLUMN IF NOT EXISTS risk_since timestamptz;

-- Rebuild view to include new columns
DROP VIEW IF EXISTS public.v_owner_health;

CREATE VIEW public.v_owner_health AS
SELECT
  o.id                              AS owner_id,
  o.name                            AS owner_name,
  o.email                           AS owner_email,
  o.phone                           AS owner_phone,
  o.leadsimple_contact_id,

  s.score,
  s.tier,
  s.score_bpm_response,
  s.score_owner_engagement,
  s.score_tone_signals,
  s.score_property_performance,
  s.score_relationship_bonus,
  s.days_since_last_contact,
  s.last_owner_email_at,
  s.last_bpm_reply_at,
  s.scored_at,

  p.segment,
  p.relationship_owner,
  p.years_as_client,
  p.property_count,
  p.referrals_sent,
  p.communication_preference,
  p.notes,
  p.risk_since,

  (
    SELECT COUNT(*)
    FROM public.owner_signals sig
    WHERE sig.owner_id = o.id
      AND sig.is_active = true
  ) AS active_signal_count

FROM public.owners o

LEFT JOIN LATERAL (
  SELECT *
  FROM public.owner_health_scores hs
  WHERE hs.owner_id = o.id
  ORDER BY hs.scored_at DESC
  LIMIT 1
) s ON true

LEFT JOIN public.owner_profiles p
  ON p.owner_id = o.id;

GRANT SELECT ON public.v_owner_health TO authenticated;
