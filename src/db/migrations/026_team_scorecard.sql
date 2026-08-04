-- 026_team_scorecard.sql
-- EOS Traction-style weekly team scorecard.
-- Two tables: scorecard_metrics (what each person tracks) and
-- scorecard_entries (the weekly values). Safe to re-run — all
-- CREATE statements use IF NOT EXISTS; seeds use ON CONFLICT DO NOTHING.

-- ============================================================
-- TABLE: scorecard_metrics
-- One row per person per KPI. Defines goals and data sources.
-- ============================================================

CREATE TABLE IF NOT EXISTS scorecard_metrics (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  person_key     text    NOT NULL,
  person_name    text    NOT NULL,
  person_email   text,
  metric_key     text    NOT NULL,
  metric_label   text    NOT NULL,
  goal_value     numeric,
  goal_direction text    NOT NULL DEFAULT 'below',  -- 'above' or 'below'
  goal_label     text,
  value_type     text    NOT NULL DEFAULT 'number', -- 'number', 'percent', 'pass_fail'
  auto_source    text,   -- 'email_count', 'appfolio_rent', 'appfolio_wo',
                         -- 'appfolio_security_deposits', 'appfolio_turning_points',
                         -- 'appfolio_days_on_market', 'resident_health', 'owner_health',
                         -- NULL = manual
  display_order  integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (person_key, metric_key)
);

-- ============================================================
-- TABLE: scorecard_entries
-- Weekly values — one row per person per metric per week.
-- week_start is always the Monday of that week.
-- ============================================================

CREATE TABLE IF NOT EXISTS scorecard_entries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start   date        NOT NULL,
  person_key   text        NOT NULL,
  metric_key   text        NOT NULL,
  value        numeric,
  value_text   text,                  -- for pass/fail: 'pass' or 'fail'
  is_auto      boolean     NOT NULL DEFAULT false,
  entered_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, person_key, metric_key)
);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION scorecard_entries_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scorecard_entries_updated_at ON scorecard_entries;
CREATE TRIGGER scorecard_entries_updated_at
  BEFORE UPDATE ON scorecard_entries
  FOR EACH ROW EXECUTE FUNCTION scorecard_entries_set_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE scorecard_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE scorecard_entries ENABLE ROW LEVEL SECURITY;

-- scorecard_metrics: all authenticated can SELECT
DROP POLICY IF EXISTS scorecard_metrics_select ON scorecard_metrics;
CREATE POLICY scorecard_metrics_select
  ON scorecard_metrics FOR SELECT
  TO authenticated
  USING (true);

-- scorecard_metrics: only admin role can INSERT
DROP POLICY IF EXISTS scorecard_metrics_insert ON scorecard_metrics;
CREATE POLICY scorecard_metrics_insert
  ON scorecard_metrics FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- scorecard_metrics: only admin role can UPDATE
DROP POLICY IF EXISTS scorecard_metrics_update ON scorecard_metrics;
CREATE POLICY scorecard_metrics_update
  ON scorecard_metrics FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- scorecard_entries: all authenticated can SELECT
DROP POLICY IF EXISTS scorecard_entries_select ON scorecard_entries;
CREATE POLICY scorecard_entries_select
  ON scorecard_entries FOR SELECT
  TO authenticated
  USING (true);

-- scorecard_entries: all authenticated can INSERT (team enters their own numbers)
DROP POLICY IF EXISTS scorecard_entries_insert ON scorecard_entries;
CREATE POLICY scorecard_entries_insert
  ON scorecard_entries FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- scorecard_entries: all authenticated can UPDATE
DROP POLICY IF EXISTS scorecard_entries_update ON scorecard_entries;
CREATE POLICY scorecard_entries_update
  ON scorecard_entries FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- SEED: scorecard_metrics
-- ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.
-- ============================================================

