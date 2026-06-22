-- Promote SentinelOne integrations from org-owned credentials to partner-owned
-- credentials with explicit S1 site -> Breeze organization mapping.
-- Mirrors 2026-06-12-a-huntress-partner-mapping.sql.

-- 1. Add partner_id, relax org_id to legacy nullable, backfill from org.
ALTER TABLE s1_integrations
  ADD COLUMN IF NOT EXISTS partner_id uuid;

ALTER TABLE s1_integrations
  ALTER COLUMN org_id DROP NOT NULL;

UPDATE s1_integrations si
SET partner_id = o.partner_id
FROM organizations o
WHERE si.partner_id IS NULL
  AND si.org_id = o.id;

DO $$
BEGIN
  ALTER TABLE s1_integrations
    ADD CONSTRAINT s1_integrations_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES partners(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*)::int INTO missing_count
  FROM s1_integrations
  WHERE partner_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot promote SentinelOne integrations: % row(s) have no resolvable partner_id from org_id', missing_count;
  END IF;
END $$;

ALTER TABLE s1_integrations
  ALTER COLUMN partner_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS s1_integrations_id_partner_idx
  ON s1_integrations(id, partner_id);

DROP INDEX IF EXISTS s1_integrations_org_idx;

CREATE INDEX IF NOT EXISTS s1_integrations_legacy_org_idx
  ON s1_integrations(org_id);

-- 2. Dedup to one active integration per partner (most-recent wins), with count.
DO $$
DECLARE
  deactivated integer;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY partner_id
        ORDER BY
          CASE WHEN is_active THEN 0 ELSE 1 END,
          updated_at DESC,
          created_at DESC,
          id
      ) AS rn
    FROM s1_integrations
  )
  UPDATE s1_integrations si
  SET is_active = false,
      updated_at = now(),
      last_sync_status = COALESCE(si.last_sync_status, 'inactive'),
      last_sync_error = COALESCE(si.last_sync_error, 'Deactivated during partner-level SentinelOne promotion because another active integration exists for this partner.')
  FROM ranked
  WHERE si.id = ranked.id
    AND ranked.rn > 1
    AND si.is_active = true;
  GET DIAGNOSTICS deactivated = ROW_COUNT;
  IF deactivated > 0 THEN
    RAISE WARNING 'Deactivated % duplicate SentinelOne integration(s) during partner promotion', deactivated;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS s1_integrations_partner_active_idx
  ON s1_integrations(partner_id)
  WHERE is_active = true;

-- 3. Partner-axis discovery + mapping table.
CREATE TABLE IF NOT EXISTS s1_org_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  s1_site_id varchar(128) NOT NULL,
  s1_site_name varchar(200),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  agents_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  last_seen_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT s1_org_mappings_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES s1_integrations(id, partner_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_org_mappings_integration_site_idx
  ON s1_org_mappings(integration_id, s1_site_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_org_idx
  ON s1_org_mappings(org_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_integration_idx
  ON s1_org_mappings(integration_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_partner_idx
  ON s1_org_mappings(partner_id);

-- 4. Backfill legacy name-keyed site mappings as PROVISIONAL rows. The first
-- post-migration sync matches discovered sites by name, rewrites s1_site_id to
-- the real id, and clears the provisional flag (carrying org_id forward).
-- Only migrate rows belonging to a surviving active integration's partner.
DO $$
DECLARE
  migrated integer;
BEGIN
  INSERT INTO s1_org_mappings (
    integration_id, partner_id, s1_site_id, s1_site_name, org_id, metadata, last_seen_at, updated_at
  )
  SELECT
    sm.integration_id,
    si.partner_id,
    'name:' || sm.site_name,
    sm.site_name,
    sm.org_id,
    jsonb_build_object('source', 'migration', 'provisional', true),
    now(),
    now()
  FROM s1_site_mappings sm
  JOIN s1_integrations si ON si.id = sm.integration_id
  ON CONFLICT (integration_id, s1_site_id) DO NOTHING;
  GET DIAGNOSTICS migrated = ROW_COUNT;
  RAISE WARNING 'Migrated % legacy SentinelOne site mapping(s) as provisional rows', migrated;
END $$;

-- 5. RLS: swap s1_integrations org-axis -> partner-axis.
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON s1_integrations;

ALTER TABLE s1_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON s1_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON s1_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON s1_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON s1_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 6. RLS: s1_org_mappings partner-axis with FK-integrity on writes.
DROP POLICY IF EXISTS breeze_partner_isolation_select ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON s1_org_mappings;

ALTER TABLE s1_org_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_org_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON s1_org_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON s1_org_mappings
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1 FROM s1_integrations si
      WHERE si.id = s1_org_mappings.integration_id
        AND si.partner_id = s1_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_update ON s1_org_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1 FROM s1_integrations si
      WHERE si.id = s1_org_mappings.integration_id
        AND si.partner_id = s1_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_delete ON s1_org_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- NOTE: s1_site_mappings is intentionally retained (not dropped) so the legacy
-- table remains as a forensic record post-migration. A follow-up migration may
-- drop it once provisional reconciliation is confirmed in prod.
