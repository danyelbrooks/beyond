-- 028_owner_call_kpi.sql
-- Adds Owner Calls This Week metric to Green, Yellow, and Blue team scorecards.
-- Goal: 25 new (never-called) owners per PM per week (5/day × 5 days).
-- Populated automatically from LeadSimple outbound calls to AppFolio owner phones.

INSERT INTO scorecard_metrics
  (person_key, person_name, person_email, metric_key, metric_label,
   goal_value, goal_direction, value_type, auto_source, display_order, property_group)
VALUES
  ('beyond','Green Team','beyond@bpmsd.com','owner_calls_this_week','Owner Calls (New)',
   25, 'above', 'number', 'leadsimple_owner_calls', 19, 'green_team'),
  ('rubin', 'Yellow Team','help@bpmsd.com', 'owner_calls_this_week','Owner Calls (New)',
   25, 'above', 'number', 'leadsimple_owner_calls', 20, 'yellow_team'),
  ('mark',  'Blue Team',  'success@bpmsd.com','owner_calls_this_week','Owner Calls (New)',
   25, 'above', 'number', 'leadsimple_owner_calls', 20, 'blue_team');
