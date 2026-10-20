-- Tool Catalog W03 (#5215 / #5218) — the `flows` table (draft flows only).
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §6.4.
-- Plan: docs/superpowers/plans/ai-mcp/2026-10-17-tool-catalog-w3-flows-document-validator.md Task A4.
--
-- Tenancy shape: flows is a CONFIG table (an MSP defines one flow and applies
-- it across every managed org), so it follows the "Partner-Wide First"
-- playbook — org_id XOR partner_id with a one-owner CHECK, ONE dual-axis
-- FOR ALL policy, and a SEPARATE additive FOR SELECT partner-wide branch keyed
-- on breeze_current_partner_id() so an ORG-scoped session can READ its
-- partner's partner-wide flows. The branch is never appended to the FOR ALL
-- policy: Postgres does not consult FOR SELECT policies when computing
-- UPDATE/DELETE target rows, so an org token can read a partner-wide flow but
-- its UPDATE matches 0 rows. Template: 2026-10-16-193500-tool-sources.sql §4.
--
-- status is text + CHECK (not a pg enum) so W04/W05 widen it with a guarded
-- CHECK swap instead of ALTER TYPE … ADD VALUE. Webhook columns (secret +
-- fingerprint) arrive with W05 together with their encryptor and rotation.
--
-- No composite FK references an org_id column, so nothing here needs
-- DEFERRABLE (org merge repoints flows.org_id directly).
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS + CREATE);
-- no inner BEGIN/COMMIT. No DML, so no system-scope election is needed.
--
-- Rollback: a new migration dropping the table. Nothing reads it outside the
-- W03 code, which is behind FLOWS_ENABLED (default off).

CREATE TABLE IF NOT EXISTS flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  slug varchar(48) NOT NULL,
  name varchar(120) NOT NULL,
  description text,
  definition jsonb NOT NULL,
  definition_version integer NOT NULL DEFAULT 1,
  effective_tier smallint NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  paused_reason text,
  enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  enabled_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Provenance only, back-filled from the authenticated chat session (never
  -- from tool input). Erasing a session nulls it instead of blocking.
  ai_session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  managed_by_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_one_owner_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- Mirrors FLOW_SLUG_RE + isValidFlowSlug in packages/shared/src/validators/flows.ts.
  -- No '__' so `flow__<slug>` always splits at its first '__' (W05).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_slug_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_slug_chk CHECK (slug ~ '^[a-z][a-z0-9_]{1,47}$' AND position('__' in slug) = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_status_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_status_chk CHECK (status IN ('draft', 'enabled', 'paused', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_paused_reason_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_paused_reason_chk CHECK ((status = 'paused') = (paused_reason IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_effective_tier_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_effective_tier_chk CHECK (effective_tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_definition_version_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_definition_version_chk CHECK (definition_version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flows_definition_object_chk' AND conrelid = 'flows'::regclass) THEN
    ALTER TABLE flows ADD CONSTRAINT flows_definition_object_chk CHECK (jsonb_typeof(definition) = 'object');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS flows_org_slug_uq ON flows (org_id, slug) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS flows_partner_slug_uq ON flows (partner_id, slug) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS flows_org_status_idx ON flows (org_id, status);
CREATE INDEX IF NOT EXISTS flows_partner_wide_idx ON flows (partner_id) WHERE org_id IS NULL;

-- ============================================
-- RLS — one dual-axis FOR ALL policy plus the additive SELECT-only
-- own-partner read branch (#4673).
-- ============================================
ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flows_isolation ON flows;
CREATE POLICY flows_isolation
  ON flows
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
DROP POLICY IF EXISTS flows_partner_wide_select ON flows;
CREATE POLICY flows_partner_wide_select
  ON flows
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON flows TO breeze_app;
