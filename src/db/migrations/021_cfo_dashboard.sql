-- =============================================================================
-- Migration 021: Personal CFO Dashboard
--
-- Creates the data layer for Danyel's personal net worth dashboard.
-- Tracks monthly snapshots, individual asset and liability lines, recurring
-- subscription charges, manual-entry form state, projection assumptions, and
-- multi-family syndication valuations (cap-rate method).
--
-- New tables:
--   cfo_snapshots            — one row per monthly net worth snapshot
--   cfo_asset_lines          — one row per asset (account, property, vehicle, policy)
--   cfo_liability_lines      — one row per mortgage or credit card
--   cfo_recurring_charges    — subscription / recurring charge tracking
--   cfo_manual_inputs        — last-entered manual values (pre-fills forms)
--   cfo_projection_params    — single-row config for projection assumptions
--   cfo_multifamily_valuations — T-12 NOI / cap-rate valuations for syndications
--
-- Seed data is inserted at the bottom for cfo_projection_params,
-- cfo_manual_inputs, and cfo_multifamily_valuations.
--
-- Run in Supabase → SQL Editor (as service role / postgres).
-- =============================================================================


-- =============================================================================
-- TRIGGER FUNCTION
-- Scoped to this migration to avoid colliding with existing trigger functions.
-- Applied to every CFO table that carries updated_at.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cfo_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- TABLE 1: cfo_snapshots
-- One row per monthly net worth snapshot.
-- snapshot_date should always be the first of the month (enforced by the app).
-- is_complete flips to true once all asset and liability lines are reconciled.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_snapshots (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date           date        NOT NULL,
  net_worth               numeric,
  total_assets            numeric,
  total_liabilities       numeric,
  passive_income_month    numeric,
  data_pull_completed_at  timestamptz,
  reconciled_at           timestamptz,
  is_complete             boolean     NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_snapshots_date_idx
  ON cfo_snapshots (snapshot_date DESC);

DROP TRIGGER IF EXISTS trg_cfo_snapshots_updated_at ON cfo_snapshots;
CREATE TRIGGER trg_cfo_snapshots_updated_at
  BEFORE UPDATE ON cfo_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_snapshots"
  ON cfo_snapshots FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_snapshots"
  ON cfo_snapshots FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_snapshots"
  ON cfo_snapshots FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_snapshots"
  ON cfo_snapshots FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 2: cfo_asset_lines
-- One row per individual asset: bank account, property, vehicle, life insurance.
-- equity is a stored generated column so the value is always consistent with
-- value and debt — the app never sets it directly.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_asset_lines (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id     uuid        NOT NULL
                              REFERENCES cfo_snapshots(id) ON DELETE CASCADE,

  bucket          text        NOT NULL CHECK (bucket IN (
                                'real_estate',
                                'cash',
                                'investments',
                                'business',
                                'life_insurance',
                                'vehicles',
                                'other'
                              )),
  line_name       text        NOT NULL,
  value           numeric     NOT NULL DEFAULT 0,
  debt            numeric     NOT NULL DEFAULT 0,
  equity          numeric     GENERATED ALWAYS AS (value - debt) STORED,

  data_source     text        NOT NULL CHECK (data_source IN (
                                'plaid',
                                'qbo',
                                'zillow',
                                'appfolio',
                                'email',
                                'manual'
                              )),
  external_id     text,           -- Plaid account ID, Zillow property ID, etc.
  pulled_at       timestamptz,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_asset_lines_snapshot_idx
  ON cfo_asset_lines (snapshot_id);

CREATE INDEX IF NOT EXISTS cfo_asset_lines_bucket_idx
  ON cfo_asset_lines (snapshot_id, bucket);

DROP TRIGGER IF EXISTS trg_cfo_asset_lines_updated_at ON cfo_asset_lines;
CREATE TRIGGER trg_cfo_asset_lines_updated_at
  BEFORE UPDATE ON cfo_asset_lines
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_asset_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_asset_lines"
  ON cfo_asset_lines FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_asset_lines"
  ON cfo_asset_lines FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_asset_lines"
  ON cfo_asset_lines FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_asset_lines"
  ON cfo_asset_lines FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 3: cfo_liability_lines
-- One row per mortgage or credit card balance.
-- interest_rate is stored as a decimal (0.0675 = 6.75%).
-- rate_alert = true flags this liability for refinance review.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_liability_lines (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id         uuid        NOT NULL
                                  REFERENCES cfo_snapshots(id) ON DELETE CASCADE,

  liability_type      text        NOT NULL CHECK (liability_type IN (
                                    'mortgage',
                                    'credit_card'
                                  )),
  line_name           text        NOT NULL,
  lender              text,
  balance             numeric     NOT NULL DEFAULT 0,
  interest_rate       numeric,            -- decimal: 0.0675 = 6.75%
  rate_alert          boolean     NOT NULL DEFAULT false,
  current_market_rate numeric,

  data_source         text        NOT NULL CHECK (data_source IN (
                                    'plaid',
                                    'manual'
                                  )),
  external_id         text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_liability_lines_snapshot_idx
  ON cfo_liability_lines (snapshot_id);

DROP TRIGGER IF EXISTS trg_cfo_liability_lines_updated_at ON cfo_liability_lines;
CREATE TRIGGER trg_cfo_liability_lines_updated_at
  BEFORE UPDATE ON cfo_liability_lines
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_liability_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_liability_lines"
  ON cfo_liability_lines FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_liability_lines"
  ON cfo_liability_lines FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_liability_lines"
  ON cfo_liability_lines FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_liability_lines"
  ON cfo_liability_lines FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 4: cfo_recurring_charges
-- Recurring charges detected from credit card transactions.
-- status tracks the review workflow: unreviewed → kept or flagged.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_recurring_charges (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_name       text        NOT NULL,
  amount              numeric     NOT NULL,
  frequency           text        NOT NULL CHECK (frequency IN (
                                    'monthly',
                                    'annual',
                                    'weekly',
                                    'irregular'
                                  )),
  last_charged_date   date,
  first_detected_date date,
  status              text        NOT NULL DEFAULT 'unreviewed'
                                  CHECK (status IN (
                                    'unreviewed',
                                    'kept',
                                    'flagged'
                                  )),
  reviewed_at         timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_recurring_charges_status_idx
  ON cfo_recurring_charges (status);

DROP TRIGGER IF EXISTS trg_cfo_recurring_charges_updated_at ON cfo_recurring_charges;
CREATE TRIGGER trg_cfo_recurring_charges_updated_at
  BEFORE UPDATE ON cfo_recurring_charges
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_recurring_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_recurring_charges"
  ON cfo_recurring_charges FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_recurring_charges"
  ON cfo_recurring_charges FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_recurring_charges"
  ON cfo_recurring_charges FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_recurring_charges"
  ON cfo_recurring_charges FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 5: cfo_manual_inputs
-- Stores the last value Danyel entered for each manual field so forms are
-- pre-filled on next visit. field_key is unique — one row per form field.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_manual_inputs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key       text        NOT NULL UNIQUE,    -- e.g. "mortgage_chase_carlsbad"
  display_label   text        NOT NULL,           -- e.g. "Carlsbad Home (Chase)"
  value           numeric     NOT NULL DEFAULT 0,
  entered_at      timestamptz,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_manual_inputs_field_key_idx
  ON cfo_manual_inputs (field_key);

DROP TRIGGER IF EXISTS trg_cfo_manual_inputs_updated_at ON cfo_manual_inputs;
CREATE TRIGGER trg_cfo_manual_inputs_updated_at
  BEFORE UPDATE ON cfo_manual_inputs
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_manual_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_manual_inputs"
  ON cfo_manual_inputs FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_manual_inputs"
  ON cfo_manual_inputs FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_manual_inputs"
  ON cfo_manual_inputs FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_manual_inputs"
  ON cfo_manual_inputs FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- TABLE 6: cfo_projection_params
-- Single-row configuration table for projection model assumptions.
-- The app inserts one row on first use and upserts it on every save.
-- mason_college_start_year: 2038 (Mason turns 18).
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_projection_params (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_appreciation_rate  numeric     NOT NULL DEFAULT 0.03,
  investment_growth_rate      numeric     NOT NULL DEFAULT 0.07,
  crypto_growth_rate          numeric     NOT NULL DEFAULT 0.00,
  mason_college_fund_target   numeric     NOT NULL DEFAULT 300000,
  mason_college_start_year    integer     NOT NULL DEFAULT 2038,
  dad_support_monthly         numeric     NOT NULL DEFAULT 0,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_cfo_projection_params_updated_at ON cfo_projection_params;
CREATE TRIGGER trg_cfo_projection_params_updated_at
  BEFORE UPDATE ON cfo_projection_params
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_projection_params ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_projection_params"
  ON cfo_projection_params FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_projection_params"
  ON cfo_projection_params FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_projection_params"
  ON cfo_projection_params FOR UPDATE TO authenticated USING (true);


-- =============================================================================
-- TABLE 7: cfo_multifamily_valuations
-- T-12 NOI + cap rate valuation for multi-family syndications.
-- full_property_value is generated: t12_noi / cap_rate.
-- danyels_equity is NOT generated — it is calculated by the app and stored
-- (because passive syndications use invested capital rather than cap-rate math).
-- =============================================================================
CREATE TABLE IF NOT EXISTS cfo_multifamily_valuations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_name         text        NOT NULL,
  ownership_pct         numeric,            -- decimal: 0.225 = 22.5%
  t12_noi               numeric,            -- full property NOI (not Danyel's share)
  cap_rate              numeric,            -- decimal: 0.065 = 6.5%
  full_property_value   numeric     GENERATED ALWAYS AS (
                                      t12_noi / NULLIF(cap_rate, 0)
                                    ) STORED,
  danyels_equity        numeric,            -- set by app; may use invested capital for passives
  entered_at            timestamptz NOT NULL DEFAULT now(),
  notes                 text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cfo_multifamily_property_idx
  ON cfo_multifamily_valuations (property_name);

DROP TRIGGER IF EXISTS trg_cfo_multifamily_valuations_updated_at ON cfo_multifamily_valuations;
CREATE TRIGGER trg_cfo_multifamily_valuations_updated_at
  BEFORE UPDATE ON cfo_multifamily_valuations
  FOR EACH ROW EXECUTE FUNCTION public.cfo_set_updated_at();

ALTER TABLE cfo_multifamily_valuations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read cfo_multifamily_valuations"
  ON cfo_multifamily_valuations FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth insert cfo_multifamily_valuations"
  ON cfo_multifamily_valuations FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth update cfo_multifamily_valuations"
  ON cfo_multifamily_valuations FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth delete cfo_multifamily_valuations"
  ON cfo_multifamily_valuations FOR DELETE TO authenticated USING (true);


-- =============================================================================
-- SEED: cfo_projection_params
-- One row with all defaults. The app upserts this row on every save.
-- =============================================================================
INSERT INTO cfo_projection_params (
  property_appreciation_rate,
  investment_growth_rate,
  crypto_growth_rate,
  mason_college_fund_target,
  mason_college_start_year,
  dad_support_monthly
) VALUES (
  0.03,
  0.07,
  0.00,
  300000,
  2038,
  0
);


-- =============================================================================
-- SEED: cfo_manual_inputs
-- Pre-populates the manual entry form with known field labels.
-- Values start at 0 until Danyel enters them.
-- =============================================================================
INSERT INTO cfo_manual_inputs (field_key, display_label, value) VALUES
  ('mortgage_robertson',          'Ridgecrest 6-Plex — 108 W Robertson',    0),
  ('mortgage_lincoln',            'Lemon Grove Duplex — Lincoln (Mr. Cooper)', 0),
  ('mortgage_cherryhill',         'Cherry Hill OKC (Arbor)',                 0),
  ('mortgage_weslaco',            'Weslaco TX (Plains Capital)',              0),
  ('mortgage_mcallen32',          'McAllen 32-Unit — McNorth (Freedom Bank)',0),
  ('mortgage_mcallen35',          'McAllen 35-Unit — Dove Cove',             0),
  ('insurance_transamerica_main', 'Transamerica (Main Policy)',               0),
  ('insurance_transamerica_mason','Transamerica (Mason Policy)',              0),
  ('insurance_prudential',        'Prudential',                               0),
  ('vehicle_sprinter_2025',       'Mercedes Sprinter AWD 2025',               0),
  ('vehicle_santafe_2017',        'Santa Fe Hyundai 2017',                    0),
  ('vehicle_priusc_2012',         'Toyota Prius C 2012',                      0);


-- =============================================================================
-- SEED: cfo_multifamily_valuations
-- Known syndication holdings with confirmed cap rates.
-- t12_noi and danyels_equity are seeded as 0 — Danyel enters actuals.
-- Passive syndications use invested capital as equity (see notes).
-- =============================================================================
INSERT INTO cfo_multifamily_valuations (property_name, ownership_pct, t12_noi, cap_rate, danyels_equity, notes) VALUES
  ('Cherry Hill OKC',    0.206,  0, 0.065, 0, NULL),
  ('Weslaco TX',         0.200,  0, 0.070, 0, NULL),
  ('McAllen TX',         0.350,  0, 0.065, 0, NULL),
  ('Dove Cove',          0.225,  0, 0.065, 0, NULL),
  ('Lubbock TX passive', NULL,   0, 0.065, 0, 'passive syndication — invested capital $50000, enter manually when UI is ready'),
  ('San Antonio TX passive', NULL, 0, 0.065, 0, 'passive syndication — invested capital $200000, enter manually when UI is ready');


-- =============================================================================
-- ROLLBACK
-- Run these statements in order to undo migration 021.
-- =============================================================================
-- DROP TABLE IF EXISTS cfo_multifamily_valuations;
-- DROP TABLE IF EXISTS cfo_projection_params;
-- DROP TABLE IF EXISTS cfo_manual_inputs;
-- DROP TABLE IF EXISTS cfo_recurring_charges;
-- DROP TABLE IF EXISTS cfo_liability_lines;
-- DROP TABLE IF EXISTS cfo_asset_lines;
-- DROP TABLE IF EXISTS cfo_snapshots;
-- DROP FUNCTION IF EXISTS public.cfo_set_updated_at();
