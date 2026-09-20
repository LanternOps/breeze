-- apps/api/migrations/2026-10-21-100100-time-entries-work-type.sql
-- work_type_id on time entries + default_work_type_id on ticket categories
-- (spec 2026-09-17-billing-profiles-work-types-spec §4.3). W01, #4615.
--
-- Both FKs are COMPOSITE on (…, partner_id) because FK checks bypass RLS: the
-- partner-axis policy on work_types cannot stop a row from pointing at another
-- partner's label, so the constraint has to (spec §4.2).
--
-- Both are NO ACTION and deliberately NOT DEFERRABLE. CLAUDE.md's
-- "DEFERRABLE INITIALLY IMMEDIATE" rule covers composite FKs that reference an
-- ORG_ID column, because org merge re-points parent and child org_id in
-- separate statements. These reference partner_id, which a merge never
-- re-points (a merge is always within one partner), so deferral would buy
-- nothing and would weaken the constraint inside long transactions.
--
-- NO ON DELETE CASCADE / SET NULL on time_entries.work_type_id: a time entry is
-- billing history. cascadeDeletePartner's topologicalCascadeOrder reads this FK
-- edge from pg_constraint and deletes time_entries BEFORE work_types, so the
-- erasure path needs no referential action here.
--
-- REGISTRATION (CLAUDE.md, the step that gets missed): time_entries is in
-- CORE_ORG_CASCADE_DELETE_ORDER, so this ADD COLUMN fires the export-policy
-- contract. work_type_id is added to CORE_TENANT_EXPORT_POLICY's time_entries
-- entry as `included` in the same PR (tenantExportPolicyRegistry.ts:662).
-- ticket_categories has no org_id and owes no export entry.
--
-- Nullable with no default: every existing row stays NULL, so this is a
-- catalog-only change -- no table rewrite on a hot billing table.
--
-- DDL only: no rows written, so no breeze.scope election is required.
-- Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE time_entries       ADD COLUMN IF NOT EXISTS work_type_id         uuid;
ALTER TABLE ticket_categories  ADD COLUMN IF NOT EXISTS default_work_type_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_work_type_partner_fk'
  ) THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_work_type_partner_fk
      FOREIGN KEY (work_type_id, partner_id)
      REFERENCES work_types (id, partner_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_default_work_type_partner_fk'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_default_work_type_partner_fk
      FOREIGN KEY (default_work_type_id, partner_id)
      REFERENCES work_types (id, partner_id);
  END IF;
END $$;

-- Serves the W03/W04 report group-by and the "is this work type in use?" check
-- the archive path runs before deactivating a label.
CREATE INDEX IF NOT EXISTS time_entries_work_type_idx
  ON time_entries (work_type_id) WHERE work_type_id IS NOT NULL;
