-- Migration 035: Add 'onboarding' as a valid role in the profiles table
--
-- The onboarding role gives team members access to app.bpmsd.com but limits
-- their view to the Onboarding section only — no KPIs, analytics, or owner data.

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'staff', 'onboarding'));

COMMENT ON COLUMN public.profiles.role IS
  'One of: admin, manager, staff, onboarding. Controls what the user can see and do.';
