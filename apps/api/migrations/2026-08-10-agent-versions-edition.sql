-- Agent build editions ("self-host" vs "hosted") coexisting side-by-side in
-- agent_versions. The public GitHub release now carries the self-host build
-- (possibly unsigned) while a hosted deployment distributes its own build
-- privately; each server only serves/promotes rows matching its own
-- BINARY_EDITION (see services/binaryEdition.ts). Existing rows backfill to
-- 'self-host' via the column default (single-pass, no table rewrite).
ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS edition varchar(20) NOT NULL DEFAULT 'self-host';

-- Widen the uniqueness constraint to include edition so the same
-- (version, platform, architecture, component) can be registered once per
-- edition instead of colliding.
DO $$ BEGIN
  ALTER TABLE agent_versions DROP CONSTRAINT IF EXISTS agent_versions_version_platform_arch_component_unique;
  ALTER TABLE agent_versions DROP CONSTRAINT IF EXISTS agent_versions_version_platform_arch_component_edition_unique;
  ALTER TABLE agent_versions ADD CONSTRAINT agent_versions_version_platform_arch_component_edition_unique
    UNIQUE (version, platform, architecture, component, edition);
END $$;

CREATE INDEX IF NOT EXISTS agent_versions_edition_idx ON agent_versions (edition);
