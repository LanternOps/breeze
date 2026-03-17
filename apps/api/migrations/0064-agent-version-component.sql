-- Add component column to agent_versions (backfills existing rows as 'agent')
ALTER TABLE "agent_versions" ADD COLUMN IF NOT EXISTS "component" varchar(20) NOT NULL DEFAULT 'agent';

-- Drop old unique constraint on (version, platform, architecture) if it exists
DO $$ BEGIN
  ALTER TABLE "agent_versions" DROP CONSTRAINT "agent_versions_version_platform_arch_unique";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;

-- Add new unique constraint on (version, platform, architecture, component)
DO $$ BEGIN
  ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_version_platform_arch_component_unique"
    UNIQUE ("version", "platform", "architecture", "component");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
