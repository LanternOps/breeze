-- organization_external_links (issue #3242, epic #3249):
--
-- One-to-many external-system linkage for organizations, replacing the
-- single-valued organizations.accounting_provider / accounting_external_id
-- pair as the idempotency key for every org import source (CSV today,
-- PSA #3246 and accounting next). A migrating MSP legitimately has one org
-- linked to a Datto CSV, ConnectWise for ticketing, and QuickBooks for
-- billing simultaneously — the single-valued pair cannot represent that, and
-- overwriting it silently breaks the previous importer's dedupe (duplicate
-- tenant creation). Design:
-- docs/superpowers/specs/onboarding-signup/2026-08-08-bulk-org-site-import-design.md
--
-- partner_id is denormalised so uniqueness can be scoped per partner (two
-- MSPs can both import a Datto site UID '12345'); the composite FK to
-- organizations (id, partner_id) — same pattern as
-- deployment_invites_org_partner_fk (2026-05-03) against the non-partial
-- unique index organizations_id_partner_id_unique — makes a mismatched pair
-- unrepresentable. Both columns are NOT NULL, so MATCH SIMPLE never softens
-- the check.
--
-- No json/jsonb/bytea column, deliberately: open containers are classified
-- excludedOpen and would be dropped from tenant export. label is plain text
-- so the whole row survives an export. Do not add a metadata jsonb later
-- without accepting that cost.
--
-- Tenancy: Shape 1 (direct org_id), auto-discovered by the RLS coverage
-- contract test — no allowlist entry. RLS enabled AND forced with all four
-- breeze_has_org_access(org_id) policies in this same migration (never
-- deferred). All import writes run in system context; partner-scoped readers
-- already satisfy breeze_has_org_access for their accessible orgs, so an
-- org-axis policy is sufficient and strictly tighter than dual-axis.
--
-- Cascade contracts (registered in the same PR):
--   - CORE_ORG_CASCADE_DELETE_ORDER (services/tenantCascade.ts)
--   - CORE_TENANT_EXPORT_POLICY (services/tenantExportPolicyRegistry.ts)
--   - No device cascade entry (no device_id), not append-only.
--   - Partner erasure needs no registration: cascadeDeletePartner sweeps
--     information_schema for partner_id columns dynamically.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO block for the
-- constraint, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before each
-- CREATE POLICY, backfill with ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS organization_external_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  partner_id   uuid NOT NULL,
  system       text NOT NULL,
  external_id  text NOT NULL,
  label        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_external_links_org_partner_fk'
  ) THEN
    ALTER TABLE organization_external_links
      ADD CONSTRAINT organization_external_links_org_partner_fk
      FOREIGN KEY (org_id, partner_id)
      REFERENCES organizations (id, partner_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS organization_external_links_uniq
  ON organization_external_links (partner_id, system, external_id);
CREATE INDEX IF NOT EXISTS organization_external_links_org_idx
  ON organization_external_links (org_id);

-- RLS: direct org_id (Shape 1) — standard org isolation, enabled AND forced.
ALTER TABLE organization_external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_external_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON organization_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON organization_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON organization_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON organization_external_links;

CREATE POLICY breeze_org_isolation_select ON organization_external_links FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON organization_external_links FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON organization_external_links FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON organization_external_links FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON organization_external_links TO breeze_app;

-- Backfill the shipped QuickBooks links so orgs linked via the legacy columns
-- match through the link table too. Reported count (even 0) preserves the
-- forensic trail; re-running is a no-op via the unique index + ON CONFLICT.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO organization_external_links (org_id, partner_id, system, external_id)
  SELECT id, partner_id, accounting_provider, accounting_external_id
  FROM organizations
  WHERE accounting_external_id IS NOT NULL AND accounting_provider IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % accounting external links', n;
END $$;
