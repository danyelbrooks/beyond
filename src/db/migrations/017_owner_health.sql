-- =============================================================================
-- Migration 017: Owner Health Scoring System
--
-- Replaces the simple v_owner_health view (from migration 010) with a full
-- scoring system backed by persistent tables.
--
-- BREAKING CHANGE: v_owner_health is dropped and recreated with a new column
-- set. Any code reading the old columns (risk_score, risk_level, vacant_units,
-- avg_days_vacant, avg_response_hours, emails_received, open_work_orders) must
-- be updated to use the new column names from this view.
--
-- New tables:
--   owner_profiles       — extended relationship profile per owner (one row)
--   owner_health_scores  — scored snapshots; one row per run; keeps history
--   owner_signals        — individual warning keywords detected per owner
--   owner_interventions  — outreach / recovery actions taken on at-risk owners
--
-- New view:
--   v_owner_health — joins owners + latest score + profile for dashboard queries
--
-- Run in Supabase → SQL Editor (as service role / postgres).
-- =============================================================================


-- =============================================================================
-- TRIGGER FUNCTION
-- Scoped to this migration to avoid colliding with update_updated_at_column()
-- (migration 010) or set_updated_at() (migration 015).
-- Used only by owner_profiles, which is the only table here with updated_at.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.owner_health_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- TABLE 1: owner_profiles
-- Extended relationship profile per owner. One row per owner.
-- Stores context that changes infrequently: segment, preferences, tenure,
-- engagement history, and free-form notes.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.owner_profiles (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links to the owners table (one-to-one; deletes cascade)
  owner_id                uuid        UNIQUE NOT NULL
                                      REFERENCES public.owners(id) ON DELETE CASCADE,

  -- Owner classification and relationship ownership
  segment                 text        CHECK (segment IN (
                                        'investor_elite',
                                        'growth_investor',
                                        'legacy_client',
                                        'hands_off',
                                        'hands_on',
                                        'out_of_state',
                                        'accidental_landlord',
                                        'first_time_investor'
                                      )),
  relationship_owner      text        DEFAULT 'Rubin',

  -- Tenure and engagement metrics
  years_as_client         integer     DEFAULT 0,
  property_count          integer     DEFAULT 1,
  referrals_sent          integer     DEFAULT 0,
  reviews_written         integer     DEFAULT 0,

  -- Operational context
  avg_approval_time_hours numeric,        -- avg hours owner takes to approve maintenance bids
  last_vacancy_date       date,
  open_work_orders        integer     DEFAULT 0,
  last_inspection_date    date,

  -- Communication preferences and qualitative fields
  communication_preference text       DEFAULT 'email'
                                      CHECK (communication_preference IN ('email', 'phone', 'text')),
  investment_goals        text,
  notes                   text,

  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_profiles_owner_id
  ON public.owner_profiles (owner_id);

DROP TRIGGER IF EXISTS trg_owner_profiles_updated_at ON public.owner_profiles;
CREATE TRIGGER trg_owner_profiles_updated_at
  BEFORE UPDATE ON public.owner_profiles
  FOR EACH ROW EXECUTE FUNCTION public.owner_health_set_updated_at();

ALTER TABLE public.owner_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_profiles FORCE ROW LEVEL SECURITY;

-- Authenticated staff can read all profiles.
-- service_role bypasses RLS via its role-level BYPASSRLS attribute (Supabase default).
CREATE POLICY "authenticated users can read owner_profiles"
  ON public.owner_profiles
  FOR SELECT TO authenticated
  USING (true);


-- =============================================================================
-- TABLE 2: owner_health_scores
-- One row per scoring run per owner. History is preserved so trends can be
-- tracked. The dashboard always reads the most recent row via v_owner_health.
--
-- Score components:
--   score_bpm_response        — negative: deduction for slow BPM reply times
--   score_owner_engagement    — negative: deduction for low owner contact
--   score_tone_signals        — negative: deduction for warning keywords detected
--   score_property_performance — negative: deduction for vacancies / open WOs
--   score_relationship_bonus  — positive: bonus for tenure, referrals, reviews
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.owner_health_scores (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                    uuid        NOT NULL
                                          REFERENCES public.owners(id) ON DELETE CASCADE,

  -- Final computed score and tier
  score                       integer     NOT NULL CHECK (score >= 0 AND score <= 100),
  tier                        text        NOT NULL CHECK (tier IN (
                                            'champion',
                                            'healthy',
                                            'watch',
                                            'at_risk'
                                          )),

  -- Score breakdown (store components so the UI can show "why")
  score_bpm_response          integer     DEFAULT 0,
  score_owner_engagement      integer     DEFAULT 0,
  score_tone_signals          integer     DEFAULT 0,
  score_property_performance  integer     DEFAULT 0,
  score_relationship_bonus    integer     DEFAULT 0,

  -- Contact timing context captured at score time
  days_since_last_contact     integer,
  last_owner_email_at         timestamptz,
  last_bpm_reply_at           timestamptz,

  scored_at                   timestamptz DEFAULT now(),
  created_at                  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_health_scores_owner_id
  ON public.owner_health_scores (owner_id);

-- scored_at DESC is the access pattern — dashboard always wants the latest run
CREATE INDEX IF NOT EXISTS idx_owner_health_scores_scored_at
  ON public.owner_health_scores (scored_at DESC);

ALTER TABLE public.owner_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_health_scores FORCE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read owner_health_scores"
  ON public.owner_health_scores
  FOR SELECT TO authenticated
  USING (true);


-- =============================================================================
-- TABLE 3: owner_signals
-- Individual warning signals detected per owner, typically from email content.
-- is_active = true means the signal is still live; flip to false when the
-- owner recovers or the signal is manually resolved.
-- email_subject is denormalized here so the dashboard can display it without
-- a join back to email_cache.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.owner_signals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid        NOT NULL
                              REFERENCES public.owners(id) ON DELETE CASCADE,

  signal_type     text        NOT NULL CHECK (signal_type IN (
                                'phase_1',
                                'phase_2',
                                'phase_3',
                                'trust_request',
                                'engagement_drop',
                                'bpm_slow_response'
                              )),
  signal_keyword  text,           -- the specific word or phrase that triggered the signal
  email_id        uuid        REFERENCES public.email_cache(id) ON DELETE SET NULL,
  email_subject   text,           -- copied at detection time for fast display (no join needed)
  detected_at     timestamptz DEFAULT now(),
  is_active       boolean     DEFAULT true,
  created_at      timestamptz DEFAULT now()
);

-- Primary lookup: active signals for one owner, newest first
CREATE INDEX IF NOT EXISTS idx_owner_signals_owner_active_detected
  ON public.owner_signals (owner_id, is_active, detected_at DESC);

-- Secondary lookup: all signals for one owner regardless of active status
CREATE INDEX IF NOT EXISTS idx_owner_signals_owner_id
  ON public.owner_signals (owner_id);

ALTER TABLE public.owner_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_signals FORCE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read owner_signals"
  ON public.owner_signals
  FOR SELECT TO authenticated
  USING (true);


-- =============================================================================
-- TABLE 4: owner_interventions
-- Log of outreach and recovery actions taken on at-risk owners.
-- done_by references profiles (a BPM staff member), not auth.users directly,
-- to match the pattern used by the rest of the project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.owner_interventions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid        NOT NULL
                                  REFERENCES public.owners(id) ON DELETE CASCADE,

  intervention_type   text        CHECK (intervention_type IN (
                                    'phone_call',
                                    'email',
                                    'in_person',
                                    'money_back',
                                    'action_plan',
                                    'referral_ask'
                                  )),
  done_by             uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes               text,
  outcome             text        CHECK (outcome IN (
                                    'resolved',
                                    'still_at_risk',
                                    'lost',
                                    'pending'
                                  )),
  done_at             timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_interventions_owner_id
  ON public.owner_interventions (owner_id);

ALTER TABLE public.owner_interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_interventions FORCE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read owner_interventions"
  ON public.owner_interventions
  FOR SELECT TO authenticated
  USING (true);


-- =============================================================================
-- VIEW: v_owner_health
-- Replaces the simple view from migration 010.
--
-- One row per owner. Uses a LATERAL subquery (functionally identical to
-- DISTINCT ON owner_id ORDER BY scored_at DESC) to pull the most recent
-- scoring run. LATERAL is used instead of DISTINCT ON because we are also
-- LEFT JOINing owner_profiles; mixing DISTINCT ON with multiple LEFT JOINs
-- can produce ambiguous ordering. LATERAL is unambiguous and equally fast
-- when idx_owner_health_scores_owner_id exists.
--
-- active_signal_count is a correlated subquery so the view stays flat
-- (no GROUP BY required, no risk of row multiplication from joining signals).
-- =============================================================================
DROP VIEW IF EXISTS public.v_owner_health;

CREATE VIEW public.v_owner_health AS
SELECT
  -- Owner identity (from owners table)
  o.id                              AS owner_id,
  o.name                            AS owner_name,
  o.email                           AS owner_email,
  o.phone                           AS owner_phone,

  -- Latest health score (from owner_health_scores via LATERAL)
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

  -- Extended profile (from owner_profiles)
  p.segment,
  p.relationship_owner,
  p.years_as_client,
  p.property_count,
  p.referrals_sent,
  p.communication_preference,
  p.notes,

  -- Count of active warning signals (correlated subquery — no join needed)
  (
    SELECT COUNT(*)
    FROM public.owner_signals sig
    WHERE sig.owner_id = o.id
      AND sig.is_active = true
  ) AS active_signal_count

FROM public.owners o

-- Most recent score per owner only
LEFT JOIN LATERAL (
  SELECT *
  FROM public.owner_health_scores hs
  WHERE hs.owner_id = o.id
  ORDER BY hs.scored_at DESC
  LIMIT 1
) s ON true

-- Extended profile (may not exist yet for all owners)
LEFT JOIN public.owner_profiles p
  ON p.owner_id = o.id;

GRANT SELECT ON public.v_owner_health TO authenticated;


-- =============================================================================
-- ROLLBACK
-- Run these statements in order to undo migration 017.
-- After rollback, re-run the view section of migration 010 to restore the
-- original v_owner_health (risk_score / risk_level / avg_days_vacant columns).
-- =============================================================================
-- DROP VIEW IF EXISTS public.v_owner_health;
-- DROP TABLE IF EXISTS public.owner_interventions;
-- DROP TABLE IF EXISTS public.owner_signals;
-- DROP TABLE IF EXISTS public.owner_health_scores;
-- DROP TABLE IF EXISTS public.owner_profiles;
-- DROP FUNCTION IF EXISTS public.owner_health_set_updated_at();
