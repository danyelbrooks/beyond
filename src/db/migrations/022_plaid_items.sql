-- =============================================================================
-- Migration 022: Plaid Bank Account Items
--
-- Stores the permanent access_token for each bank account Danyel links through
-- Plaid Link. One row per institution/item (a single bank connection may expose
-- multiple accounts — those come back from the Plaid API at sync time and are
-- written to cfo_asset_lines and cfo_liability_lines, not stored here).
--
-- Security: access_token is server-side only. It is NEVER returned in any
-- API response to the browser. The frontend only ever receives a link_token
-- (temporary, 30-min lifetime) from POST /api/cfo/plaid/link-token.
--
-- Run in Supabase → SQL Editor (as service role / postgres).
-- =============================================================================


-- =============================================================================
-- TABLE: cfo_plaid_items
-- One row per linked Plaid item (bank connection).
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_plaid_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id   text,                        -- Plaid institution_id (e.g. 'ins_3')
  institution_name text,                        -- Human name (e.g. 'Chase')
  access_token     text        NOT NULL,        -- Permanent Plaid access token — NEVER expose to browser
  item_id          text,                        -- Plaid item_id (stable, for webhook routing)
  linked_at        timestamptz NOT NULL DEFAULT now(),
  last_synced_at   timestamptz,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_plaid_items_is_active_idx
  ON cfo_plaid_items (is_active);

DROP TRIGGER IF EXISTS trg_cfo_plaid_items_updated_at ON cfo_plaid_items;
CREATE TRIGGER trg_cfo_plaid_items_updated_at
  BEFORE UPDATE ON cfo_plaid_items
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_plaid_items ENABLE ROW LEVEL SECURITY;

-- Only authenticated users (the server-side service role) can read/write items.
CREATE POLICY "auth read cfo_plaid_items"
  ON cfo_plaid_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_plaid_items"
  ON cfo_plaid_items FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_plaid_items"
  ON cfo_plaid_items FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_plaid_items"
  ON cfo_plaid_items FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- ROLLBACK
-- Run this to undo migration 022.
-- =============================================================================
-- DROP TABLE IF EXISTS cfo_plaid_items;
