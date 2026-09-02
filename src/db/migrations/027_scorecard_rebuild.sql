-- 027_scorecard_rebuild.sql
-- Full rebuild of scorecard_metrics with the new 9-person roster.
-- Deactivates removed people so historical entries are preserved.
-- Adds property_group column so AppFolio auto-sync can filter by team.

-- ── Add property_group column (safe to re-run) ───────────────────────────────
ALTER TABLE scorecard_metrics ADD COLUMN IF NOT EXISTS property_group text;

-- ── Deactivate removed people (keeps their historical entries) ────────────────
UPDATE scorecard_metrics SET active = false
WHERE person_key IN ('laura', 'maria_a', 'bdm');

-- ── Delete and rebuild active people ─────────────────────────────────────────
DELETE FROM scorecard_metrics
WHERE person_key IN ('ana', 'rubin', 'mark', 'gael', 'ella', 'moira', 'claudette');

-- ── ANA (ana@ — COO-level metrics) ───────────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('ana','Ana','ana@bpmsd.com','lost_units',               'Lost Units',                    2,    'below','number',  'appfolio_lost_units', 1, NULL),
  ('ana','Ana','ana@bpmsd.com','vacancy_pct',              'Vacancy %',                     5,    'below','percent', NULL,                  2, NULL),
  ('ana','Ana','ana@bpmsd.com','review_average',           'Review Average (Google/Yelp)',   4.3,  'above','number',  'birdeye_rating',       3, NULL),
  ('ana','Ana','ana@bpmsd.com','five_star_reviews_needed', '5-Star Reviews Needed',          35,   'below','number',  NULL,                  4, NULL),
  ('ana','Ana','ana@bpmsd.com','dler',                     'DLER',                          4.0,  'above','number',  NULL,                  5, NULL),
  ('ana','Ana','ana@bpmsd.com','annual_churn',             'Annual Churn %',                10,   'below','percent', NULL,                  6, NULL),
  ('ana','Ana','ana@bpmsd.com','units_milestone',          'Units Milestone',               500,  'above','number',  NULL,                  7, NULL);

-- ── BEYOND (beyond@ — Green Team operations) ─────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('beyond','Green Team','beyond@bpmsd.com','days_on_market',         'Leasing Days on Market',          14,   'below','number',  'appfolio_days_on_market',           1, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','security_deposits_past_21','Security Deposits Past 21 Days', 0,    'below','number',  'appfolio_security_deposits_moveout',2, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','lease_renewals_up_to_date','Lease Renewals Up to Date',      100,  'above','percent', NULL,                                3, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','turning_points',          'Turning Points (Danyel Escalations)', 4, 'above','number', 'turning_points_email',             4, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','csr_one_and_done',        'CSR One and Done',                NULL, 'above','pass_fail',NULL,                               5, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','owner_health_at_risk',    'Owner Health — At-Risk Count',    0,    'below','number',  'owner_health',                      6, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','owner_updates_sunday',    'Owner Updates by Sunday 5pm',     NULL, 'above','pass_fail',NULL,                               7, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','resident_health_at_risk', 'Resident Health — At-Risk Count', 0,    'below','number',  'resident_health',                   8, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','resident_satisfaction',   'Resident Satisfaction',           4.0,  'above','number',  NULL,                                9, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','reviews_received',        'Reviews Received',                1,    'above','number',  NULL,                               10, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','review_request_sent',     'Review Request Sent',             1,    'above','number',  NULL,                               11, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','wo_days',                 'WO Days to Complete',             8,    'below','number',  NULL,                               12, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','wo_per_property',         'WO Per Property (excl. recurring)',1.25,'below','number',  'appfolio_wo',                      13, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','wo_calls_545',            '5-4-5 WO Calls',                 100,  'above','percent', NULL,                               14, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','open_7days_pct',          'Open >7 Days %',                  15,   'below','percent', NULL,                               15, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','vendor_acceptance',       'Vendor Acceptance (hours)',        4,    'below','number',  NULL,                               16, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','call_answer_rate',        'Call Answer Rate',                90,   'above','percent', NULL,                               17, 'green_team'),
  ('beyond','Green Team','beyond@bpmsd.com','tasks',                   'Tasks',                           40,   'below','number',  NULL,                               18, 'green_team');