-- ── ANA (beyond@bpmsd.com) ──────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('ana', 'Ana', 'beyond@bpmsd.com', 'lost_units',               'Lost Units',                      2,    'below', 'number',   NULL,                         1),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'review_average',           'Review Average (Google/Yelp)',     4.3,  'above', 'number',   NULL,                         2),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'five_star_reviews_needed', '5-Star Reviews Needed',            35,   'below', 'number',   NULL,                         3),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'nps_score',                'NPS Score',                        NULL, 'above', 'number',   NULL,                         4),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'turning_points',           'Turning Points',                   4,    'above', 'number',   'appfolio_turning_points',    5),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'security_deposits_past_21','Security Deposits Past 21 Days',   0,    'below', 'number',   'appfolio_security_deposits', 6),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'team_total_emails',        'Team Total Emails',                100,  'below', 'number',   'email_count',                7),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'team_total_tasks',         'Team Total Tasks',                 100,  'below', 'number',   NULL,                         8),
  ('ana', 'Ana', 'beyond@bpmsd.com', 'csr_one_and_done',         'CSR One and Done',                 NULL, 'above', 'pass_fail',NULL,                         9)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── MAHALAH ─────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('mahalah', 'Mahalah', NULL, 'rent_collected', 'Rent Collected %',   90, 'above', 'percent', 'appfolio_rent', 1),
  ('mahalah', 'Mahalah', NULL, 'answer_rate',    'Call Answer Rate',    80, 'above', 'percent', NULL,            2),
  ('mahalah', 'Mahalah', NULL, 'tasks',          'Tasks',               40, 'below', 'number',  NULL,            3)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── ELLA (admin@bpmsd.com) ──────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('ella', 'Ella', 'admin@bpmsd.com', 'call_answer_rate', 'Dialpad Call Answer Rate', 90,   'above', 'percent',  NULL,          1),
  ('ella', 'Ella', 'admin@bpmsd.com', 'smartbills_24hr',  'SmartBills 24 Hours',      100,  'above', 'percent',  NULL,          2),
  ('ella', 'Ella', 'admin@bpmsd.com', 'tasks',            'Tasks',                    30,   'below', 'number',   NULL,          3),
  ('ella', 'Ella', 'admin@bpmsd.com', 'emails',           'Emails',                   30,   'below', 'number',   'email_count', 4),
  ('ella', 'Ella', 'admin@bpmsd.com', 'csr_one_and_done', 'CSR One and Done',         NULL, 'above', 'pass_fail',NULL,          5)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── JERMAINE ────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('jermaine', 'Jermaine', NULL, 'wo_calls_545',   '5-4-5 WO Calls',           100,  'above', 'percent', NULL,          1),
  ('jermaine', 'Jermaine', NULL, 'wo_per_property','Work Orders Per Property',  1.25, 'below', 'number',  'appfolio_wo', 2),
  ('jermaine', 'Jermaine', NULL, 'repair_speed',   'Repair Speed',              NULL, 'below', 'number',  NULL,          3),
  ('jermaine', 'Jermaine', NULL, 'tasks',          'Tasks',                     40,   'below', 'number',  NULL,          4)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── ELLEN ───────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('ellen', 'Ellen', NULL, 'days_on_market',  'Leasing Days on Market',     14,   'below', 'number',   'appfolio_days_on_market', 1),
  ('ellen', 'Ellen', NULL, 'app_to_lease',    'Application to Lease Time',  4,    'below', 'number',   NULL,                      2),
  ('ellen', 'Ellen', NULL, 'call_answer_rate','Dialpad Call Answer Rate',    90,   'above', 'percent',  NULL,                      3),
  ('ellen', 'Ellen', NULL, 'fb_marketplace',  'FB Marketplace <4 Days Old', 100,  'above', 'pass_fail',NULL,                      4),
  ('ellen', 'Ellen', NULL, 'codebox_accurate','Codebox Sheet Accurate',      100,  'above', 'pass_fail',NULL,                      5),
  ('ellen', 'Ellen', NULL, 'go_to_property_21','21-Day Go to Property',      21,   'below', 'number',   NULL,                      6)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── KENDRA ──────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('kendra', 'Kendra', NULL, 'days_on_market',   'Leasing Days on Market',     15,   'below', 'number',   'appfolio_days_on_market', 1),
  ('kendra', 'Kendra', NULL, 'app_to_lease',     'Application to Lease Time',  NULL, 'below', 'number',   NULL,                      2),
  ('kendra', 'Kendra', NULL, 'call_answer_rate',  'Dialpad Call Answer Rate',   NULL, 'above', 'percent',  NULL,                      3),
  ('kendra', 'Kendra', NULL, 'fb_marketplace',   'FB Marketplace <4 Days Old', NULL, 'above', 'pass_fail',NULL,                      4),
  ('kendra', 'Kendra', NULL, 'csr_one_and_done', 'CSR One and Done',           NULL, 'above', 'pass_fail',NULL,                      5),
  ('kendra', 'Kendra', NULL, 'codebox_accurate',  'Codebox Sheet Accurate',     NULL, 'above', 'pass_fail',NULL,                      6),
  ('kendra', 'Kendra', NULL, 'go_to_property_21','21-Day Go to Property',       NULL, 'below', 'number',   NULL,                      7)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── MARK (success@bpmsd.com) ────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('mark', 'Mark', 'success@bpmsd.com', 'wo_calls_545',   '5-4-5 WO Calls',           100,  'above', 'percent',  NULL,          1),
  ('mark', 'Mark', 'success@bpmsd.com', 'wo_per_property','Work Orders Per Property',  1.25, 'below', 'number',   'appfolio_wo', 2),
  ('mark', 'Mark', 'success@bpmsd.com', 'wo_days',        'WO Days to Complete',       8,    'below', 'number',   NULL,          3),
  ('mark', 'Mark', 'success@bpmsd.com', 'tasks',          'Tasks',                     40,   'below', 'number',   NULL,          4),
  ('mark', 'Mark', 'success@bpmsd.com', 'call_answer_rate','Dialpad Call Answer Rate',  80,   'above', 'percent',  NULL,          5),
  ('mark', 'Mark', 'success@bpmsd.com', 'csr_one_and_done','CSR One and Done',          NULL, 'above', 'pass_fail',NULL,          6),
  ('mark', 'Mark', 'success@bpmsd.com', 'reviews_received','Reviews Received',           1,    'above', 'number',   NULL,          7)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── LAURA (results@bpmsd.com) ───────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('laura', 'Laura', 'results@bpmsd.com', 'rent_collected',       'Rent Collected %',               90,   'above', 'percent',  'appfolio_rent',   1),
  ('laura', 'Laura', 'results@bpmsd.com', 'call_answer_rate',     'Dialpad Call Answer Rate',       NULL, 'above', 'percent',  NULL,              2),
  ('laura', 'Laura', 'results@bpmsd.com', 'tasks',                'Tasks',                          NULL, 'below', 'number',   NULL,              3),
  ('laura', 'Laura', 'results@bpmsd.com', 'response_24hr',        '24-Hour Response Time',          NULL, 'below', 'pass_fail',NULL,              4),
  ('laura', 'Laura', 'results@bpmsd.com', 'review_requested',     'Review Requested (BirdEye)',     NULL, 'above', 'number',   NULL,              5),
  ('laura', 'Laura', 'results@bpmsd.com', 'emails',               'Emails',                         NULL, 'below', 'number',   'email_count',     6),
  ('laura', 'Laura', 'results@bpmsd.com', 'owner_updates',        'Owner Updates',                  NULL, 'above', 'pass_fail',NULL,              7),
  ('laura', 'Laura', 'results@bpmsd.com', 'resident_health_score','Resident Health — At-Risk Count',0,    'below', 'number',   'resident_health', 8)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── MARIA A (manager@bpmsd.com) ─────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'call_answer_rate',   'Dialpad Call Answer Rate',      90,   'above', 'percent',  NULL,          1),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'insurance_owners',   'Insurance for Owners',          100,  'above', 'percent',  NULL,          2),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'csr_one_and_done',   'CSR One and Done',              NULL, 'above', 'pass_fail',NULL,          3),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'insurance_tenants',  'Insurance for Tenants',         100,  'above', 'percent',  NULL,          4),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'tasks',              'Tasks',                         100,  'below', 'number',   NULL,          5),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'rent_engine_answer', 'Rent Engine Call Answer Rate',  100,  'above', 'percent',  NULL,          6),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'owner_packets',      'Owner Packets',                 100,  'above', 'percent',  NULL,          7),
  ('maria_a', 'Maria A', 'manager@bpmsd.com', 'emails',             'Emails',                        NULL, 'below', 'number',   'email_count', 8)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── MARIA E ─────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('maria_e', 'Maria E', NULL, 'turning_points',            'Turning Points',                 1,    'above', 'number',   'appfolio_turning_points',    1),
  ('maria_e', 'Maria E', NULL, 'owner_statements',          'All Owner Statements Sent',      NULL, 'above', 'pass_fail',NULL,                         2),
  ('maria_e', 'Maria E', NULL, 'wo_first_30_days',          'WO in First 30 Days',            1,    'below', 'number',   NULL,                         3),
  ('maria_e', 'Maria E', NULL, 'security_deposits_past_21', 'Security Deposits Past 21 Days', 0,    'below', 'number',   'appfolio_security_deposits', 4),
  ('maria_e', 'Maria E', NULL, 'tasks',                     'Tasks',                          NULL, 'below', 'number',   NULL,                         5)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── MOIRA (accounts@bpmsd.com) ──────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('moira', 'Moira', 'accounts@bpmsd.com', 'yearly_inspections','Yearly Inspections Past 30 Days',100,  'above', 'percent',  NULL,          1),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'qb_bpm_reconciled', 'QB BPM Reconciled',              100,  'above', 'pass_fail',NULL,          2),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'insurance',         'Insurance',                       100,  'above', 'percent',  NULL,          3),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'qb_nw_reconciled',  'QB NW Reconciled',                100,  'above', 'pass_fail',NULL,          4),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'csr_one_and_done',  'CSR One and Done',                NULL, 'above', 'pass_fail',NULL,          5),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'reviews_responded', 'Reviews Responded To',            100,  'above', 'percent',  NULL,          6),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'call_answer_rate',  'Dialpad Call Answer Rate',        90,   'above', 'percent',  NULL,          7),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'kpi_meetings',      'KPI Team Meetings',               100,  'above', 'pass_fail',NULL,          8),
  ('moira', 'Moira', 'accounts@bpmsd.com', 'emails',            'Emails',                          NULL, 'below', 'number',   'email_count', 9)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── BDM (info@bpmsd.com) ────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('bdm', 'BDM', 'info@bpmsd.com', 'onboarded',       'New Units Onboarded',      3,    'above', 'number',  NULL,          1),
  ('bdm', 'BDM', 'info@bpmsd.com', 'response_15min',  'Response Time <15 Min',    75,   'above', 'percent', NULL,          2),
  ('bdm', 'BDM', 'info@bpmsd.com', 'outbound_calls',  '25 Outbound Calls/Day',    125,  'above', 'number',  NULL,          3),
  ('bdm', 'BDM', 'info@bpmsd.com', 'emails',          'Emails',                   NULL, 'below', 'number',  'email_count', 4)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── RUBIN (help@bpmsd.com) ──────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('rubin', 'Rubin', 'help@bpmsd.com', 'tasks',                'Tasks',                         100,  'below', 'number',   NULL,           1),
  ('rubin', 'Rubin', 'help@bpmsd.com', 'emails',               'Emails',                        100,  'below', 'number',   'email_count',  2),
  ('rubin', 'Rubin', 'help@bpmsd.com', 'call_answer_rate',     'Dialpad Call Answer Rate',      90,   'above', 'percent',  NULL,           3),
  ('rubin', 'Rubin', 'help@bpmsd.com', 'owner_updates_sunday', 'Owner Updates by Sunday 5pm',   100,  'above', 'pass_fail',NULL,           4),
  ('rubin', 'Rubin', 'help@bpmsd.com', 'csr_one_and_done',     'CSR One and Done',              NULL, 'above', 'pass_fail',NULL,           5),
  ('rubin', 'Rubin', 'help@bpmsd.com', 'owner_health_at_risk', 'Owner Health — At-Risk Count',  0,    'below', 'number',   'owner_health', 6)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── CLAUDETTE ───────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('claudette', 'Claudette', NULL, 'google_reviews_sd',  'Google Reviews BPM San Diego', NULL, 'above', 'number',   NULL, 1),
  ('claudette', 'Claudette', NULL, 'google_reviews_enc', 'Google Reviews BPM Encinitas', NULL, 'above', 'number',   NULL, 2),
  ('claudette', 'Claudette', NULL, 'kpi_sheet_update',   'KPI Sheet Updated',            NULL, 'above', 'pass_fail',NULL, 3),
  ('claudette', 'Claudette', NULL, 'backend_processes',  'Back End Processes',           NULL, 'above', 'pass_fail',NULL, 4)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── GAEL (home@bpmsd.com) ───────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('gael', 'Gael', 'home@bpmsd.com', 'wo_open', 'Work Orders Open', 50,   'below', 'number', NULL,          1),
  ('gael', 'Gael', 'home@bpmsd.com', 'emails',  'Emails',           NULL, 'below', 'number', 'email_count', 2)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── PAUL ────────────────────────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order) VALUES
  ('paul', 'Paul', NULL, 'lease_renewals', 'Lease Renewals Up to Date', 100, 'above', 'percent', NULL, 1)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ============================================================
