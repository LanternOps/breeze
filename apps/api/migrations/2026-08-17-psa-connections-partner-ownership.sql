-- Partner-owned PSA connections (epic #2135).
--
-- An MSP's PSA (ConnectWise, Autotask, Halo, Jira, Zendesk, ServiceNow,
-- Freshservice) is a PARTNER-level system: one tenant of the PSA covers every
-- customer the MSP manages. Until now a psa_connections row was always owned by
-- exactly one org (org_id NOT NULL), so an MSP had to re-enter the same PSA
-- credentials once per customer org. This migration makes a connection ownable
-- by EITHER an org (org_id set, partner_id NULL — the existing shape, retained
-- for the co-managed-IT case where a customer brings their OWN Jira/Zendesk) OR
-- a partner (partner_id set, org_id NULL — the "partner-wide / all orgs"
-- shape), enforced by an exactly-one-axis CHECK.
--
-- Mirrors alert_rules (2026-07-01), configuration_policies (2026-06-27),
-- software_policies (#2126) and ticket_forms (2026-07-11). The sibling
-- accounting_connections table is already partner-axis, so this brings the two
-- external-system integrations onto the same ownership axis.
--
-- The `backup_configs` org-only precedent deliberately does NOT apply here:
-- that table holds customer-owned STORAGE credentials, whereas a PSA
-- credential is the MSP's own.
--
-- psa_ticket_mappings has no org_id/partner_id of its own — its tenancy is
-- entirely `connection_id -> psa_connections`. Its four org-only join policies
-- (2026-04-11-bucket-c-dead-cleanup-rls.sql) are rewritten to dual-axis IN THIS
-- SAME FILE: left org-only they would make every mapping under a partner-owned
-- connection both invisible AND unwritable, because the parent's org_id is NULL
-- for exactly those rows. Same hazard the ticket_form_org_links policy
-- (2026-07-11) documents.
--
-- No data cleanup is needed: org_id is NOT NULL today, so every existing row
-- already satisfies the XOR (org_id set, partner_id NULL) the moment the
-- constraint lands. Nothing is UPDATEd or DELETEd here, hence no ROW_COUNT
-- diagnostics block.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate wraps
-- each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE psa_connections
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE psa_connections
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'psa_connections_one_owner_chk'
      AND conrelid = 'psa_connections'::regclass
  ) THEN
    ALTER TABLE psa_connections
      ADD CONSTRAINT psa_connections_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS psa_connections_partner_id_idx
  ON psa_connections(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
--
-- Replaces the four per-command breeze_org_isolation_* policies installed by
-- the generic org_id sweep (0008-tenant-rls.sql) with ONE policy covering all
-- commands, per the epic #2135 playbook.

ALTER TABLE psa_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON psa_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON psa_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON psa_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON psa_connections;
DROP POLICY IF EXISTS psa_connections_isolation ON psa_connections;
CREATE POLICY psa_connections_isolation
  ON psa_connections
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

-- ============================================
-- Step 3: psa_ticket_mappings — rewrite the join policies to dual-axis
-- ============================================
--
-- Tenancy join: psa_ticket_mappings.connection_id -> psa_connections. The old
-- policies asserted breeze_has_org_access(pc.org_id), which is FALSE whenever
-- pc.org_id IS NULL — i.e. for every partner-owned connection. Collapsed from
-- four per-command policies to one, matching the parent above.
--
-- USING and WITH CHECK are deliberately DIFFERENT, because reading and writing
-- make different tenancy claims:
--
--   USING      = system OR connection-accessible OR device-org OR alert-org
--   WITH CHECK = system OR connection-accessible ONLY
--
-- Reading or deleting a row that references YOUR OWN device or alert is a
-- legitimate claim — that ticket is your org's record, the same principle
-- playbook step 5 states for every worker-created child row (they take the
-- DEVICE's org, not the policy's). But ATTACHING a mapping to a connection is a
-- claim on the CONNECTION, so the write path must not accept device/alert
-- ownership as a substitute. A symmetric policy would have let a tenant who
-- merely owns a device forge a mapping onto a FOREIGN partner's connection,
-- contradicting this file's own "connection_id is the tenancy anchor" rule.
--
-- Both read arms are load-bearing for deleteDeviceCascade
-- (services/deviceDeletion.ts), which runs in the REQUEST context — org-scoped
-- RLS for an org token. Its pre-clear matches on `alert_id IN (...) OR
-- device_id = ...`, so under a PARTNER-owned connection:
--   * device_id set   -> needs the device arm
--   * device_id NULL, alert_id set -> needs the ALERT arm
-- Without the relevant arm the DELETE silently matches zero rows and the
-- cascade's follow-on `DELETE FROM alerts` / `DELETE FROM devices` fails with
-- 23503 — a 500 on an ordinary device delete.
--
-- connection_id is NOT NULL and remains the primary tenancy anchor for WRITES;
-- device_id and alert_id are nullable and widen READS only.
--
-- NOTE ON ROW VISIBILITY vs AUTHORIZATION: the connection arm passes for ANY
-- partner-scope caller of the owning partner, necessarily so — a mapping with
-- neither anchor has no org for Postgres to check. Postgres therefore cannot
-- express partner_users.org_access='selected' here. Narrowing ticket reads to a
-- restricted partner user's accessible orgs is done in the app layer by
-- psaTicketMappingOrgCondition (routes/psa.ts); that condition is the
-- enforcement point for the refinement and is not redundant with this policy.

ALTER TABLE psa_ticket_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_ticket_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON psa_ticket_mappings;
DROP POLICY IF EXISTS psa_ticket_mappings_isolation ON psa_ticket_mappings;
CREATE POLICY psa_ticket_mappings_isolation
  ON psa_ticket_mappings
  -- READ/DELETE: connection access, OR ownership of the referenced device or alert.
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND (
           (pc.org_id IS NOT NULL AND public.breeze_has_org_access(pc.org_id))
           OR (pc.partner_id IS NOT NULL AND public.breeze_has_partner_access(pc.partner_id))
         )
    )
    OR EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = psa_ticket_mappings.device_id
         AND public.breeze_has_org_access(d.org_id)
    )
    OR EXISTS (
      SELECT 1 FROM alerts a
       WHERE a.id = psa_ticket_mappings.alert_id
         AND public.breeze_has_org_access(a.org_id)
    )
  )
  -- WRITE: connection access ONLY. Owning the device or alert does NOT license
  -- attaching a mapping to someone else's connection.
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND (
           (pc.org_id IS NOT NULL AND public.breeze_has_org_access(pc.org_id))
           OR (pc.partner_id IS NOT NULL AND public.breeze_has_partner_access(pc.partner_id))
         )
    )
  );
