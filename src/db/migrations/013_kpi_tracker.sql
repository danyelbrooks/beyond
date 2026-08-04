-- Migration: 013_kpi_tracker
-- Creates the data layer for the monthly KPI tracking system.
-- care@bpmsd.com enters values once a month. All authenticated staff can read.
-- No delete policy exists on either table — rows can only be removed by explicit admin action.

-- ============================================================
-- TABLE: kpi_entries
-- One row per metric per month. Enforces uniqueness on
-- (reporting_month, category, metric_key) so re-running a seed
-- or a re-submit is always an upsert, never a duplicate.
-- ============================================================

CREATE TABLE IF NOT EXISTS kpi_entries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_month  date        NOT NULL,
  category         text        NOT NULL,
  metric_key       text        NOT NULL,
  metric_value     numeric,
  metric_text      text,
  entered_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporting_month, category, metric_key)
);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION kpi_entries_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kpi_entries_updated_at ON kpi_entries;
CREATE TRIGGER kpi_entries_updated_at
  BEFORE UPDATE ON kpi_entries
  FOR EACH ROW EXECUTE FUNCTION kpi_entries_set_updated_at();

-- ============================================================
-- TABLE: kpi_targets
-- Read-only reference data seeded below. The dashboard uses
-- this table to determine green / yellow / red status per metric.
-- ============================================================

CREATE TABLE IF NOT EXISTS kpi_targets (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  category         text    NOT NULL,
  metric_key       text    NOT NULL,
  display_name     text    NOT NULL,
  target_value     numeric,
  target_direction text    NOT NULL,
  target_label     text,
  display_order    integer NOT NULL DEFAULT 0,
  UNIQUE (category, metric_key)
);

-- ============================================================
-- SEED: kpi_targets
-- ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.
-- ============================================================

-- leasing
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('leasing', 'days_to_lease',        'Days to Lease',       14,   'below', '≤14 days',        1),
  ('leasing', 'vacancy_pct',          'Vacancy %',            5,   'below', '<5%',             2),
  ('leasing', 'move_in_gt_move_out',  'Move-Ins > Move-Outs', 1,   'above', 'Yes every month', 3),
  ('leasing', 'hold_pct',             'Hold %',               0.25, 'below', '<0.25%',          4),
  ('leasing', 'turnover_pct',         'Turnover %',           1.5, 'below', '<1.5%',           5)
ON CONFLICT (category, metric_key) DO NOTHING;

-- business_dev
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('business_dev', 'new_positive_reviews', 'New 5-Star Reviews',       10,  'above', '10+/month',    1),
  ('business_dev', 'new_units_signed',     'New Units Signed',         12,  'above', '12+/month',    2),
  ('business_dev', 'total_units_mgmt',     'Total Units Under Mgmt',  350,  'above', '350 by YE',    3),
  ('business_dev', 'google_rating',        'Google Rating',             4.5, 'above', '≥4.5',         4),
  ('business_dev', 'outgoing_units',       'Outgoing Units',            0,  'below', '0/month',      5)
ON CONFLICT (category, metric_key) DO NOTHING;

-- renewals
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('renewals', 'signed_lease_pct',  'Signed Lease %',  80, 'above', '>80%', 1),
  ('renewals', 'mtm_pct',           'Month-to-Month %',20, 'below', '<20%', 2),
  ('renewals', 'response_rate_pct', 'Response Rate',   90, 'above', '>90%', 3)
ON CONFLICT (category, metric_key) DO NOTHING;

-- delinquencies
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('delinquencies', 'non_payment_pct_of_units',   'Non-Payment % of Units',      2,     'below', '<2%',       1),
  ('delinquencies', 'delinquency_pct_of_revenue', 'Delinquency % of Revenue',    5,     'below', '<5%',       2),
  ('delinquencies', 'eom_balance',                'End-of-Month Balance ($)',  10000,   'below', '<$10,000',  3)
ON CONFLICT (category, metric_key) DO NOTHING;

-- maintenance
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('maintenance', 'days_to_complete',         'Days to Complete',          4,    'below', '≤4 days',      1),
  ('maintenance', 'pct_open_over_7_days',     'Open >7 Days %',           15,    'below', '<15%',         2),
  ('maintenance', 'vendor_acceptance_hours',  'Vendor Acceptance (hrs)',   4,    'below', '≤4 hours',     3),
  ('maintenance', 'resident_satisfaction',    'Resident Satisfaction',     4.0,  'above', '≥4.0',         4),
  ('maintenance', 'gael_open_work_orders',    'Gael — Open Work Orders',  50,    'below', '<50 open',     5),
  ('maintenance', 'gael_completed_this_month','Gael — Completed This Month', 0,  'above', 'track',        6)
ON CONFLICT (category, metric_key) DO NOTHING;

-- financials
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('financials', 'pm_profit_pct',        'PM Profit %',           32,  'above', '>32%',       1),
  ('financials', 'revenue_per_unit',     'Revenue Per Unit ($)',  380,  'above', '$380/unit',  2),
  ('financials', 'churn_pct',            'Annual Churn %',        10,  'below', '<10%',       3),
  ('financials', 'facilities_opex_pct',  'Facilities & OpEx %',   15,  'below', '<15%',       4),
  ('financials', 'dler',                 'DLER',                   4.0, 'above', '≥4.0',       5)
ON CONFLICT (category, metric_key) DO NOTHING;

-- celebration
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('celebration', 'resident_celebration', 'Resident Celebration',      1, 'above', '1/month', 1),
  ('celebration', 'owner_celebration',    'Owner Celebration',          1, 'above', '1/month', 2),
  ('celebration', 'vendor_celebration',   'Vendor Celebration',         1, 'above', '1/month', 3),
  ('celebration', 'team_celebration',     'Team Member Celebration',    1, 'above', '1/month', 4)
ON CONFLICT (category, metric_key) DO NOTHING;

-- wellness
INSERT INTO kpi_targets (category, metric_key, display_name, target_value, target_direction, target_label, display_order) VALUES
  ('wellness', 'units_milestone',  'Units Milestone',       500, 'above', '500 units',  1),
  ('wellness', 'rating_milestone', 'Google Rating Milestone', 4.5, 'above', '4.5 stars', 2)
ON CONFLICT (category, metric_key) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE kpi_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_targets ENABLE ROW LEVEL SECURITY;

-- kpi_entries: all authenticated users can read
CREATE POLICY kpi_entries_select
  ON kpi_entries FOR SELECT
  TO authenticated
  USING (true);

-- kpi_entries: only care@bpmsd.com can insert
CREATE POLICY kpi_entries_insert
  ON kpi_entries FOR INSERT
  TO authenticated
  WITH CHECK (auth.email() = 'care@bpmsd.com');

-- kpi_entries: only care@bpmsd.com can update
CREATE POLICY kpi_entries_update
  ON kpi_entries FOR UPDATE
  TO authenticated
  USING (auth.email() = 'care@bpmsd.com')
  WITH CHECK (auth.email() = 'care@bpmsd.com');

-- kpi_targets: all authenticated users can read; no write policies
CREATE POLICY kpi_targets_select
  ON kpi_targets FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- ROLLBACK (run to undo this migration)
-- ============================================================
-- DROP TRIGGER IF EXISTS kpi_entries_updated_at ON kpi_entries;
-- DROP FUNCTION IF EXISTS kpi_entries_set_updated_at();
-- DROP TABLE IF EXISTS kpi_entries;
-- DROP TABLE IF EXISTS kpi_targets;
