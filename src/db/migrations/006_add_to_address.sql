-- Migration 006 — Add to_address column and update RLS policy on email_cache
--
-- Adds a column to track which inbox each email was delivered to.
-- Updates the Row Level Security (RLS) policy so that emails to
-- danyel@bpmsd.com are only visible to admin-role users.
--
-- Run this in Supabase → SQL Editor.

-- Step 1: Add the column (safe to re-run — IF NOT EXISTS prevents errors)
ALTER TABLE email_cache ADD COLUMN IF NOT EXISTS to_address TEXT;

-- Step 2: Replace the existing select policy with one that enforces the
-- danyel@bpmsd.com visibility restriction.
--
-- Rule: danyel@bpmsd.com emails → admin only; all other emails → any authenticated user.
-- get_user_role() is a Supabase function that returns the current user's role
-- from the profiles table.

DROP POLICY IF EXISTS "Users can view emails" ON email_cache;

CREATE POLICY "Users can view emails" ON email_cache
  FOR SELECT USING (
    to_address != 'danyel@bpmsd.com'
    OR get_user_role() = 'admin'
  );
