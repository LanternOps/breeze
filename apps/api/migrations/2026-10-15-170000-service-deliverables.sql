-- Service deliverables (spec docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md §4.1–4.3).
-- Feature #5573 W01. Idempotent throughout. DDL only: no rows are written, so no
-- breeze.scope election.
--
-- Tenancy: all three tables are RLS shape 1 (direct org_id, breeze_has_org_access).
-- Every composite FK whose referenced side includes an `org_id` column is
-- DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED and
-- repoints parent and child org_id in separate statements).
--
-- Registration (CLAUDE.md cascade table): the same PR adds all three tables to
-- CORE_ORG_CASCADE_DELETE_ORDER, CORE_TENANT_EXPORT_POLICY and the org-merge
-- registry.

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE deliverable_cadence AS ENUM ('monthly','quarterly','semiannual','annual','one_time');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_completion_mode AS ENUM ('explicit','on_ticket_resolve');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_occurrence_status AS ENUM ('scheduled','open','awaiting_evidence','delivered','missed','waived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_evidence_kind AS ENUM ('document','report_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. report_runs needs a (id, report_id) key so evidence can prove a run belongs to a report
--    that belongs to the org (report_runs has no org_id of its own).
CREATE UNIQUE INDEX IF NOT EXISTS report_runs_id_report_id_uniq ON report_runs (id, report_id);

-- 3. service_deliverables
CREATE TABLE IF NOT EXISTS service_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  contract_id UUID,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  cadence deliverable_cadence NOT NULL,
  anchor_due_date DATE NOT NULL,
  effective_from DATE NOT NULL,
  effective_until DATE,
  lead_days INTEGER NOT NULL DEFAULT 7,
  grace_days INTEGER NOT NULL DEFAULT 14,
  artifact_required BOOLEAN NOT NULL DEFAULT TRUE,
  completion_mode deliverable_completion_mode NOT NULL DEFAULT 'on_ticket_resolve',
  auto_evidence_report_id UUID,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ticket_category_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL,
  portal_visible BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts(id, org_id)
    ON DELETE SET NULL (contract_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_auto_report_org_fk
    FOREIGN KEY (auto_evidence_report_id, org_id) REFERENCES reports(id, org_id)
    ON DELETE SET NULL (auto_evidence_report_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_effective_chk
    CHECK (effective_until IS NULL OR effective_until >= effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_days_chk
    CHECK (lead_days >= 0 AND grace_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS service_deliverables_id_org_uq ON service_deliverables (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_deliverables_org_contract_name_uq
  ON service_deliverables (org_id, COALESCE(contract_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX IF NOT EXISTS service_deliverables_org_idx ON service_deliverables (org_id);
CREATE INDEX IF NOT EXISTS service_deliverables_contract_idx ON service_deliverables (contract_id) WHERE contract_id IS NOT NULL;

ALTER TABLE service_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverables FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverables;
CREATE POLICY breeze_org_isolation_select ON service_deliverables FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverables FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverables FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverables FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 4. service_deliverable_occurrences
CREATE TABLE IF NOT EXISTS service_deliverable_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  deliverable_id UUID NOT NULL,
  name_snapshot VARCHAR(200) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  due_at DATE NOT NULL,
  original_due_at DATE NOT NULL,
  status deliverable_occurrence_status NOT NULL DEFAULT 'scheduled',
  ticket_id UUID,
  delivered_at TIMESTAMPTZ,
  delivered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  delivered_via TEXT,
  delivery_note TEXT,
  waived_at TIMESTAMPTZ,
  waived_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  waived_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_deliverable_org_fk
    FOREIGN KEY (deliverable_id, org_id) REFERENCES service_deliverables(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE SET NULL (ticket_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_delivered_via_chk
    CHECK (delivered_via IS NULL OR delivered_via IN ('explicit','ticket'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_period_chk
    CHECK (period_start <= period_end);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sd_occ_id_org_uq ON service_deliverable_occurrences (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS sd_occ_deliverable_period_uq ON service_deliverable_occurrences (deliverable_id, period_start);
CREATE INDEX IF NOT EXISTS sd_occ_org_status_due_idx ON service_deliverable_occurrences (org_id, status, due_at);
CREATE INDEX IF NOT EXISTS sd_occ_ticket_idx ON service_deliverable_occurrences (ticket_id) WHERE ticket_id IS NOT NULL;

ALTER TABLE service_deliverable_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverable_occurrences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverable_occurrences;
CREATE POLICY breeze_org_isolation_select ON service_deliverable_occurrences FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverable_occurrences FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverable_occurrences FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverable_occurrences FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 5. service_deliverable_evidence (document_id FK is added by W03 when org_documents exists)
CREATE TABLE IF NOT EXISTS service_deliverable_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  occurrence_id UUID NOT NULL,
  kind deliverable_evidence_kind NOT NULL,
  document_id UUID,
  report_id UUID,
  report_run_id UUID,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_occurrence_org_fk
    FOREIGN KEY (occurrence_id, org_id) REFERENCES service_deliverable_occurrences(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_report_org_fk
    FOREIGN KEY (report_id, org_id) REFERENCES reports(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_report_run_fk
    FOREIGN KEY (report_run_id, report_id) REFERENCES report_runs(id, report_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_kind_chk CHECK (
    (kind = 'document'   AND document_id IS NOT NULL AND report_id IS NULL AND report_run_id IS NULL) OR
    (kind = 'report_run' AND document_id IS NULL AND report_id IS NOT NULL AND report_run_id IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS sd_evidence_occurrence_idx ON service_deliverable_evidence (occurrence_id);
CREATE INDEX IF NOT EXISTS sd_evidence_org_idx ON service_deliverable_evidence (org_id);

ALTER TABLE service_deliverable_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverable_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverable_evidence;
CREATE POLICY breeze_org_isolation_select ON service_deliverable_evidence FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverable_evidence FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverable_evidence FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverable_evidence FOR DELETE USING (public.breeze_has_org_access(org_id));