-- ROLLBACK (run to undo this migration)
-- ============================================================
-- DROP TRIGGER IF EXISTS scorecard_entries_updated_at ON scorecard_entries;
-- DROP FUNCTION IF EXISTS scorecard_entries_set_updated_at();
-- DROP TABLE IF EXISTS scorecard_entries;
-- DROP TABLE IF EXISTS scorecard_metrics;

-- ============================================================
-- MIGRATION 026 PATCH 1 — Scorecard Updates
-- ============================================================

-- ── CHANGE 4: Remove departed team members ──────────────────
DELETE FROM scorecard_metrics WHERE person_key IN ('mahalah', 'jermaine', 'ellen', 'kendra');

-- ── CHANGE 5: Ana updates ───────────────────────────────────
DELETE FROM scorecard_metrics WHERE person_key = 'ana' AND metric_key = 'nps_score';

INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order)
VALUES ('ana', 'Ana', 'beyond@bpmsd.com', 'lease_renewals_up_to_date', 'Lease Renewals Up to Date', 100, 'above', 'percent', NULL, 10)
ON CONFLICT (person_key, metric_key) DO NOTHING;

UPDATE scorecard_metrics SET
  metric_label = 'Turning Points (Unhappy Residents + Owners)',
  auto_source  = NULL
