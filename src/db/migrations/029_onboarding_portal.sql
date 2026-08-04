-- =============================================================================
-- Migration 029: BPM Owner Onboarding Portal
--
-- Creates the data layer for the guided owner onboarding workflow.
-- A staff member creates an onboarding record and generates a unique link;
-- the owner walks through 7 steps in the browser. Documents are saved to
-- Google Drive and tracked here. Staff flags surface items that need follow-up
-- (e.g. CA 588 pending, missing insurance certificate).
--
-- IMPORTANT: data_json in onboarding_steps must NEVER contain SSN, EIN,
-- routing number, or bank account number. Store only business-safe data.
--
-- New tables:
--   onboardings           — one row per property being onboarded
--   onboarding_steps      — one row per step per onboarding (7 steps total)
--   onboarding_documents  — every PDF/file saved to Google Drive
--   onboarding_flags      — staff alerts tied to an onboarding
--
-- Run in Supabase → SQL Editor (as service role / postgres).
-- Safe to re-run — all CREATE statements use IF NOT EXISTS.
-- =============================================================================


-- =============================================================================
-- TRIGGER FUNCTION
-- Updates updated_at on onboarding_steps whenever a row is modified.
-- Scoped to this migration to avoid colliding with other trigger functions.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.onboarding_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- TABLE 1: onboardings
-- One row per property being onboarded into BPM management.
-- token is a unique, URL-safe string the owner uses to access their portal link.
-- short_address is used for Google Drive folder naming (e.g. "Ash 123").
-- deposit_amount is auto-calculated: units × $750 (stored, not computed on read).
-- last_activity_at is bumped by the app whenever the owner or staff takes action.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.onboardings (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token                     text        UNIQUE NOT NULL,
  property_address          text        NOT NULL,
  short_address             text        NOT NULL,  -- e.g. "Ash 123" for file naming
  apn                       text,
  owner_name                text        NOT NULL,
  owner_first_name          text,
  owner_mailing_address     text,
  owner_email               text,
  owner_phone               text,
  agreement_type            text        NOT NULL CHECK (agreement_type IN ('full_management','tenant_placement')),
  units                     integer     NOT NULL DEFAULT 1,
  management_start_date      date,
  agreement_termination_date date,
  deposit_amount            integer     GENERATED ALWAYS AS (units * 750) STORED,
  entity_type               text        NOT NULL DEFAULT 'individual' CHECK (entity_type IN ('individual','trust','business')),
  google_drive_folder_id    text,
  google_drive_folder_name  text,
  status                    text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','revoked')),
  staff_notes               text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_activity_at          timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz
);

CREATE INDEX IF NOT EXISTS idx_onboardings_token  ON public.onboardings(token);
CREATE INDEX IF NOT EXISTS idx_onboardings_status ON public.onboardings(status);

ALTER TABLE public.onboardings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read onboardings"
  ON public.onboardings FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert onboardings"
  ON public.onboardings FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update onboardings"
  ON public.onboardings FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete onboardings"
  ON public.onboardings FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 2: onboarding_steps
-- One row per step per onboarding. Each onboarding has exactly 7 steps.
-- step_number is constrained 1–7 and must be unique per onboarding.
-- data_json stores the owner's answers for that step.
--
-- SECURITY NOTE: data_json must NEVER contain SSN, EIN, routing number,
-- or bank account number. Only business-safe fields belong here.
--
-- updated_at is tracked here because step rows change state as the owner
-- progresses (not_started → in_progress → complete).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_steps (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id  uuid        NOT NULL REFERENCES public.onboardings(id) ON DELETE CASCADE,
  step_number    integer     NOT NULL CHECK (step_number BETWEEN 1 AND 7),
  step_name      text        NOT NULL,
  status         text        NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','complete','skipped')),
  data_json      jsonb,
  completed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (onboarding_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_steps_onboarding ON public.onboarding_steps(onboarding_id);

DROP TRIGGER IF EXISTS trg_onboarding_steps_updated_at ON public.onboarding_steps;
CREATE TRIGGER trg_onboarding_steps_updated_at
  BEFORE UPDATE ON public.onboarding_steps
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_set_updated_at();

ALTER TABLE public.onboarding_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read onboarding_steps"
  ON public.onboarding_steps FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert onboarding_steps"
  ON public.onboarding_steps FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update onboarding_steps"
  ON public.onboarding_steps FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete onboarding_steps"
  ON public.onboarding_steps FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 3: onboarding_documents
-- Tracks every PDF or file saved to Google Drive as part of an onboarding.
-- step_number links the document back to the step it belongs to (nullable
-- because some documents, like the signed management agreement, span the
-- full onboarding rather than a single step).
-- uploaded_by_owner = true means the owner uploaded it; false means BPM did.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_documents (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id         uuid        NOT NULL REFERENCES public.onboardings(id) ON DELETE CASCADE,
  step_number           integer,
  document_type         text        NOT NULL,
  filename              text        NOT NULL,
  google_drive_file_id  text,
  uploaded_by_owner     boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_onboarding ON public.onboarding_documents(onboarding_id);

ALTER TABLE public.onboarding_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read onboarding_documents"
  ON public.onboarding_documents FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert onboarding_documents"
  ON public.onboarding_documents FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update onboarding_documents"
  ON public.onboarding_documents FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete onboarding_documents"
  ON public.onboarding_documents FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 4: onboarding_flags
-- Staff alerts tied to a specific onboarding — e.g. "CA 588 not yet returned",
-- "insurance certificate missing", "owner has questions about fee schedule".
-- resolved_at is null while the flag is open; set it when the issue is closed.
-- created_by references a staff member's auth user id (nullable for system flags).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_flags (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id  uuid        NOT NULL REFERENCES public.onboardings(id) ON DELETE CASCADE,
  flag_type      text        NOT NULL,
  message        text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flags_onboarding ON public.onboarding_flags(onboarding_id);

ALTER TABLE public.onboarding_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read onboarding_flags"
  ON public.onboarding_flags FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert onboarding_flags"
  ON public.onboarding_flags FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update onboarding_flags"
  ON public.onboarding_flags FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete onboarding_flags"
  ON public.onboarding_flags FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- ROLLBACK
-- Run these statements in order to undo migration 029.
-- WARNING: all onboarding data will be permanently deleted.
-- =============================================================================
-- DROP TABLE IF EXISTS public.onboarding_flags;
-- DROP TABLE IF EXISTS public.onboarding_documents;
-- DROP TABLE IF EXISTS public.onboarding_steps;
-- DROP TABLE IF EXISTS public.onboardings;
-- DROP FUNCTION IF EXISTS public.onboarding_set_updated_at();
