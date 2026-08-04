-- =============================================================================
-- Migration 032: Add appfolio_owner_id to onboardings
--
-- Stores the AppFolio owner record ID returned by the Stack API after the
-- primary owner is created during the post-onboarding sync.
-- Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
-- =============================================================================

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS appfolio_owner_id text;
