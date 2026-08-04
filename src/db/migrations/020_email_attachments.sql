-- Migration 020 — Add attachments column to email_cache
-- Stores attachment metadata extracted during Gmail sync (filename, mimeType, size).
-- NULL means no attachments, or the email was synced before this feature was added.

ALTER TABLE public.email_cache ADD COLUMN IF NOT EXISTS attachments JSONB;
