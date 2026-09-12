-- Deliverable template sets and items (spec §4.6, D9).
-- Dual-ownership per CLAUDE.md "Partner-Wide First": org_id XOR partner_id.
-- DDL only: no rows are written, so no breeze.scope election is required.
-- Depends on 2026-10-15-170000-service-deliverables.sql for the two enums.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public table
-- (plus ALTER DEFAULT PRIVILEGES) at boot, same as the W01 migration.

-- ============================================
-- 1. deliverable_template_sets
-- ============================================
CREATE TABLE IF NOT EXISTS deliverable_template_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE deliverable_template_sets ADD CONSTRAINT deliverable_template_sets_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial so the NULL axis never participates: a partner-wide set and an
-- org-owned set may legitimately share a name.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_partner_name_uq
  ON deliverable_template_sets (partner_id, name) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_org_name_uq
  ON deliverable_template_sets (org_id, name) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deliverable_template_sets_partner_idx ON deliverable_template_sets (partner_id);
CREATE INDEX IF NOT EXISTS deliverable_template_sets_org_idx ON deliverable_template_sets (org_id);

-- FK targets for the two BRANCH foreign keys on items (see section 2). These
-- must be non-partial, non-expression unique indexes or Postgres refuses to
-- reference them. `id` is the PK, so uniqueness is trivially satisfied; the
-- extra column is what makes the FK carry the owner axis.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_id_org_uq
  ON deliverable_template_sets (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_id_partner_uq
  ON deliverable_template_sets (id, partner_id);

ALTER TABLE deliverable_template_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverable_template_sets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliverable_template_sets_isolation ON deliverable_template_sets;
CREATE POLICY deliverable_template_sets_isolation
  ON deliverable_template_sets
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- Separate, additive, SELECT-ONLY partner-wide read branch (#4673; template
-- 2026-10-05-110000-config-policy-partner-wide-select.sql). Appending it to the
-- FOR ALL policy would also widen UPDATE/DELETE row targeting; Postgres never
-- consults FOR SELECT policies when computing those targets.
DROP POLICY IF EXISTS deliverable_template_sets_partner_wide_select ON deliverable_template_sets;
CREATE POLICY deliverable_template_sets_partner_wide_select
  ON deliverable_template_sets
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());


-- ============================================
-- 2. deliverable_template_items
-- ============================================
-- The item copies the set's owner columns, carries the SAME XOR check, and pins
-- itself to the set through TWO branch FKs (rationale above the task).
CREATE TABLE IF NOT EXISTS deliverable_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id UUID NOT NULL,
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  cadence deliverable_cadence NOT NULL,
  lead_days INTEGER NOT NULL DEFAULT 7,
  grace_days INTEGER NOT NULL DEFAULT 14,
  artifact_required BOOLEAN NOT NULL DEFAULT TRUE,
  completion_mode deliverable_completion_mode NOT NULL DEFAULT 'on_ticket_resolve',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_days_chk
    CHECK (lead_days >= 0 AND grace_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_set_org_fk
    FOREIGN KEY (set_id, org_id) REFERENCES deliverable_template_sets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_set_partner_fk
    FOREIGN KEY (set_id, partner_id) REFERENCES deliverable_template_sets(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One name per set: applying a set must not try to create two deliverables with
-- the same name, which service_deliverables_org_contract_name_uq would reject
-- halfway through the transaction.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_items_set_name_uq
  ON deliverable_template_items (set_id, name);
CREATE INDEX IF NOT EXISTS deliverable_template_items_set_sort_idx
  ON deliverable_template_items (set_id, sort_order);
CREATE INDEX IF NOT EXISTS deliverable_template_items_partner_idx ON deliverable_template_items (partner_id);
CREATE INDEX IF NOT EXISTS deliverable_template_items_org_idx ON deliverable_template_items (org_id);

ALTER TABLE deliverable_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverable_template_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliverable_template_items_isolation ON deliverable_template_items;
CREATE POLICY deliverable_template_items_isolation
  ON deliverable_template_items
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS deliverable_template_items_partner_wide_select ON deliverable_template_items;
CREATE POLICY deliverable_template_items_partner_wide_select
  ON deliverable_template_items
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

