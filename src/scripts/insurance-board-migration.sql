-- =============================================================================
-- insurance-board-migration.sql
-- Property Insurance & Large Project Management Board
-- Run this in the Supabase SQL editor to create all required tables.
-- =============================================================================


-- =============================================================================
-- TRIGGER FUNCTION: auto-update updated_at on the projects table
-- =============================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- TABLE: projects
-- The core record for each insurance claim, CapEx job, termite job, or
-- other large project. One row per project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS projects (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_address          TEXT        NOT NULL,
  appfolio_property_id      TEXT,
  project_type              TEXT        NOT NULL
                              CHECK (project_type IN ('Insurance Claim', 'CapEx', 'Termite', 'Other')),
  status                    TEXT        NOT NULL DEFAULT 'green'
                              CHECK (status IN ('green', 'yellow', 'red')),
  date_opened               DATE        NOT NULL DEFAULT CURRENT_DATE,
  scheduled_close_date      DATE,
  actual_close_date         DATE,
  current_stage             TEXT,
  blocking_item             TEXT,
  days_not_habitable        INTEGER     DEFAULT 0,
  max_rent_reimbursement    DECIMAL(10,2),
  owner_deductible          DECIMAL(10,2),
  message_to_owner          TEXT,
  close_appfolio_complete   BOOLEAN     DEFAULT FALSE,
  close_insurance_paid      BOOLEAN     DEFAULT FALSE,
  close_owner_email_sent    BOOLEAN     DEFAULT FALSE,
  created_by                UUID,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at whenever a project row changes
CREATE TRIGGER set_projects_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION trigger_set_updated_at();


-- =============================================================================
-- TABLE: project_checklist
-- Insurance-specific checklist flags and tenant-situation fields.
-- One row per project (inserted automatically when a project is created).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_checklist (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  is_insurance_claim            BOOLEAN     DEFAULT FALSE,
  insurance_approved            TEXT        DEFAULT 'pending'
                                  CHECK (insurance_approved IN ('yes', 'no', 'pending')),
  insurance_full_cost_approved  TEXT        DEFAULT 'pending'
                                  CHECK (insurance_full_cost_approved IN ('yes', 'no', 'pending')),
  renters_insurance_needed      BOOLEAN     DEFAULT FALSE,
  renters_insurance_filed       BOOLEAN     DEFAULT FALSE,
  tenant_must_vacate            BOOLEAN     DEFAULT FALSE,
  tenant_has_vacated            BOOLEAN     DEFAULT FALSE,
  tenant_vacated_date           DATE,
  tenant_non_compliant          BOOLEAN     DEFAULT FALSE,
  legal_flag                    BOOLEAN     DEFAULT FALSE,
  rent_reimbursement_days       INTEGER,
  rent_reimbursement_amount     DECIMAL(10,2)
);


-- =============================================================================
-- TABLE: project_invoices
-- Individual invoice line items for each project.
-- Standard set inserted automatically on project creation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_invoices (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_item       TEXT          NOT NULL,
  is_bpm_fee      BOOLEAN       DEFAULT FALSE,
  vendor_name     TEXT,
  invoice_amount  DECIMAL(10,2) DEFAULT 0,
  date_received   DATE,
  date_paid       DATE,
  notes           TEXT,
  sort_order      INTEGER       DEFAULT 0
);


-- =============================================================================
-- TABLE: project_insurance_checks
-- Tracks up to 4 insurance checks received per project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_insurance_checks (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  check_number    INTEGER       NOT NULL CHECK (check_number BETWEEN 1 AND 4),
  check_reference TEXT,
  amount          DECIMAL(10,2) DEFAULT 0,
  date_received   DATE
);


-- =============================================================================
-- TABLE: project_correspondence
-- Log of all emails, calls, texts, meetings, and notes related to a project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_correspondence (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  log_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
  type        TEXT        NOT NULL
                CHECK (type IN ('Email', 'Call', 'Text', 'Meeting', 'Note')),
  who         TEXT        NOT NULL,
  summary     TEXT        NOT NULL,
  logged_by   UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- TABLE: project_appfolio_cache
-- Cached AppFolio work order data for display on the project detail page.
-- Updated by the sync job (Phase 2).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_appfolio_cache (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  appfolio_work_order_id    TEXT,
  work_order_number         TEXT,
  description               TEXT,
  vendor_name               TEXT,
  status                    TEXT,
  last_updated_in_appfolio  TIMESTAMPTZ,
  synced_at                 TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- TABLE: project_external_users
-- Owners, insurance agents, and vendors who have portal access (Phase 3/4).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_external_users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id  UUID,
  role              TEXT        NOT NULL
                      CHECK (role IN ('owner', 'insurance_agent', 'vendor')),
  display_name      TEXT        NOT NULL,
  email             TEXT        NOT NULL UNIQUE,
  active            BOOLEAN     DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- TABLE: project_external_access
-- Maps which external users can see which projects.
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_external_access (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id  UUID        NOT NULL REFERENCES project_external_users(id) ON DELETE CASCADE,
  granted_by        UUID,
  granted_at        TIMESTAMPTZ DEFAULT NOW()
);