WHERE person_key = 'ana' AND metric_key = 'turning_points';

UPDATE scorecard_metrics SET auto_source = 'appfolio_security_deposits_moveout'
WHERE person_key = 'ana' AND metric_key = 'security_deposits_past_21';

UPDATE scorecard_metrics SET auto_source = 'appfolio_lost_units'
WHERE person_key = 'ana' AND metric_key = 'lost_units';

UPDATE scorecard_metrics SET auto_source = 'birdeye_rating'
WHERE person_key = 'ana' AND metric_key = 'review_average';

UPDATE scorecard_metrics SET auto_source = 'leadsimple_email_count'
WHERE person_key = 'ana' AND metric_key = 'team_total_emails';

UPDATE scorecard_metrics SET auto_source = 'leadsimple_task_count'
WHERE person_key = 'ana' AND metric_key = 'team_total_tasks';

-- ── CHANGE 6: Mark updates ──────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order)
VALUES
  ('mark', 'Mark', 'success@bpmsd.com', 'turning_points', 'Turning Points (Unhappy Residents + Owners)', 0, 'below', 'number', NULL, 8),
  ('mark', 'Mark', 'success@bpmsd.com', 'review_pulled',  'Review Request Sent',                         1, 'above', 'number', NULL, 9)
ON CONFLICT (person_key, metric_key) DO NOTHING;

