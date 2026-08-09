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
-- THREE arms, not two. The third (device_id -> devices.org_id) is not
-- cosmetic: deleteDeviceCascade (services/deviceDeletion.ts) runs in the
-- REQUEST context, which for an org-scope token is org-scoped RLS. Without the
-- device arm, a mapping hanging off a PARTNER-owned connection is invisible to
-- that token, its DELETE silently matches zero rows, and the subsequent
-- `DELETE FROM devices` fails with 23503 — a 500 on an ordinary device delete.
-- The arm is also correct on the merits: a ticket about MY device is MY org's
-- record, which is the same principle playbook step 5 states for every
-- worker-created child row (they take the DEVICE's org, not the policy's).
--
-- connection_id is NOT NULL and remains the primary tenancy anchor; device_id
-- and alert_id are nullable, so they widen access but can never be the sole
-- basis for it.

ALTER TABLE psa_ticket_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_ticket_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON psa_ticket_mappings;
DROP POLICY IF EXISTS psa_ticket_mappings_isolation ON psa_ticket_mappings;
CREATE POLICY psa_ticket_mappings_isolation
  ON psa_ticket_mappings
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
  )
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
    OR EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = psa_ticket_mappings.device_id
         AND public.breeze_has_org_access(d.org_id)
    )
  );
