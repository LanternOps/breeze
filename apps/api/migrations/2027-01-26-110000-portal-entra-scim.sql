-- Portal registration W9 (#11386): Entra SCIM Users provisioning.
-- Plan: docs/superpowers/plans/portal/2026-11-15-portal-registration-w09-entra-scim.md
--   (Task 1; decisions D1, D3).
-- DDL only: writes no rows. autoMigrate wraps the file in a transaction: no
-- BEGIN/COMMIT. Idempotent: every column, constraint, index, table and policy
-- is guarded. System scope is elected anyway (repo rule; harmless for DDL).
SELECT set_config('breeze.scope', 'system', true);

-- 1. portal_scim_tokens: the SCIM bearer credential of one org (D1). Tenancy
--    shape 1; org_id NOT NULL by design — a credential bound to one org's
--    PROVEN Entra tenant, not configuration (a partner-wide token would let one
--    customer's tenant write into another customer's org). Only a SHA-256 of
--    the secret is stored; the secret itself exists once, in the create
--    response. A token authenticates only while entra_tenant_id is still the
--    org's proven tenant (re-checked per request, D2).
CREATE TABLE IF NOT EXISTS public.portal_scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entra_tenant_id text NOT NULL,
  label text NOT NULL,
  secret_hash char(64) NOT NULL,
  secret_hint text NOT NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT portal_scim_tokens_label_chk CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT portal_scim_tokens_secret_hash_chk CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portal_scim_tokens_secret_hint_chk CHECK (char_length(secret_hint) BETWEEN 1 AND 8),
  CONSTRAINT portal_scim_tokens_tenant_chk CHECK (entra_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
CREATE INDEX IF NOT EXISTS portal_scim_tokens_org_live_idx
  ON public.portal_scim_tokens (org_id) WHERE revoked_at IS NULL;

ALTER TABLE public.portal_scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_scim_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_scim_tokens;
CREATE POLICY breeze_org_isolation_select ON public.portal_scim_tokens
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_scim_tokens;
CREATE POLICY breeze_org_isolation_insert ON public.portal_scim_tokens
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_scim_tokens;
CREATE POLICY breeze_org_isolation_update ON public.portal_scim_tokens
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_scim_tokens;
CREATE POLICY breeze_org_isolation_delete ON public.portal_scim_tokens
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_scim_tokens TO breeze_app;

-- 2. portal_user_identities: SCIM state of an Entra identity (D3). A SCIM User
--    IS an identity of the org's proven tenant; its SCIM id is the identity id
--    and its externalId is `subject` (the Entra object id). Non-null
--    scim_provisioned_at = SCIM-managed; scim_deleted_at = a SCIM DELETE was
--    received (the resource 404s until a new POST adopts the identity again).
--    The name parts are kept as SCIM sent them, so a PATCH of one part keeps
--    the others and GET returns exactly what Entra wrote (D5).
ALTER TABLE public.portal_user_identities
  ADD COLUMN IF NOT EXISTS scim_user_name text,
  ADD COLUMN IF NOT EXISTS scim_display_name text,
  ADD COLUMN IF NOT EXISTS scim_given_name text,
  ADD COLUMN IF NOT EXISTS scim_family_name text,
  ADD COLUMN IF NOT EXISTS scim_provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS scim_deleted_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_user_identities'::regclass
                    AND conname = 'portal_user_identities_scim_chk') THEN
    ALTER TABLE public.portal_user_identities
      ADD CONSTRAINT portal_user_identities_scim_chk CHECK (
            ((scim_user_name IS NULL) = (scim_provisioned_at IS NULL))
        AND (scim_deleted_at IS NULL OR scim_provisioned_at IS NOT NULL)
        AND (scim_provisioned_at IS NULL OR provider = 'entra')
        AND (scim_user_name IS NULL OR char_length(scim_user_name) BETWEEN 3 AND 320)
        AND (scim_display_name IS NULL OR char_length(scim_display_name) <= 256)
        AND (scim_given_name IS NULL OR char_length(scim_given_name) <= 256)
        AND (scim_family_name IS NULL OR char_length(scim_family_name) <= 256));
  END IF;
END $$;

-- userName lookups (the SCIM `userName eq` filter). Deliberately NOT unique:
-- identities repoint on org merge with no dedupe because their unique keys are
-- org-free (orgMergeRegistry.ts), and an org-scoped unique key could abort a
-- merge on a recycled UPN. The SCIM service enforces userName uniqueness per
-- (org, issuer) under the address lock instead (plan D3).
CREATE INDEX IF NOT EXISTS portal_user_identities_scim_user_name_idx
  ON public.portal_user_identities (org_id, issuer, lower(scim_user_name))
  WHERE scim_provisioned_at IS NOT NULL AND scim_deleted_at IS NULL;
