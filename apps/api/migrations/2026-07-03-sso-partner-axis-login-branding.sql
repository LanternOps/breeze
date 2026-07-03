-- Partner-axis SSO providers + partner login branding (#2183, epic #2135 playbook).
--
-- sso_providers becomes dual-ownership: org-axis (org_id set, partner_id NULL —
-- the existing customer-org SSO shape) OR partner-axis (partner_id set, org_id
-- NULL — the MSP's own technician login). Exactly one axis per row (CHECK).
-- user_sso_identities is unchanged: it keys off provider_id, and the provider
-- row carries ownership. sso_sessions gains a nullable link_user_id: when set,
-- the session is a LINK-mode round-trip (an already-authenticated user
-- connecting their SSO identity) rather than a login. sso_verified_domains
-- stays org-only (it gates JIT, which partner-axis providers do not do in v1).
--
-- partner_login_branding is deliberately partner-ONLY (not dual-axis): org-level
-- login branding already exists as portal_branding.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. No inner BEGIN/COMMIT (autoMigrate wraps each file).

-- ============================================
-- Step 1: sso_providers — add partner_id, relax org_id, exactly-one-axis
-- ============================================

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE sso_providers
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_providers_one_owner_chk'
      AND conrelid = 'sso_providers'::regclass
  ) THEN
    ALTER TABLE sso_providers
      ADD CONSTRAINT sso_providers_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sso_providers_partner_id_idx
  ON sso_providers(partner_id);

-- Link-mode marker for the self-service Connect SSO flow: when set, the
-- callback links the verified identity to THIS user instead of logging in.
ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS link_user_id uuid REFERENCES users(id);

-- ============================================
-- Step 2: sso_providers RLS — dual-axis (org OR partner) + FORCE
-- ============================================

ALTER TABLE sso_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_providers FORCE ROW LEVEL SECURITY;

-- Pre-existing policies on this table are per-command
-- (breeze_org_isolation_{select,insert,update,delete}), not the single-name
-- shape assumed elsewhere in this playbook. Drop all of them plus the
-- conventionally-named single policy, whichever exist, before creating the
-- combined dual-axis policy below.
DROP POLICY IF EXISTS breeze_org_isolation_select ON sso_providers;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON sso_providers;
DROP POLICY IF EXISTS breeze_org_isolation_update ON sso_providers;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON sso_providers;
DROP POLICY IF EXISTS sso_providers_org_isolation ON sso_providers;

CREATE POLICY sso_providers_org_isolation
  ON sso_providers
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
-- Step 3: partner_login_branding — table + partner-axis RLS + FORCE
-- ============================================

CREATE TABLE IF NOT EXISTS partner_login_branding (
  partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  logo_url text,
  accent_color varchar(7),
  headline varchar(120),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE partner_login_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_login_branding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_login_branding_partner_isolation ON partner_login_branding;
CREATE POLICY partner_login_branding_partner_isolation
  ON partner_login_branding
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );
