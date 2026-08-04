-- Migration 007 — Search indexes for email_cache
--
-- Adds indexes to make inbox filtering and text search fast on large tables.
-- The pg_trgm extension enables fast ILIKE '%term%' searches.
--
-- Run this in Supabase → SQL Editor.

-- Enable trigram extension (needed for fast text search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Index for inbox filter (to_address) — used every time you click an inbox pill
CREATE INDEX IF NOT EXISTS idx_email_to_address
  ON email_cache (to_address);

-- Index for date ordering — used on every page load
CREATE INDEX IF NOT EXISTS idx_email_received_at
  ON email_cache (received_at DESC);

-- Index for status filter — used by New / Handled tabs
CREATE INDEX IF NOT EXISTS idx_email_status
  ON email_cache (status);

-- Trigram indexes for fast text search on subject, sender name, sender address
CREATE INDEX IF NOT EXISTS idx_email_subject_trgm
  ON email_cache USING GIN (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_email_from_name_trgm
  ON email_cache USING GIN (from_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_email_from_address_trgm
  ON email_cache USING GIN (from_address gin_trgm_ops);
