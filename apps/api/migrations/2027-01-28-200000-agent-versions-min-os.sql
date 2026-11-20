-- #12169 (plan PR #12173, W1): the minimum OS each released agent binary
-- supports, sourced from the signed release manifest's per-asset `minOs`
-- (declared in agent/platform-floors.json). The API never offers or sends a
-- darwin build to a Mac below this floor (services/agentOsFloor.ts).
--
-- agent_versions is a GLOBAL, non-tenant release catalog: no org_id, no RLS
-- (allowlisted in rls-coverage.integration.test.ts). So there are no
-- policies, and nothing to register for org cascade, org merge or tenant
-- export. The column is nullable with no default and no backfill (NULL = no
-- floor known, which allows the offer), and no rows are written. The system
-- scope election below is kept for raw replay safety per the README.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS min_os_version varchar(16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_versions_min_os_version_chk'
       AND conrelid = 'public.agent_versions'::regclass
  ) THEN
    ALTER TABLE agent_versions ADD CONSTRAINT agent_versions_min_os_version_chk
      CHECK (min_os_version IS NULL OR min_os_version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$');
  END IF;
END $$;