UPDATE scorecard_metrics SET metric_label = 'WO Per Property (excl. recurring)'
WHERE person_key = 'mark' AND metric_key = 'wo_per_property';

UPDATE scorecard_metrics SET auto_source = 'leadsimple_task_count'
WHERE person_key = 'mark' AND metric_key = 'tasks';

UPDATE scorecard_metrics SET metric_label = '5-4-5 WO Calls (self-reported)'
WHERE person_key = 'mark' AND metric_key = 'wo_calls_545';

-- ── CHANGE 7: Laura updates ─────────────────────────────────
DELETE FROM scorecard_metrics WHERE person_key = 'laura' AND metric_key = 'owner_updates';

INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order)
VALUES
  ('laura', 'Laura', 'results@bpmsd.com', 'days_on_market',     'Leasing Days on Market',       14,  'below', 'number',  'appfolio_days_on_market', 9),
  ('laura', 'Laura', 'results@bpmsd.com', 'rent_engine_answer', 'Rent Engine Call Answer Rate', 100,  'above', 'percent', NULL,                      10)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── CHANGE 8: Maria A — display name update ─────────────────
UPDATE scorecard_metrics SET
  person_name  = 'Manager@',
  person_email = 'manager@bpmsd.com'
WHERE person_key = 'maria_a';

