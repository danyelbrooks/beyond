-- Migration 016 — Snooze + reply enhancements
-- Run in Supabase → SQL Editor.

-- Add snoozed_until to email_cache
ALTER TABLE public.email_cache
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_email_cache_snoozed
  ON public.email_cache (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- Extend action_type to include snoozed / unsnoozed
ALTER TABLE public.email_actions
  DROP CONSTRAINT IF EXISTS email_actions_action_type_check;

ALTER TABLE public.email_actions
  ADD CONSTRAINT email_actions_action_type_check
  CHECK (action_type IN (
    'assigned','categorized','replied','marked_handled',
    'marked_new','forwarded','snoozed','unsnoozed'
  ));
