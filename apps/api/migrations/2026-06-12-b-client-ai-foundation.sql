-- 2026-06-12-b-client-ai-foundation.sql
-- Breeze AI for Office, Plan 1 (Foundation).
-- Spec: docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md §3, §7, §8, §10, §12.
--
-- 1. portal_users: Entra identity columns + partial unique identity index.
-- 2. client_ai_tenant_mappings  — Entra tenant GUID -> org (RLS shape 1).
-- 3. client_ai_org_policies     — per-org product policy (RLS shape 1).
-- 4. client_ai_usage            — per-org/per-user metering buckets (RLS shape 1).
-- 5. client_ai_prompt_templates — org-scoped OR partner-wide rows (dual-axis RLS,
--    the custom_field_definitions shape — see 2026-06-11-i and spec §10 warning).
-- 6. ai_sessions: client_user_id principal + principal CHECKs.
--
-- Idempotent throughout. autoMigrate wraps the file in a transaction — no inner
-- BEGIN/COMMIT.

-- ── 1. portal_users: Entra identity ─────────────────────────────────────────
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_oid TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_tenant_id TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'password';

-- password_hash is already nullable in the current schema (schema/portal.ts:39
-- declares text with no notNull). Guarded DROP NOT NULL for any DB whose
-- baseline predates that — re-runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'portal_users'
      AND column_name = 'password_hash' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE portal_users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'portal_users_auth_method_check'
      AND conrelid = 'portal_users'::regclass
  ) THEN
    ALTER TABLE portal_users
      ADD CONSTRAINT portal_users_auth_method_check
      CHECK (auth_method IN ('password', 'entra'));
  END IF;
END $$;

-- One portal user per (tenant, oid); password-only rows (entra_oid NULL) exempt.
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_entra_identity_uniq
  ON portal_users (entra_tenant_id, entra_oid)
  WHERE entra_oid IS NOT NULL;

-- ── 2. client_ai_tenant_mappings (RLS shape 1) ───────────────────────────────
-- The tenant-isolation linchpin: an Entra tenant maps to exactly ONE org
-- (unique on entra_tenant_id), and in v1 an org carries at most one mapping
-- (unique on org_id; the admin route is the singular /tenant-mapping).
-- GUID CHECK mirrors 2026-05-31-c2c-tenant-id-guid-check.sql.
CREATE TABLE IF NOT EXISTS client_ai_tenant_mappings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entra_tenant_id  TEXT NOT NULL,
  created_by       UUID,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_tenant_mappings_tenant_guid_check
    CHECK (entra_tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_tenant_mappings_tenant_uniq
  ON client_ai_tenant_mappings (entra_tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS client_ai_tenant_mappings_org_uniq
  ON client_ai_tenant_mappings (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_tenant_mappings;

ALTER TABLE client_ai_tenant_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_tenant_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_tenant_mappings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_tenant_mappings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_tenant_mappings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_tenant_mappings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 3. client_ai_org_policies (RLS shape 1) ──────────────────────────────────
-- One row per org; absence == product disabled with defaults (the service layer
-- materialises defaults — see services/clientAiPolicy.ts). Separate from the
-- technician ai budgets table by design (spec §7).
CREATE TABLE IF NOT EXISTS client_ai_org_policies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled                       BOOLEAN NOT NULL DEFAULT false,
  user_access                   TEXT NOT NULL DEFAULT 'all',
  selected_user_ids             JSONB NOT NULL DEFAULT '[]',
  allowed_providers             JSONB NOT NULL DEFAULT '["anthropic"]',
  allowed_models                JSONB NOT NULL DEFAULT '[]',
  write_mode                    TEXT NOT NULL DEFAULT 'readwrite',
  dlp_config                    JSONB NOT NULL DEFAULT '{}',
  daily_budget_cents            INTEGER,
  monthly_budget_cents          INTEGER,
  per_user_messages_per_minute  INTEGER NOT NULL DEFAULT 10,
  org_messages_per_hour         INTEGER NOT NULL DEFAULT 500,
  retention_days                INTEGER,
  branding                      JSONB NOT NULL DEFAULT '{}',
  created_at                    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_org_policies_user_access_check
    CHECK (user_access IN ('all', 'selected')),
  CONSTRAINT client_ai_org_policies_write_mode_check
    CHECK (write_mode IN ('readwrite', 'readonly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_org_policies_org_uniq
  ON client_ai_org_policies (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_org_policies;

ALTER TABLE client_ai_org_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_org_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_org_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_org_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_org_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_org_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 4. client_ai_usage (RLS shape 1) ─────────────────────────────────────────
-- ai_cost_usage bucket pattern + a per-user dimension (spec §8). Written by the
-- Plan-2 session loop under org scope.
CREATE TABLE IF NOT EXISTS client_ai_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_user_id    UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,
  period_key        VARCHAR(10) NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_cost_cents  REAL NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_usage_period_check CHECK (period IN ('daily', 'monthly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_usage_bucket_uniq
  ON client_ai_usage (org_id, client_user_id, period, period_key);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_usage;

ALTER TABLE client_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_usage
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_usage
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_usage
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_usage
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 5. client_ai_prompt_templates (dual-axis RLS) ────────────────────────────
-- Partner-wide rows: org_id NULL, partner_id set. Org rows: org_id set,
-- partner_id NULL. EXACTLY the custom_field_definitions failure mode fixed in
-- 2026-06-11-i — created dual-axis from day one. breeze_has_org_access(NULL) is
-- FALSE, so the partner branch is load-bearing, not decorative. A functional
-- breeze_app insert test for the partner axis is REQUIRED in the same PR
-- (spec §10 warning; client-ai-templates-rls.integration.test.ts).
CREATE TABLE IF NOT EXISTS client_ai_prompt_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id   UUID REFERENCES partners(id) ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  prompt_body  TEXT NOT NULL,
  category     VARCHAR(100),
  created_by   UUID,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_prompt_templates_scope_check
    CHECK (num_nonnulls(org_id, partner_id) = 1)
);

CREATE INDEX IF NOT EXISTS client_ai_prompt_templates_org_idx
  ON client_ai_prompt_templates (org_id);
CREATE INDEX IF NOT EXISTS client_ai_prompt_templates_partner_idx
  ON client_ai_prompt_templates (partner_id);

DROP POLICY IF EXISTS breeze_dual_axis_select ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_update ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON client_ai_prompt_templates;

ALTER TABLE client_ai_prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_prompt_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_dual_axis_select ON client_ai_prompt_templates FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON client_ai_prompt_templates FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON client_ai_prompt_templates FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON client_ai_prompt_templates FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- ── 6. ai_sessions: client principal ─────────────────────────────────────────
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS client_user_id UUID REFERENCES portal_users(id);

CREATE INDEX IF NOT EXISTS ai_sessions_client_user_id_idx
  ON ai_sessions (client_user_id) WHERE client_user_id IS NOT NULL;

-- user_id is ALREADY nullable and rows with user_id IS NULL legitimately exist
-- (helper device sessions: routes/helper/index.ts inserts userId: null; MCP
-- ledger sessions: services/mcpToolExecutionLedger.ts). The spec's "exactly one
-- of (user_id, client_user_id)" is therefore relaxed to:
--   (a) never BOTH set;
--   (b) excel_client sessions always carry a client principal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_single_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_single_principal_check
      CHECK (user_id IS NULL OR client_user_id IS NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_excel_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_excel_client_principal_check
      CHECK (type <> 'excel_client' OR client_user_id IS NOT NULL);
  END IF;
END $$;
