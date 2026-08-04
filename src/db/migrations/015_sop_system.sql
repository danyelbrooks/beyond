-- Migration 015 — SOP System
--
-- Four tables:
--   sop_categories       — the 20 categories (pre-seeded A-Z)
--   sops                 — each SOP document
--   sop_checklist_items  — if/then checklist items per SOP
--   sop_reminders        — recurring email reminders per SOP
--
-- Run in Supabase → SQL Editor.

-- =============================================================================
-- TABLE 1: sop_categories
-- =============================================================================

CREATE TABLE public.sop_categories (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL UNIQUE,
  sort_order INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: 20 categories in A-Z order
INSERT INTO public.sop_categories (name, sort_order) VALUES
  ('Accounting',               1),
  ('Banking',                  2),
  ('BPM Best Practices',       3),
  ('BPM Task Map',             4),
  ('Business Operating',       5),
  ('Checks & Balances',        6),
  ('Employee Manual',          7),
  ('Employee Roles',           8),
  ('How To / Training',        9),
  ('KPI / EOS Training',      10),
  ('LeadSimple',              11),
  ('Maintenance',             12),
  ('Maintenance Company',     13),
  ('Office Supplies',         14),
  ('Real Estate',             15),
  ('Resident Fees',           16),
  ('Resident Fees Procedures',17),
  ('Software How-To',         18),
  ('Tenant & Landlord Law',   19),
  ('Vendors',                 20);

ALTER TABLE public.sop_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read categories"
  ON public.sop_categories FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin can manage categories"
  ON public.sop_categories FOR ALL TO authenticated
  USING (public.get_user_role() = 'admin')
  WITH CHECK (public.get_user_role() = 'admin');

-- =============================================================================
-- TABLE 2: sops
-- =============================================================================

CREATE TABLE public.sops (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  description TEXT,
  category_id UUID        REFERENCES public.sop_categories(id) ON DELETE SET NULL,
  content     TEXT,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sops_category_id ON public.sops (category_id);
CREATE INDEX idx_sops_created_at  ON public.sops (created_at DESC);

CREATE TRIGGER trg_sops_updated_at
  BEFORE UPDATE ON public.sops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.sops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read sops"
  ON public.sops FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin can manage sops"
  ON public.sops FOR ALL TO authenticated
  USING (public.get_user_role() = 'admin')
  WITH CHECK (public.get_user_role() = 'admin');

-- =============================================================================
-- TABLE 3: sop_checklist_items
-- =============================================================================

CREATE TABLE public.sop_checklist_items (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id     UUID        NOT NULL REFERENCES public.sops(id) ON DELETE CASCADE,
  sort_order INT         NOT NULL DEFAULT 0,
  label      TEXT        NOT NULL,
  if_yes     TEXT,
  if_no      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sop_checklist_sop_id ON public.sop_checklist_items (sop_id);

ALTER TABLE public.sop_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read checklist items"
  ON public.sop_checklist_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin can manage checklist items"
  ON public.sop_checklist_items FOR ALL TO authenticated
  USING (public.get_user_role() = 'admin')
  WITH CHECK (public.get_user_role() = 'admin');

-- =============================================================================
-- TABLE 4: sop_reminders
-- =============================================================================

CREATE TABLE public.sop_reminders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id            UUID        NOT NULL REFERENCES public.sops(id) ON DELETE CASCADE,
  title             TEXT        NOT NULL,
  assigned_to_email TEXT        NOT NULL,
  frequency         TEXT        NOT NULL
                    CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_due_at       TIMESTAMPTZ NOT NULL,
  last_sent_at      TIMESTAMPTZ,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sop_reminders_next_due ON public.sop_reminders (next_due_at) WHERE active = TRUE;

ALTER TABLE public.sop_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin can manage reminders"
  ON public.sop_reminders FOR ALL TO authenticated
  USING (public.get_user_role() = 'admin')
  WITH CHECK (public.get_user_role() = 'admin');

-- =============================================================================
-- Add best_practice_id to email_cache
-- =============================================================================

ALTER TABLE public.email_cache
  ADD COLUMN IF NOT EXISTS best_practice_id UUID REFERENCES public.sops(id) ON DELETE SET NULL;
