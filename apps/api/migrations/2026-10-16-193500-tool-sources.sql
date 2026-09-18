-- Tool Catalog W01 (#5215 / #5216) — BYO MCP tool sources.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.
--
-- Tenancy shape: tool_sources is a CONFIG table (an MSP registers one external
-- MCP server once and every managed org can use it), so it follows the
-- CLAUDE.md "Partner-Wide First" playbook — org_id XOR partner_id with a
-- one-owner CHECK, ONE dual-axis FOR ALL policy, and a SEPARATE additive
-- FOR SELECT partner-wide branch keyed on breeze_current_partner_id() so an
-- ORG-scoped session can READ its partner's shared sources without the #1105
-- system-context escalation. The branch is never appended to the FOR ALL
-- policy: Postgres does not consult FOR SELECT policies when computing
-- UPDATE/DELETE target rows, so a separate policy widens reads and nothing
-- else. Template: 2026-10-05-110000-config-policy-partner-wide-select.sql,
-- modern example: 2026-10-16-160300-monitor-definitions.sql.
--
-- tool_source_tools DENORMALISES the owner (org_id/partner_id) from its parent
-- instead of joining, so it is a direct dual-axis table with its own indexes —
-- the resolver reads it on every chat session start and every MCP tools/list.
-- A constraint trigger keeps child owner == parent owner.
--
-- The credential lives in tool_sources.auth_config_encrypted, sealed with an
-- AAD bound to the row id (encryptedColumnRegistry aadBinding: 'row'), so a
-- ciphertext pasted into another tenant's row does not decrypt.
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS + CREATE);
-- re-applying is a no-op. No inner BEGIN/COMMIT — autoMigrate wraps each file
-- in a transaction. The permission seeding at the end WRITES rows, so system
-- scope is elected in the first statement of the file (#4518 guard).
--
-- Rollback: a new migration dropping the two tables, the three enums, the
-- trigger and its function. Nothing reads them before this wave's code, and
-- the feature is behind TOOL_SOURCES_ENABLED (default off).

SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. Enums
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_kind') THEN
    CREATE TYPE tool_source_kind AS ENUM ('mcp', 'openapi');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_auth_kind') THEN
    CREATE TYPE tool_source_auth_kind AS ENUM ('none', 'bearer', 'api_key_header', 'basic', 'oauth2_client_credentials');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_status') THEN
    CREATE TYPE tool_source_status AS ENUM ('active', 'error', 'disabled');
  END IF;
END $$;

-- ============================================
-- 2. tool_sources — one registration of an external tool server.
-- ============================================
CREATE TABLE IF NOT EXISTS tool_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  slug varchar(24) NOT NULL,
  name varchar(120) NOT NULL,
  kind tool_source_kind NOT NULL,
  endpoint_url text NOT NULL,
  credential_origin text NOT NULL,
  auth_kind tool_source_auth_kind NOT NULL DEFAULT 'none',
  auth_config_encrypted text,
  auth_fingerprint text,
  status tool_source_status NOT NULL DEFAULT 'active',
  last_discovered_at timestamptz,
  last_error text,
  rate_limit_per_minute integer NOT NULL DEFAULT 120,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_sources_one_owner_chk' AND conrelid = 'tool_sources'::regclass) THEN
    ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- Mirrors TOOL_SOURCE_SLUG_RE in packages/shared/src/validators/toolSources.ts.
  -- No underscore and no hyphen, so the FIRST '__' in a qualified tool name is
  -- always the slug/name split point.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_sources_slug_chk' AND conrelid = 'tool_sources'::regclass) THEN
    ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_slug_chk CHECK (slug ~ '^[a-z][a-z0-9]{1,23}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_sources_rate_limit_chk' AND conrelid = 'tool_sources'::regclass) THEN
    ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_rate_limit_chk CHECK (rate_limit_per_minute BETWEEN 1 AND 6000);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tool_sources_org_slug_uq ON tool_sources (org_id, slug) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tool_sources_partner_slug_uq ON tool_sources (partner_id, slug) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_sources_org_id_idx ON tool_sources (org_id);
CREATE INDEX IF NOT EXISTS tool_sources_partner_id_idx ON tool_sources (partner_id);

-- ============================================
-- 3. tool_source_tools — one discovered tool, owner denormalised from parent.
-- ============================================
CREATE TABLE IF NOT EXISTS tool_source_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES tool_sources(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  qualified_name varchar(64) NOT NULL,
  description text NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL DEFAULT '{"type":"object"}'::jsonb,
  output_schema jsonb,
  annotations jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_tier smallint NOT NULL,
  tier smallint NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  review_needed boolean NOT NULL DEFAULT false,
  revision text NOT NULL,
  last_error text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_source_tools_one_owner_chk' AND conrelid = 'tool_source_tools'::regclass) THEN
    ALTER TABLE tool_source_tools ADD CONSTRAINT tool_source_tools_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- Discovery only ever PROPOSES tier 1 (read-only annotations) or 3
  -- (anything else); a human may settle on 2.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_source_tools_tier_chk' AND conrelid = 'tool_source_tools'::regclass) THEN
    ALTER TABLE tool_source_tools ADD CONSTRAINT tool_source_tools_tier_chk CHECK (tier BETWEEN 1 AND 3 AND proposed_tier IN (1, 3));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tool_source_tools_source_name_uq ON tool_source_tools (source_id, name);
CREATE INDEX IF NOT EXISTS tool_source_tools_org_enabled_idx ON tool_source_tools (org_id) WHERE enabled AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS tool_source_tools_partner_enabled_idx ON tool_source_tools (partner_id) WHERE enabled AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS tool_source_tools_source_id_idx ON tool_source_tools (source_id);

-- Child owner must equal parent owner. A CONSTRAINT trigger (DEFERRABLE
-- INITIALLY IMMEDIATE) so the org-merge executor, which repoints parent and
-- child in separate statements under SET CONSTRAINTS ALL DEFERRED, can move a
-- whole source without tripping it mid-way.
CREATE OR REPLACE FUNCTION public.tool_source_tools_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
BEGIN
  SELECT s.org_id, s.partner_id
  INTO parent_org_id, parent_partner_id
  FROM public.tool_sources AS s
  WHERE s.id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "tool_source_tools" violates foreign key constraint "tool_source_tools_source_id_fkey"'
      USING ERRCODE = '23503',
            CONSTRAINT = 'tool_source_tools_source_id_fkey';
  END IF;

  IF NEW.org_id IS DISTINCT FROM parent_org_id
     OR NEW.partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'tool source tool owner differs from parent tool source owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tool_source_tools_parent_owner_chk';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tool_source_tools_owner_guard_trg ON tool_source_tools;
CREATE CONSTRAINT TRIGGER tool_source_tools_owner_guard_trg
  AFTER INSERT OR UPDATE OF source_id, org_id, partner_id ON tool_source_tools
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.tool_source_tools_owner_guard();

-- ============================================
-- 4. RLS — one dual-axis FOR ALL policy per table, plus the additive
--    SELECT-only own-partner read branch (#4673, CLAUDE.md step 3).
-- ============================================
ALTER TABLE tool_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_sources_isolation ON tool_sources;
CREATE POLICY tool_sources_isolation
  ON tool_sources
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

-- `=` and not IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
DROP POLICY IF EXISTS tool_sources_partner_wide_select ON tool_sources;
CREATE POLICY tool_sources_partner_wide_select
  ON tool_sources
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tool_sources TO breeze_app;

ALTER TABLE tool_source_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_source_tools FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_source_tools_isolation ON tool_source_tools;
CREATE POLICY tool_source_tools_isolation
  ON tool_source_tools
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

DROP POLICY IF EXISTS tool_source_tools_partner_wide_select ON tool_source_tools;
CREATE POLICY tool_source_tools_partner_wide_select
  ON tool_source_tools
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tool_source_tools TO breeze_app;

-- ============================================
-- 5. Permissions for already-migrated databases (seed.ts covers fresh ones).
--    Pattern: 2026-09-25-b-cross-site-restore-permission.sql — `permissions`
--    has no unique constraint on (resource, action), so use an existence check
--    rather than ON CONFLICT. Partner Admin holds the '*:*' wildcard already.
-- ============================================
DO $$
DECLARE
  r record;
  v_permission_id uuid;
  n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('tool_sources', 'read', 'View external tool sources', ARRAY['Org Admin']),
    ('tool_sources', 'write', 'Manage external tool sources', ARRAY['Org Admin']),
    ('external_tools', 'use', 'Call Tier 1 (read-only) external tools from AI', ARRAY['Org Admin', 'Org Technician', 'Partner Technician']),
    ('external_tools', 'write', 'Call Tier 2/3 (mutating) external tools from AI', ARRAY['Org Admin'])
  ) AS t(resource, action, description, roles) LOOP
    SELECT id INTO v_permission_id
    FROM permissions
    WHERE resource = r.resource AND action = r.action
    ORDER BY id
    LIMIT 1;

    IF v_permission_id IS NULL THEN
      INSERT INTO permissions (resource, action, description)
      VALUES (r.resource, r.action, r.description)
      RETURNING id INTO v_permission_id;
      RAISE WARNING 'seeded permission %:%', r.resource, r.action;
    END IF;

    -- is_system = TRUE so a custom role that happens to be named "Org Admin"
    -- does not silently inherit an external-egress capability.
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT ro.id, v_permission_id
    FROM roles ro
    WHERE ro.name = ANY (r.roles)
      AND ro.is_system = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = ro.id AND rp.permission_id = v_permission_id
      );

    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'granted %:% to % existing system role(s)', r.resource, r.action, n;
    END IF;
  END LOOP;
END $$;
