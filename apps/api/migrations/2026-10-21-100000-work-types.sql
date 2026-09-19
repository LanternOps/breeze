-- apps/api/migrations/2026-10-21-100000-work-types.sql
-- Work types (spec 2026-09-17-billing-profiles-work-types-spec §3.1, §4.2).
-- W01 of the billing-profiles feature. Closes the data half of #4615.
--
-- TENANCY: RLS shape 3 (partner-axis), copied from
-- 2026-10-20-130000-partner-sending-daily-stats.sql: one FOR ALL TO breeze_app
-- policy, breeze_current_scope() = 'system' OR breeze_has_partner_access(
-- partner_id), on both USING and WITH CHECK. Precedent table: ticket_categories.
--
-- Deliberately NO org_id and NO device_id. A work type is picked by technicians
-- working ACROSS orgs (spec §4.1), so the only registration this table owes is
-- PARTNER_TENANT_TABLES in rls-coverage.integration.test.ts. No
-- CORE_ORG_CASCADE_DELETE_ORDER, no device lists, no CORE_TENANT_EXPORT_POLICY,
-- no orgMergeRegistry entry.
--
-- This table must NOT be added to DUAL_AXIS_TENANT_TABLES or
-- PARTNER_WIDE_SELECT_BRANCH_EXEMPT: Partner-Wide First's org-XOR-partner
-- default does not apply to a table with no org axis at all, and the second
-- list is a shrink-only ratchet at ceiling 0.
--
-- PARTNER ERASURE: cascadeDeletePartner discovers this table from its
-- partner_id column (information_schema sweep, tenantCascade.ts:1773) and
-- topologicalCascadeOrder's pg_constraint read puts it after its referrers
-- (time_entries, ticket_categories) and before `partners`. No static
-- registration exists or is needed. The DELETE grant below is what makes that
-- sweep work -- it runs as breeze_app under a system context, no role switch.
--
-- The partner FK carries NO ON DELETE CASCADE, matching the partner-axis tables
-- shipped in 2026-10-20: the sweep deletes these rows explicitly and in order.
--
-- DDL only: no rows written, so no breeze.scope election is required
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS work_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners(id),
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_types_name_not_blank_chk CHECK (btrim(name) <> '')
);

-- Case-insensitive uniqueness inside one partner. ticket_categories has no
-- unique name at all, which is precisely the mess W02's conversion has to
-- untangle (spec §3.6 step 2) -- this table does not repeat that mistake.
CREATE UNIQUE INDEX IF NOT EXISTS work_types_partner_name_uniq
  ON work_types (partner_id, lower(name));

-- NOT redundant with the primary key: this is the referencable target for the
-- composite FKs in 2026-10-21-100100. FK checks bypass RLS, so "same partner"
-- integrity has to be structural, not a policy (spec §4.2).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_types_id_partner_uniq'
  ) THEN
    ALTER TABLE work_types ADD CONSTRAINT work_types_id_partner_uniq UNIQUE (id, partner_id);
  END IF;
END $$;

-- Serves the only list query: every active work type for one partner, in order.
CREATE INDEX IF NOT EXISTS work_types_partner_sort_idx
  ON work_types (partner_id, sort_order, name);

ALTER TABLE work_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_types FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'work_types'
      AND policyname = 'work_types_partner_access'
  ) THEN
    CREATE POLICY work_types_partner_access ON work_types
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON work_types TO breeze_app;
