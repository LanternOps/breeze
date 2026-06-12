-- Promote Huntress integrations from org-owned credentials to partner-owned
-- credentials with explicit Huntress organization -> Breeze organization mapping.

ALTER TABLE huntress_integrations
  ADD COLUMN IF NOT EXISTS partner_id uuid;

ALTER TABLE huntress_integrations
  ALTER COLUMN org_id DROP NOT NULL;

UPDATE huntress_integrations hi
SET partner_id = o.partner_id
FROM organizations o
WHERE hi.partner_id IS NULL
  AND hi.org_id = o.id;

DO $$
BEGIN
  ALTER TABLE huntress_integrations
    ADD CONSTRAINT huntress_integrations_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES partners(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*)::int INTO missing_count
  FROM huntress_integrations
  WHERE partner_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot promote Huntress integrations: % row(s) have no resolvable partner_id from org_id', missing_count;
  END IF;
END $$;

ALTER TABLE huntress_integrations
  ALTER COLUMN partner_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS huntress_integrations_id_partner_idx
  ON huntress_integrations(id, partner_id);

CREATE TABLE IF NOT EXISTS huntress_org_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  huntress_org_id varchar(128) NOT NULL,
  huntress_org_name varchar(255),
  huntress_org_key varchar(120),
  huntress_account_id varchar(120),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  agents_count integer NOT NULL DEFAULT 0,
  incidents_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  last_seen_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT huntress_org_mappings_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES huntress_integrations(id, partner_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS huntress_org_mappings_integration_org_idx
  ON huntress_org_mappings(integration_id, huntress_org_id);

CREATE INDEX IF NOT EXISTS huntress_org_mappings_org_idx
  ON huntress_org_mappings(org_id);

CREATE INDEX IF NOT EXISTS huntress_org_mappings_integration_idx
  ON huntress_org_mappings(integration_id);

CREATE INDEX IF NOT EXISTS huntress_org_mappings_partner_idx
  ON huntress_org_mappings(partner_id);

DROP INDEX IF EXISTS huntress_integrations_org_idx;

CREATE INDEX IF NOT EXISTS huntress_integrations_legacy_org_idx
  ON huntress_integrations(org_id);

-- Only one active partner-level Huntress integration should exist. Historical
-- duplicates are retained for audit/legacy child rows but deactivated so the
-- active partial unique index can be enforced.
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
  FROM huntress_integrations
)
UPDATE huntress_integrations hi
SET is_active = false,
    updated_at = now(),
    last_sync_status = COALESCE(hi.last_sync_status, 'inactive'),
    last_sync_error = COALESCE(hi.last_sync_error, 'Deactivated during partner-level Huntress promotion because another active integration exists for this partner.')
FROM ranked
WHERE hi.id = ranked.id
  AND ranked.rn > 1
  AND hi.is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS huntress_integrations_partner_active_idx
  ON huntress_integrations(partner_id)
  WHERE is_active = true;

-- Safe promotion mapping: only map the old Breeze org when existing child rows
-- contain exactly one Huntress organization id for that integration. Ambiguous
-- or missing ids stay quarantined until a partner admin maps them explicitly.
WITH agent_orgs AS (
  SELECT
    integration_id,
    NULLIF(metadata->>'organization_id', '') AS huntress_org_id,
    NULLIF(metadata->>'account_id', '') AS huntress_account_id,
    COUNT(*)::int AS agents_count,
    0::int AS incidents_count
  FROM huntress_agents
  WHERE metadata ? 'organization_id'
  GROUP BY integration_id, metadata->>'organization_id', metadata->>'account_id'
),
incident_orgs AS (
  SELECT
    integration_id,
    COALESCE(
      NULLIF(details->>'organization_id', ''),
      NULLIF(details #>> '{organization,id}', '')
    ) AS huntress_org_id,
    COALESCE(
      NULLIF(details->>'account_id', ''),
      NULLIF(details #>> '{account,id}', '')
    ) AS huntress_account_id,
    0::int AS agents_count,
    COUNT(*)::int AS incidents_count
  FROM huntress_incidents
  WHERE details ? 'organization_id'
     OR details ? 'organization'
  GROUP BY
    integration_id,
    COALESCE(NULLIF(details->>'organization_id', ''), NULLIF(details #>> '{organization,id}', '')),
    COALESCE(NULLIF(details->>'account_id', ''), NULLIF(details #>> '{account,id}', ''))
),
combined AS (
  SELECT * FROM agent_orgs WHERE huntress_org_id IS NOT NULL
  UNION ALL
  SELECT * FROM incident_orgs WHERE huntress_org_id IS NOT NULL
),
rolled AS (
  SELECT
    integration_id,
    huntress_org_id,
    MAX(huntress_account_id) AS huntress_account_id,
    SUM(agents_count)::int AS agents_count,
    SUM(incidents_count)::int AS incidents_count
  FROM combined
  GROUP BY integration_id, huntress_org_id
),
unambiguous AS (
  SELECT integration_id
  FROM rolled
  GROUP BY integration_id
  HAVING COUNT(*) = 1
)
INSERT INTO huntress_org_mappings (
  integration_id,
  partner_id,
  huntress_org_id,
  huntress_account_id,
  org_id,
  agents_count,
  incidents_count,
  metadata,
  last_seen_at,
  updated_at
)
SELECT
  r.integration_id,
  hi.partner_id,
  r.huntress_org_id,
  r.huntress_account_id,
  hi.org_id,
  r.agents_count,
  r.incidents_count,
  jsonb_build_object('source', 'migration'),
  now(),
  now()
FROM rolled r
JOIN unambiguous u ON u.integration_id = r.integration_id
JOIN huntress_integrations hi ON hi.id = r.integration_id
WHERE hi.org_id IS NOT NULL
ON CONFLICT (integration_id, huntress_org_id) DO UPDATE
SET
  partner_id = EXCLUDED.partner_id,
  huntress_account_id = COALESCE(EXCLUDED.huntress_account_id, huntress_org_mappings.huntress_account_id),
  org_id = COALESCE(EXCLUDED.org_id, huntress_org_mappings.org_id),
  agents_count = EXCLUDED.agents_count,
  incidents_count = EXCLUDED.incidents_count,
  updated_at = now();

DROP POLICY IF EXISTS breeze_org_isolation_select ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON huntress_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON huntress_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON huntress_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON huntress_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON huntress_integrations;

ALTER TABLE huntress_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huntress_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON huntress_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON huntress_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON huntress_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON huntress_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON huntress_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON huntress_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON huntress_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON huntress_org_mappings;

ALTER TABLE huntress_org_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE huntress_org_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON huntress_org_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON huntress_org_mappings
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM huntress_integrations hi
      WHERE hi.id = huntress_org_mappings.integration_id
        AND hi.partner_id = huntress_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_update ON huntress_org_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM huntress_integrations hi
      WHERE hi.id = huntress_org_mappings.integration_id
        AND hi.partner_id = huntress_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_delete ON huntress_org_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