-- ── RUBIN (help@ — Yellow Team) ───────────────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('rubin','Yellow Team','help@bpmsd.com','owner_health_at_risk',    'Owner Health — At-Risk Count',    0,    'below','number',  'owner_health',                       1, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','owner_updates_sunday',    'Owner Updates by Sunday 5pm',     NULL, 'above','pass_fail',NULL,                                2, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','csr_one_and_done',        'CSR One and Done',                NULL, 'above','pass_fail',NULL,                                3, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','security_deposits_past_21','Security Deposits Past 21 Days', 0,    'below','number',  'appfolio_security_deposits_moveout', 4, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','lease_renewals_up_to_date','Lease Renewals Up to Date',      100,  'above','percent', NULL,                                5, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','vacancy_pct',             'Vacancy %',                       5,    'below','percent', NULL,                                6, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','days_on_market',          'Leasing Days on Market',          14,   'below','number',  'appfolio_days_on_market',            7, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','resident_health_at_risk', 'Resident Health — At-Risk Count', 0,    'below','number',  'resident_health',                    8, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','resident_satisfaction',   'Resident Satisfaction',           4.0,  'above','number',  NULL,                                9, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','reviews_received',        'Reviews Received',                1,    'above','number',  NULL,                               10, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','review_request_sent',     'Review Request Sent',             1,    'above','number',  NULL,                               11, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','wo_days',                 'WO Days to Complete',             8,    'below','number',  NULL,                               12, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','wo_per_property',         'WO Per Property (excl. recurring)',1.25,'below','number',  'appfolio_wo',                       13, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','wo_calls_545',            '5-4-5 WO Calls',                 100,  'above','percent', NULL,                               14, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','open_7days_pct',          'Open >7 Days %',                  15,   'below','percent', NULL,                               15, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','vendor_acceptance',       'Vendor Acceptance (hours)',        4,    'below','number',  NULL,                               16, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','turning_points',          'Turning Points (Danyel Escalations)', 0,'below','number', 'turning_points_email',              17, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','call_answer_rate',        'Call Answer Rate',                90,   'above','percent', NULL,                               18, 'yellow_team'),
  ('rubin','Yellow Team','help@bpmsd.com','tasks',                   'Tasks',                           40,   'below','number',  NULL,                               19, 'yellow_team');

-- ── MARK (success@ — Blue Team) ───────────────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('mark','Blue Team','success@bpmsd.com','wo_days',                 'WO Days to Complete',             8,    'below','number',  NULL,                                1, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','wo_per_property',         'WO Per Property (excl. recurring)',1.25,'below','number',  'appfolio_wo',                       2, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','wo_calls_545',            '5-4-5 WO Calls',                 100,  'above','percent', NULL,                                3, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','open_7days_pct',          'Open >7 Days %',                  15,   'below','percent', NULL,                                4, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','vendor_acceptance',       'Vendor Acceptance (hours)',        4,    'below','number',  NULL,                                5, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','turning_points',          'Turning Points (Danyel Escalations)', 0,'below','number', 'turning_points_email',               6, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','reviews_received',        'Reviews Received',                1,    'above','number',  NULL,                                7, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','review_request_sent',     'Review Request Sent',             1,    'above','number',  NULL,                                8, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','csr_one_and_done',        'CSR One and Done',                NULL, 'above','pass_fail',NULL,                                9, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','security_deposits_past_21','Security Deposits Past 21 Days', 0,    'below','number',  'appfolio_security_deposits_moveout',10, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','lease_renewals_up_to_date','Lease Renewals Up to Date',      100,  'above','percent', NULL,                               11, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','vacancy_pct',             'Vacancy %',                       5,    'below','percent', NULL,                               12, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','days_on_market',          'Leasing Days on Market',          14,   'below','number',  'appfolio_days_on_market',           13, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','resident_health_at_risk', 'Resident Health — At-Risk Count', 0,    'below','number',  'resident_health',                   14, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','resident_satisfaction',   'Resident Satisfaction',           4.0,  'above','number',  NULL,                               15, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','owner_health_at_risk',    'Owner Health — At-Risk Count',    0,    'below','number',  'owner_health',                     16, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','owner_updates_sunday',    'Owner Updates by Sunday 5pm',     NULL, 'above','pass_fail',NULL,                              17, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','call_answer_rate',        'Call Answer Rate',                90,   'above','percent', NULL,                               18, 'blue_team'),
  ('mark','Blue Team','success@bpmsd.com','tasks',                   'Tasks',                           40,   'below','number',  NULL,                               19, 'blue_team');

-- ── GAEL (home@ — Turnover / Make-Ready) ─────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('gael','Gael','home@bpmsd.com','wo_open',               'Recurring Work Orders Open',      50,   'below','number',  NULL,                         1, NULL),
  ('gael','Gael','home@bpmsd.com','days_on_market',        'Leasing Days on Market',          14,   'below','number',  'appfolio_days_on_market',    2, NULL),
  ('gael','Gael','home@bpmsd.com','reviews_received',      'Reviews Received',                1,    'above','number',  NULL,                         3, NULL),
  ('gael','Gael','home@bpmsd.com','review_request_sent',   'Review Request Sent',             1,    'above','number',  NULL,                         4, NULL),
  ('gael','Gael','home@bpmsd.com','hello_inbox_under_10',  'Hello@ Has Less Than 10 Emails',  NULL, 'above','pass_fail',NULL,                        5, NULL),
  ('gael','Gael','home@bpmsd.com','csr_one_and_done',      'CSR One and Done',                NULL, 'above','pass_fail',NULL,                        6, NULL),
  ('gael','Gael','home@bpmsd.com','rent_engine_answer',    'Rent Engine Call Answer Rate',    100,  'above','percent', NULL,                         7, NULL),
  ('gael','Gael','home@bpmsd.com','call_answer_rate',      'Call Answer Rate',                90,   'above','percent', NULL,                         8, NULL),
  ('gael','Gael','home@bpmsd.com','tasks',                 'Tasks',                           40,   'below','number',  NULL,                         9, NULL),
  ('gael','Gael','home@bpmsd.com','emails',                'Emails',                          NULL, 'below','number',  'email_count',               10, NULL);

-- ── ELLA (admin@ — Accounting) ───────────────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('ella','Ella','admin@bpmsd.com','smartbills_24hr',    'SmartBills Processed Within 24hrs', 100, 'above','percent', NULL,          1, NULL),
  ('ella','Ella','admin@bpmsd.com','non_payment_pct',    'Non-Payment % of Units',              2,  'below','percent', NULL,          2, NULL),
  ('ella','Ella','admin@bpmsd.com','delinquency_pct',    'Delinquency % of Revenue',            5,  'below','percent', NULL,          3, NULL),
  ('ella','Ella','admin@bpmsd.com','one_and_done',       'One and Done',                      NULL, 'above','pass_fail',NULL,         4, NULL),
  ('ella','Ella','admin@bpmsd.com','owner_packets',      'Owner Packets',                      100, 'above','percent', NULL,          5, NULL),
  ('ella','Ella','admin@bpmsd.com','call_answer_rate',   'Call Answer Rate',                    90, 'above','percent', NULL,          6, NULL),
  ('ella','Ella','admin@bpmsd.com','tasks',              'Tasks',                              100, 'below','number',  NULL,          7, NULL),
  ('ella','Ella','admin@bpmsd.com','emails',             'Emails',                              30, 'below','number',  'email_count', 8, NULL);

-- ── MOIRA (accounts@ — Executive Assistant) ───────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('moira','Moira','accounts@bpmsd.com','qb_bpm_reconciled',  'QB BPM Reconciled',               100,  'above','pass_fail',NULL,          1, NULL),
  ('moira','Moira','accounts@bpmsd.com','qb_nw_reconciled',   'QB NW Reconciled',                100,  'above','pass_fail',NULL,          2, NULL),
  ('moira','Moira','accounts@bpmsd.com','insurance',          'Insurance',                       100,  'above','percent', NULL,          3, NULL),
  ('moira','Moira','accounts@bpmsd.com','yearly_inspections', 'Yearly Inspections Past 30 Days', 100,  'above','percent', NULL,          4, NULL),
  ('moira','Moira','accounts@bpmsd.com','reviews_responded',  'Reviews Responded To',            100,  'above','percent', NULL,          5, NULL),
  ('moira','Moira','accounts@bpmsd.com','kpi_meetings',       'KPI Team Meetings',               NULL, 'above','pass_fail',NULL,         6, NULL),
  ('moira','Moira','accounts@bpmsd.com','csr_one_and_done',   'CSR One and Done',                NULL, 'above','pass_fail',NULL,         7, NULL),
  ('moira','Moira','accounts@bpmsd.com','team_total_emails',  'Team Total Emails',               100,  'below','number',  NULL,          8, NULL),
  ('moira','Moira','accounts@bpmsd.com','team_total_tasks',   'Team Total Tasks',                100,  'below','number',  NULL,          9, NULL),
  ('moira','Moira','accounts@bpmsd.com','call_answer_rate',   'Call Answer Rate',                90,   'above','percent', NULL,         10, NULL),
  ('moira','Moira','accounts@bpmsd.com','emails',             'Emails',                          NULL, 'below','number',  'email_count',11, NULL);

-- ── CLAUDETTE (care@ — KPI Admin) ────────────────────────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('claudette','Claudette','care@bpmsd.com','google_reviews_sd',  'Google Reviews BPM San Diego', NULL, 'above','number',  NULL, 1, NULL),
  ('claudette','Claudette','care@bpmsd.com','google_reviews_enc', 'Google Reviews BPM Encinitas', NULL, 'above','number',  NULL, 2, NULL),
  ('claudette','Claudette','care@bpmsd.com','kpi_sheet_update',   'KPI Sheet Updated',            NULL, 'above','pass_fail',NULL,3, NULL),
  ('claudette','Claudette','care@bpmsd.com','backend_processes',  'Back End Processes',           NULL, 'above','pass_fail',NULL,4, NULL),
  ('claudette','Claudette','care@bpmsd.com','insurance_owners',   'Insurance for Owners',         100,  'above','percent', NULL, 5, NULL),
  ('claudette','Claudette','care@bpmsd.com','insurance_tenants',  'Insurance for Tenants',        100,  'above','percent', NULL, 6, NULL);

-- ── NAYELIE (info@ — Business Development Manager) ───────────────────────────
INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('nayelie','Nayelie','info@bpmsd.com','onboarded',        'New Units Onboarded',     3,    'above','number',  NULL,          1, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','new_units_signed', 'New Units Signed',        12,   'above','number',  NULL,          2, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','total_units_mgmt', 'Total Units Under Mgmt',  350,  'above','number',  NULL,          3, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','response_15min',   'Response Time <15 Min',   75,   'above','percent', NULL,          4, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','outbound_calls',   '25 Outbound Calls/Day',   125,  'above','number',  NULL,          5, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','call_answer_rate', 'Call Answer Rate',         95,   'above','percent', NULL,          6, NULL),
  ('nayelie','Nayelie','info@bpmsd.com','emails',           'Emails',                  NULL, 'below','number',  'email_count', 7, NULL);
