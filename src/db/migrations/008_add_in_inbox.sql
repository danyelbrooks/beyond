-- Migration 008 — Add in_inbox column to email_cache
--
-- Tracks whether an email is currently in the Gmail inbox (vs archived).
-- Default is FALSE so existing emails show as archived.
-- The sync script sets this to TRUE when the email has the INBOX label in Gmail.
--
-- Run this in Supabase → SQL Editor.

ALTER TABLE email_cache ADD COLUMN IF NOT EXISTS in_inbox BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_email_in_inbox
  ON email_cache (in_inbox);
