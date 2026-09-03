-- #4596 W1 — time_entries.org_id must belong to the row's own partner.
--
-- `time_entries` is RLS Shape 3 (partner-axis). `time_entries_partner_access`
-- (2026-06-12-a-ticketing-time-parts.sql:60) checks
-- `breeze_has_partner_access(partner_id)` and says nothing at all about
-- `org_id`, whose FK pointed at `organizations(id)` alone. Nothing at the
-- database level tied the two, so a row authorised for partner A could
-- attribute billable labour to partner B's customer: RLS passed (the partner
-- matched), the FK passed (the org existed), and every org-keyed reader
-- downstream (invoiceAssembly.ts, orgCurrencyService.ts, the #4547 block-hours
-- drawdown) would have counted it against the victim's org.
--
-- Shape copied from `users` (2026-04-11-users-rls.sql §3/§6, the dual-axis
-- precedent): COMPOSITE against `organizations_id_partner_uq (id, partner_id)`,
-- which that migration already created. No new unique index is needed here.
--
-- The single-column `org_id -> organizations(id)` FK is KEPT. Postgres
-- evaluates FK constraints conjunctively, so a surviving single-column FK is
-- redundant rather than permissive, and keeping it means the composite's
-- MATCH SIMPLE semantics (below) can never leave `org_id` unprotected.
--
-- MATCH SIMPLE, accepted: a row with `org_id IS NULL` is exempt. That is
-- correct — a standalone timer is attributed to no organization, and no
-- org-keyed reader counts it. MATCH FULL would break every standalone entry.
--
-- DEFERRABLE INITIALLY IMMEDIATE: not strictly required by
-- orgLifecycleFoundations.integration.test.ts (no REFERENCED column here is
-- literally named `org_id`), but declared anyway so org merge — which runs
-- `SET CONSTRAINTS ALL DEFERRED` and repoints `time_entries.org_id` as a plain
-- registry repoint (orgMergeRegistry.ts) — can never be reordered into a
-- mid-walk abort by this constraint.
--
-- Registration (CLAUDE.md cascade table): NOTHING to add. No new table, no new
-- column. `time_entries` is already in CORE_ORG_CASCADE_DELETE_ORDER
-- (tenantCascade.ts), CORE_TENANT_EXPORT_POLICY (tenantExportPolicyRegistry.ts,
-- every column classified), the org-merge REPOINT_TABLES, and
-- PARTNER_TENANT_TABLES in rls-coverage. No new parent table, so
-- topologicalCascadeOrder() is unchanged.

-- FORCE ROW LEVEL SECURITY + `breeze_current_scope()` defaulting to 'none'
-- means the cleanup below matches ZERO rows on managed Postgres without this,
-- and reports a truthful-looking "cleaned 0". `is_local = true` scopes it to
-- autoMigrate's per-file transaction.
-- See 2026-09-30-100000-rls-scoped-backfill-replay.sql for the write-up.
SELECT set_config('breeze.scope', 'system', true);

-- Cleanup BEFORE the constraint: a pre-existing drifted row would make the
-- ADD CONSTRAINT fail its initial validation and abort the whole file on every
-- database that carries the drift, with no way to skip it.
--
-- Direction: NULL the org, do not delete the row and do not guess a
-- replacement org. The partner disagreement means we cannot know which org is
-- correct, and a time entry is billable labour someone performed — destroying
-- it is not recoverable. Nulling cannot violate
-- `time_entries_currency_required_when_org_chk`
-- (`org_id IS NULL OR currency_code IS NOT NULL`, one-directional), so the
-- currency snapshot survives untouched.
--
-- The count is reported UNCONDITIONALLY. A non-zero count is evidence that
-- labour was attributed to another tenant's customer — potentially a
-- tenant-isolation incident — and that forensic trail has to survive even when
-- the number is 0, because a suppressed 0 is indistinguishable from the RLS
-- no-op the set_config above prevents.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE time_entries te
     SET org_id = NULL
    FROM organizations o
   WHERE o.id = te.org_id
     AND o.partner_id IS DISTINCT FROM te.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'cleaned % cross-partner time_entries.org_id row(s)', n;
END $$;

-- DROP + re-ADD rather than a bare guarded ADD: on a database built with
-- `drizzle-kit push` or hand-repaired, a same-named constraint could carry a
-- different definition (e.g. non-deferrable). Re-adding is the only form that
-- converges every shape, and it keeps this file a true replayable no-op.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_org_partner_fk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_org_partner_fk
  FOREIGN KEY (org_id, partner_id)
  REFERENCES organizations (id, partner_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Supports the constraint's own lookup on the referencing side and the
-- "entries for this partner's org" reads in listTimeEntries. Partial: a NULL
-- org_id row is exempt from the FK and never probed by an org-keyed reader.
CREATE INDEX IF NOT EXISTS time_entries_org_partner_idx
  ON time_entries (org_id, partner_id) WHERE org_id IS NOT NULL;
