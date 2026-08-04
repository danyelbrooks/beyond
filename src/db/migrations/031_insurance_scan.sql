-- =============================================================================
-- Migration 031: Insurance Scan Columns
--
-- Adds AI scan results and follow-up fields to the onboardings table.
-- Run in Supabase → SQL Editor (as service role / postgres).
-- Safe to re-run — all ALTER statements use IF NOT EXISTS.
--
-- Columns added:
--   insurance_coverage_status     — scan result: ADDITIONALLY_INSURED |
--                                   CERTIFICATE_HOLDER | NOT_FOUND | SCAN_ERROR
--   insurance_company             — carrier name extracted by AI
--   insurance_policy_number       — policy number extracted by AI
--   insurance_expiration_date     — expiration date extracted by AI (text)
--   insurance_deadline            — 15-day deadline date set at scan time
--   insurance_surevestor_approved — true if owner enrolled in Surevestor
-- =============================================================================

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS insurance_coverage_status   text,
  ADD COLUMN IF NOT EXISTS insurance_company            text,
  ADD COLUMN IF NOT EXISTS insurance_policy_number      text,
  ADD COLUMN IF NOT EXISTS insurance_expiration_date    text,
  ADD COLUMN IF NOT EXISTS insurance_deadline           date,
  ADD COLUMN IF NOT EXISTS insurance_surevestor_approved boolean;