-- ── CHANGE 9: Gael updates ──────────────────────────────────
INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order)
VALUES
  ('gael', 'Gael', 'home@bpmsd.com', 'call_answer_rate', 'Dialpad Call Answer Rate', 90, 'above', 'percent', NULL, 3),
  ('gael', 'Gael', 'home@bpmsd.com', 'tasks',            'Tasks',                    40, 'below', 'number',  NULL, 4),
  ('gael', 'Gael', 'home@bpmsd.com', 'reviews_received', 'Reviews Received',          1, 'above', 'number',  NULL, 5)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── CHANGE 10: Ella — replace all metrics (offboarding/bookkeeper role) ─
DELETE FROM scorecard_metrics WHERE person_key = 'ella';

INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, value_type, auto_source, display_order)
VALUES
  ('ella', 'Ella', 'admin@bpmsd.com', 'security_deposits_returned', 'Security Deposits Returned on Time', 100, 'above', 'percent', NULL,          1),
  ('ella', 'Ella', 'admin@bpmsd.com', 'final_statements_sent',      'Final Owner Statements Sent',        100, 'above', 'percent', NULL,          2),
  ('ella', 'Ella', 'admin@bpmsd.com', 'move_out_inspections',       'Move-Out Inspections Completed',     100, 'above', 'percent', NULL,          3),
  ('ella', 'Ella', 'admin@bpmsd.com', 'smartbills_24hr',            'SmartBills Processed Within 24hrs',  100, 'above', 'percent', NULL,          4),
  ('ella', 'Ella', 'admin@bpmsd.com', 'offboarding_packets',        'Offboarding Packets Sent',           100, 'above', 'percent', NULL,          5),
  ('ella', 'Ella', 'admin@bpmsd.com', 'tasks',                      'Tasks',                               30, 'below', 'number',  NULL,          6),
  ('ella', 'Ella', 'admin@bpmsd.com', 'emails',                     'Emails',                              30, 'below', 'number',  'email_count', 7);

-- ── CHANGE 1: Turning Points — pull from email_cache ───────────────────────
UPDATE scorecard_metrics
SET auto_source   = 'turning_points_email',
    metric_label  = 'Turning Points (Danyel Escalations)'
WHERE metric_key = 'turning_points';

-- ── CHANGE 2: WO in First 30 Days — move from Maria A/E to Gael ───────────
DELETE FROM scorecard_metrics
WHERE metric_key = 'wo_first_30_days' AND person_key IN ('maria_a', 'maria_e');

INSERT INTO scorecard_metrics (person_key, person_name, person_email, metric_key, metric_label, goal_value, goal_direction, goal_label, value_type, auto_source, display_order)
VALUES ('gael', 'Gael', 'home@bpmsd.com', 'wo_first_30_days', 'WO in First 30 Days', 1, 'below', '<1', 'number', NULL, 5)
ON CONFLICT (person_key, metric_key) DO NOTHING;

-- ── CHANGE 3: Ella — keep only smartbills_24hr, tasks, emails ─────────────
DELETE FROM scorecard_metrics
WHERE person_key = 'ella' AND metric_key NOT IN ('smartbills_24hr', 'tasks', 'emails');

-- ── CHANGE 11: Remove Maria E and Paul ─────────────────────────────────────
DELETE FROM scorecard_metrics WHERE person_key IN ('maria_e', 'paul');

-- ── CHANGE 12: Fix Claudette display name and email ────────────────────────
UPDATE scorecard_metrics
SET person_name  = 'Claudette',
    person_email = 'care@bpmsd.com'
WHERE person_key = 'claudette';
