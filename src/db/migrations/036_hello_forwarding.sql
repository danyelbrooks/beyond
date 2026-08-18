-- =============================================================================
-- Migration: 036_hello_forwarding
-- Description: "Hello@ Forwarding" — reads mail arriving at hello@bpmsd.com and
--              routes it to the right BPM inbox automatically.
--
--              Creates:
--                routing_rules     — the rules Danyel edits in the browser
--                routing_settings  — one row: shadow mode switch + the AI prompt
--
--              Adds to email_cache:  where an email was routed and why
--              Adds to email_actions: lets the system (not just a person) log
--                                     an action, so the audit trail stays complete
--
-- Date: 2026-08-17
-- =============================================================================
-- Run this AFTER 014_assign_forward.sql (depends on the 'forwarded' action type).
-- Run in Supabase -> SQL Editor.
-- =============================================================================


-- =============================================================================
-- TABLE 1: routing_rules
--
-- One row = one sentence: "When the <field> contains <text>, send it to <inbox>."
--
-- Rules run BEFORE the AI and always win. They are free, instant, and do the
-- same thing every single time. Lower priority number = checked first; the
-- first rule that matches wins and nothing else is checked.
-- =============================================================================

CREATE TABLE public.routing_rules (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT        NOT NULL,
  match_field   TEXT        NOT NULL
                CHECK (match_field IN (
                  'greeting_name',    -- email opens with "Hi <name>," — match on the name
                  'from_address',     -- the full sender address
                  'from_domain',      -- everything after the @ in the sender address
                  'subject',          -- the subject line
                  'body',             -- the body text
                  'subject_or_body'   -- either one
                )),
  match_text    TEXT        NOT NULL,
  destination   TEXT        NOT NULL,   -- a BPM inbox, or 'none' to leave it unassigned
  priority      INTEGER     NOT NULL DEFAULT 100,
  active        BOOLEAN     NOT NULL DEFAULT true,
  hit_count     INTEGER     NOT NULL DEFAULT 0,
  last_hit_at   TIMESTAMPTZ,
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.routing_rules             IS 'Plain-English routing rules for hello@bpmsd.com. Checked before the AI; first match wins.';
COMMENT ON COLUMN public.routing_rules.label       IS 'What this rule is for, in plain English. Shown in the rules list.';
COMMENT ON COLUMN public.routing_rules.match_field IS 'Which part of the email to look at.';
COMMENT ON COLUMN public.routing_rules.match_text  IS 'The text to look for. Case-insensitive. Matched as "contains", not exact.';
COMMENT ON COLUMN public.routing_rules.destination IS 'The BPM inbox to forward to, or the word none to leave it for a human.';
COMMENT ON COLUMN public.routing_rules.priority    IS 'Lower number is checked first. First matching rule wins.';
COMMENT ON COLUMN public.routing_rules.hit_count   IS 'How many times this rule has fired. Shows which rules are earning their keep.';

CREATE INDEX idx_routing_rules_active_priority ON public.routing_rules (active, priority);

CREATE TRIGGER trg_routing_rules_updated_at
  BEFORE UPDATE ON public.routing_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- RLS: routing_rules
-- Everyone signed in can read them. Only admin and manager can change them.
-- =============================================================================

ALTER TABLE public.routing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read routing rules"
  ON public.routing_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin and manager can insert routing rules"
  ON public.routing_rules
  FOR INSERT
  TO authenticated
  WITH CHECK (public.get_user_role() IN ('admin', 'manager'));

CREATE POLICY "admin and manager can update routing rules"
  ON public.routing_rules
  FOR UPDATE
  TO authenticated
  USING (public.get_user_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_user_role() IN ('admin', 'manager'));

CREATE POLICY "admin and manager can delete routing rules"
  ON public.routing_rules
  FOR DELETE
  TO authenticated
  USING (public.get_user_role() IN ('admin', 'manager'));


-- =============================================================================
-- TABLE 2: routing_settings
--
-- Exactly one row, always id = 1. Holds the master on/off switch and the
-- instructions the AI follows. Both are editable from the Routing Rules page.
-- =============================================================================

CREATE TABLE public.routing_settings (
  id             SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shadow_mode    BOOLEAN     NOT NULL DEFAULT true,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  source_inbox   TEXT        NOT NULL DEFAULT 'hello@bpmsd.com',
  classify_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_prompt      TEXT        NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.routing_settings             IS 'Single-row configuration for Hello@ Forwarding.';
COMMENT ON COLUMN public.routing_settings.shadow_mode IS 'true = decide and record but never actually forward. The safe setting. Flip to false to go live.';
COMMENT ON COLUMN public.routing_settings.enabled     IS 'false = stop classifying entirely. The emergency stop.';
COMMENT ON COLUMN public.routing_settings.classify_from IS 'Only mail received after this moment is ever touched. Set to now() when the migration runs so years of existing hello@ history is never swept up and forwarded.';
COMMENT ON COLUMN public.routing_settings.ai_prompt   IS 'The instructions the AI follows when no rule matches. Editable in the browser.';

CREATE TRIGGER trg_routing_settings_updated_at
  BEFORE UPDATE ON public.routing_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.routing_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read routing settings"
  ON public.routing_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin and manager can update routing settings"
  ON public.routing_settings
  FOR UPDATE
  TO authenticated
  USING (public.get_user_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_user_role() IN ('admin', 'manager'));

-- No INSERT or DELETE policy. The single row is seeded below and stays put.


-- =============================================================================
-- SEED: routing_settings — the AI's instructions
--
-- This is Danyel's routing prompt with the three typos corrected
-- (msuccess@ -> success@, bpsmd.com -> bpmsd.com), accounting given the
-- destination it was missing, HOA split per his decision, and every
-- person's name translated to the inbox that person owns.
-- =============================================================================

INSERT INTO public.routing_settings (id, shadow_mode, enabled, source_inbox, classify_from, ai_prompt)
VALUES (1, true, true, 'hello@bpmsd.com', now(), $prompt$# ROLE

You are an email triage assistant for Beyond Property Management, a property
management company in San Diego. Your ONLY job is to decide which inbox each
email should go to. Classify on the PRIMARY request, not every topic mentioned.
Never guess when there is clear evidence for another category.

## STEP 1 - IS IT ADDRESSED TO A PERSON BY NAME?

If the email opens by addressing a specific employee ("Hi Laura", "Hello Rubin",
"Mark,", "Ana,"), route it to that person's inbox and ignore every other rule:

  Laura     -> results@bpmsd.com
  Rubin     -> help@bpmsd.com
  Mark      -> success@bpmsd.com
  Gael      -> home@bpmsd.com
  Ana       -> beyond@bpmsd.com
  Ella      -> admin@bpmsd.com
  Claudette -> care@bpmsd.com
  Moira     -> accounts@bpmsd.com
  Danyel    -> danyel@bpmsd.com

## STEP 2 - SHOULD IT BE ASSIGNED AT ALL?

Do NOT assign the email if it is spam, marketing, a vendor advertisement, a cold
sales email, a promotional offer, a software solicitation, a product demo, a
newsletter, a company announcement unrelated to BPM, or otherwise unrelated.

For those, return destination "none".

If it is a recurring newsletter or marketing email, also set unsubscribe to true.
Do not attempt to unsubscribe yourself. A person reviews those separately.

## STEP 3 - IDENTIFY THE SENDER

Decide whether the sender is primarily an Owner, Resident, Applicant,
Prospective Tenant, Vendor, HOA, Utility Company, Accounting Contact, or Unknown.

## STEP 4 - DETERMINE THE PRIMARY REQUEST

If the email contains several requests, route on the PRIMARY reason it was sent.
A resident who reports a plumbing leak and also asks about rent is Maintenance,
not Accounting.

## DESTINATIONS

MOVE OUT / MAKE READY -> home@bpmsd.com  (Gael Aguilar)
  Notice to Vacate, Move Out, Vacating, Move-Out Inspection, Final Walkthrough,
  Forwarding Address, Security Deposit Return after Move Out, Make Ready,
  Turnover, Recurring Work Orders, Keys Returned, Cleaning After Move Out,
  Property Turn.
  This category ALWAYS takes priority over Maintenance.

OWNER RELATIONS -> help@bpmsd.com  (Rubin Randolph, Ana is backup)
  Owner Questions, Owner Requests, Owner Approval, Owner Complaints,
  Owner Decisions, Property Owner Communication, Owner Authorization,
  Management Questions.
  Unless the email is clearly Accounting.

ACCOUNTING -> admin@bpmsd.com  (Ella Ignacio)
  Accounting, Billing, Payments, Invoices, Statements, Utilities,
  Security Deposits (except a deposit return after a move-out, which is
  MOVE OUT / MAKE READY).

MAINTENANCE -> success@bpmsd.com  (Mark Davidson)
  Maintenance, Repair, Broken, Leak, Leaking, Water Damage, Plumbing,
  Electrical, HVAC, Air Conditioning, Heating, Roof, Fence, Garage Door,
  Appliance, Pest Control, Vendor Coordination, Maintenance Vendor, Work Order,
  Service Request, Emergency Repair.

HOA -> depends on the type:
  HOA newsletters, notices, updates, ballots, general HOA inquiries
    -> care@bpmsd.com  (Claudette Jorolan)
  HOA violations
    -> results@bpmsd.com

LEASING OPERATIONS -> beyond@bpmsd.com  (Ana Alarcon)
  Lease Renewal, Lease Documents, Lease Preparation, Lease Signing,
  Turning Point, Lease Changes, Lease Addendum, Lease Processing.

RESIDENT SERVICES / APPLICANTS -> results@bpmsd.com  (Laura Solorio)
  Applicant, Rental Application, Prospective Tenant, Showing, Tour Request,
  RentEngine, Availability, Rental Questions, Qualification, Co-Signer,
  Resident Questions, General Leasing Questions, Move-In Questions,
  Application Status, Pet Screening.

## PRIORITY WHEN CATEGORIES OVERLAP

  1. Addressed to a person by name
  2. Spam / Marketing
  3. Move Out / Make Ready
  4. Owner Inquiry
  5. Accounting
  6. Maintenance
  7. HOA
  8. Leasing Operations
  9. Applicants / Resident Services

## TIE BREAKERS

  Resident reports a maintenance issue while asking something else -> Maintenance
  Owner discusses an invoice                                        -> Accounting
  Owner requests approval                                           -> Owner Relations
  Resident submits Notice to Vacate                                 -> Move Out
  Applicant asks about a showing                                    -> results@bpmsd.com
  HOA reports a violation needing owner approval                    -> results@bpmsd.com

Always choose the department responsible for completing the work.

## CONFIDENCE

Rate your confidence high, medium, or low.

Use "high" only when the correct destination is obvious and you would bet on it.
Use "medium" when it is probably right but a reasonable person could disagree.
Use "low" when you are unsure, the email is vague, or it could belong to two
departments. When in doubt, choose lower confidence. A human reads everything
that is not high confidence, so guessing high is far more costly than guessing low.

## OUTPUT

Reply with JSON only. No other text, no explanation outside the JSON.

{
  "destination":  "one of the inbox addresses above, or none",
  "department":   "short department name",
  "reason":       "one concise sentence, never more",
  "primary_topic":"a few words",
  "sender_type":  "Owner | Resident | Applicant | Prospective Tenant | Vendor | HOA | Utility Company | Accounting Contact | Unknown",
  "confidence":   "high | medium | low",
  "unsubscribe":  true or false
}

Never summarize the email. Only determine routing.$prompt$);


-- =============================================================================
-- SEED: routing_rules
--
-- Deliberately small. Only rules that are unambiguous go here — the AI, which
-- has the full priority list and tie-breakers above, handles judgement calls.
-- A dumb keyword rule that fires on "rent" would break the tie-breaker logic,
-- so topic rules are left to the AI until Danyel sees a specific mis-route
-- worth pinning down.
--
-- Priority 10 = addressed to a person by name (beats everything).
-- Priority 30 = Notice to Vacate (his #3, and unambiguous in plain text).
-- =============================================================================

INSERT INTO public.routing_rules (label, match_field, match_text, destination, priority) VALUES
  ('Addressed to Laura',     'greeting_name', 'laura',     'results@bpmsd.com',  10),
  ('Addressed to Rubin',     'greeting_name', 'rubin',     'help@bpmsd.com',     10),
  ('Addressed to Mark',      'greeting_name', 'mark',      'success@bpmsd.com',  10),
  ('Addressed to Gael',      'greeting_name', 'gael',      'home@bpmsd.com',     10),
  ('Addressed to Ana',       'greeting_name', 'ana',       'beyond@bpmsd.com',   10),
  ('Addressed to Ella',      'greeting_name', 'ella',      'admin@bpmsd.com',    10),
  ('Addressed to Claudette', 'greeting_name', 'claudette', 'care@bpmsd.com',     10),
  ('Addressed to Moira',     'greeting_name', 'moira',     'accounts@bpmsd.com', 10),
  ('Addressed to Danyel',    'greeting_name', 'danyel',    'danyel@bpmsd.com',   10),
  ('Notice to Vacate',       'subject_or_body', 'notice to vacate', 'home@bpmsd.com', 30);


-- =============================================================================
-- email_cache: record where each email was routed and why
-- =============================================================================

ALTER TABLE public.email_cache
  ADD COLUMN IF NOT EXISTS routed_to             TEXT,
  ADD COLUMN IF NOT EXISTS routing_department    TEXT,
  ADD COLUMN IF NOT EXISTS routing_reason        TEXT,
  ADD COLUMN IF NOT EXISTS routing_topic         TEXT,
  ADD COLUMN IF NOT EXISTS routing_sender_type   TEXT,
  ADD COLUMN IF NOT EXISTS routing_confidence    TEXT
    CHECK (routing_confidence IS NULL OR routing_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS routing_source        TEXT
    CHECK (routing_source IS NULL OR routing_source IN ('rule', 'ai', 'error')),
  ADD COLUMN IF NOT EXISTS routing_rule_id       UUID REFERENCES public.routing_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS routed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS forward_sent          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_unsubscribe     BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_cache.routed_to         IS 'The inbox this email was sent to, or the word none if it was junk.';
COMMENT ON COLUMN public.email_cache.routing_reason    IS 'One sentence explaining the choice. Shown on the board so a mis-route is easy to diagnose.';
COMMENT ON COLUMN public.email_cache.routing_confidence IS 'high = forwarded automatically. medium or low = held for a human.';
COMMENT ON COLUMN public.email_cache.routing_source    IS 'rule = matched one of Danyel''s rules. ai = the AI decided. error = classification failed.';
COMMENT ON COLUMN public.email_cache.forward_sent      IS 'true only when the email was actually forwarded. Stays false in shadow mode.';
COMMENT ON COLUMN public.email_cache.needs_unsubscribe IS 'Flagged as a newsletter or marketing. Goes on the weekly unsubscribe list for a person to clear by hand.';

-- Find the emails still waiting on a human quickly
CREATE INDEX IF NOT EXISTS idx_email_cache_routed_at   ON public.email_cache (routed_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_cache_needs_human ON public.email_cache (routing_confidence, routed_at DESC);


-- =============================================================================
-- email_actions: let the system log actions too
--
-- Until now every action had a person attached. The classifier is not a person,
-- so performed_by becomes optional and a new actor column records who acted.
--
-- The browser still cannot insert a system row: the existing RLS policy requires
-- performed_by = auth.uid(), and NULL never satisfies that. Only the classifier,
-- which uses the service role key, can write these.
-- =============================================================================

ALTER TABLE public.email_actions
  ALTER COLUMN performed_by DROP NOT NULL;

ALTER TABLE public.email_actions
  ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'human'
    CHECK (actor IN ('human', 'system'));

COMMENT ON COLUMN public.email_actions.actor IS 'human = a team member clicked something. system = Hello@ Forwarding acted on its own.';

-- Expand action_type with the three things the classifier can do
ALTER TABLE public.email_actions
  DROP CONSTRAINT IF EXISTS email_actions_action_type_check;

ALTER TABLE public.email_actions
  ADD CONSTRAINT email_actions_action_type_check
  CHECK (action_type IN (
    'assigned', 'categorized', 'replied', 'marked_handled', 'marked_new', 'forwarded',
    'auto_routed',      -- decided where it goes (always logged, shadow mode included)
    'auto_forwarded',   -- actually sent it
    'routing_held'      -- not confident enough; left for a human
  ));


-- =============================================================================
-- ROLLBACK
-- Run these (in this order) to undo this migration.
-- =============================================================================
--
-- ALTER TABLE public.email_actions DROP CONSTRAINT IF EXISTS email_actions_action_type_check;
-- ALTER TABLE public.email_actions
--   ADD CONSTRAINT email_actions_action_type_check
--   CHECK (action_type IN ('assigned','categorized','replied','marked_handled','marked_new','forwarded'));
-- ALTER TABLE public.email_actions DROP COLUMN IF EXISTS actor;
-- -- NOTE: only restore NOT NULL after deleting system rows, which have no performed_by:
-- -- DELETE FROM public.email_actions WHERE performed_by IS NULL;
-- -- ALTER TABLE public.email_actions ALTER COLUMN performed_by SET NOT NULL;
--
-- DROP INDEX IF EXISTS idx_email_cache_needs_human;
-- DROP INDEX IF EXISTS idx_email_cache_routed_at;
-- ALTER TABLE public.email_cache
--   DROP COLUMN IF EXISTS needs_unsubscribe,
--   DROP COLUMN IF EXISTS forward_sent,
--   DROP COLUMN IF EXISTS routed_at,
--   DROP COLUMN IF EXISTS routing_rule_id,
--   DROP COLUMN IF EXISTS routing_source,
--   DROP COLUMN IF EXISTS routing_confidence,
--   DROP COLUMN IF EXISTS routing_sender_type,
--   DROP COLUMN IF EXISTS routing_topic,
--   DROP COLUMN IF EXISTS routing_reason,
--   DROP COLUMN IF EXISTS routing_department,
--   DROP COLUMN IF EXISTS routed_to;
--
-- DROP POLICY IF EXISTS "admin and manager can update routing settings"   ON public.routing_settings;
-- DROP POLICY IF EXISTS "authenticated users can read routing settings"   ON public.routing_settings;
-- DROP TABLE IF EXISTS public.routing_settings;
--
-- DROP POLICY IF EXISTS "admin and manager can delete routing rules"      ON public.routing_rules;
-- DROP POLICY IF EXISTS "admin and manager can update routing rules"      ON public.routing_rules;
-- DROP POLICY IF EXISTS "admin and manager can insert routing rules"      ON public.routing_rules;
-- DROP POLICY IF EXISTS "authenticated users can read routing rules"      ON public.routing_rules;
-- DROP TABLE IF EXISTS public.routing_rules;
--
-- =============================================================================
