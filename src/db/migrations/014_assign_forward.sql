-- Migration 014 — Assign + Forward support
--
-- 1. Adds forwarded_to TEXT to email_cache  — which inbox an email was forwarded to
-- 2. Adds forwarded_to TEXT to email_actions — logged when action_type = 'forwarded'
-- 3. Expands the action_type check constraint to include 'forwarded'
--
-- Run in Supabase → SQL Editor.

-- email_cache: track which inbox this email was forwarded to
ALTER TABLE public.email_cache
  ADD COLUMN IF NOT EXISTS forwarded_to TEXT;

-- email_actions: store the destination inbox on forward actions
ALTER TABLE public.email_actions
  ADD COLUMN IF NOT EXISTS forwarded_to TEXT;

-- Expand action_type to include 'forwarded'
-- Must drop the old check constraint and recreate with the new value.
ALTER TABLE public.email_actions
  DROP CONSTRAINT IF EXISTS email_actions_action_type_check;

ALTER TABLE public.email_actions
  ADD CONSTRAINT email_actions_action_type_check
  CHECK (action_type IN ('assigned', 'categorized', 'replied', 'marked_handled', 'marked_new', 'forwarded'));
