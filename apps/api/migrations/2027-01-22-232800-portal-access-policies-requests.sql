-- Portal registration W3: access policy, access requests, identities release B.
-- Spec: docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §5.1-§5.3, §5.10.
-- WRITES ROWS (identity re-backfill) → system scope first. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

-- 1. portal_access_policies: partner default XOR org override (#2135). NULL column = inherit
--    (org row) / built-in default (partner row). Read ONLY through resolvePortalAccessPolicy.
--    Template: 2026-12-20-200100-ticket-approval-settings.sql.
CREATE TABLE IF NOT EXISTS public.portal_access_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id),
  partner_id uuid REFERENCES public.partners(id),
  entra_enabled boolean,
  google_enabled boolean,
  password_mode text CHECK (password_mode IN ('allowed','sso_only')),
  self_registration_mode text CHECK (self_registration_mode IN ('off','approval','instant')),
  sso_new_person_mode text CHECK (sso_new_person_mode IN ('invited_only','approval','instant')),
  sso_session_max_hours integer CHECK (sso_session_max_hours BETWEEN 1 AND 168),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_access_policies_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_policies_partner_uq
  ON public.portal_access_policies (partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_policies_org_uq
  ON public.portal_access_policies (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.portal_access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_access_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_access_policies_tenant ON public.portal_access_policies;
CREATE POLICY portal_access_policies_tenant ON public.portal_access_policies FOR ALL
  USING (current_setting('breeze.scope', true) = 'system'
         OR public.breeze_has_org_access(org_id)
         OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (current_setting('breeze.scope', true) = 'system'
              OR public.breeze_has_org_access(org_id)
              OR public.breeze_has_partner_access(partner_id));
-- SELECT-only branches, never folded into FOR ALL (that would widen UPDATE/DELETE targeting).
DROP POLICY IF EXISTS portal_access_policies_partner_default_select ON public.portal_access_policies;
CREATE POLICY portal_access_policies_partner_default_select ON public.portal_access_policies FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
-- Portal sessions and org-scoped tokens carry currentPartnerId = NULL (W3 plan D7):
-- any context that can see one of the partner's orgs may read the partner default.
DROP POLICY IF EXISTS portal_access_policies_org_member_select ON public.portal_access_policies;
CREATE POLICY portal_access_policies_org_member_select ON public.portal_access_policies FOR SELECT
  USING (org_id IS NULL AND EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.partner_id = portal_access_policies.partner_id AND public.breeze_has_org_access(o.id)));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_access_policies TO breeze_app;

-- 2. portal_access_requests: shape 1. org_id NOT NULL by design (queue data, not config; plan D9).
CREATE TABLE IF NOT EXISTS public.portal_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  portal_user_id uuid,
  email text NOT NULL,
  name text,
  source text NOT NULL,
  issuer text,
  subject text,
  entra_tenant_id text,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_access_requests_user_org_fk
    FOREIGN KEY (portal_user_id, org_id) REFERENCES public.portal_users (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_access_requests_source_chk CHECK (source IN ('self','entra','google','addin_user')),
  CONSTRAINT portal_access_requests_status_chk CHECK (status IN ('pending','approved','denied','expired')),
  CONSTRAINT portal_access_requests_email_chk CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  CONSTRAINT portal_access_requests_claims_chk CHECK (
        ((source IN ('entra','google')) = (issuer IS NOT NULL))
    AND ((issuer IS NOT NULL) = (subject IS NOT NULL))
    AND ((source = 'entra') = (entra_tenant_id IS NOT NULL))
    AND (source <> 'entra'  OR issuer = 'https://login.microsoftonline.com/' || entra_tenant_id || '/v2.0')
    AND (source <> 'google' OR issuer = 'https://accounts.google.com')
    AND (source <> 'addin_user' OR portal_user_id IS NOT NULL)),
  -- decided_by_user_id is NOT required: ON DELETE SET NULL may null it later.
  CONSTRAINT portal_access_requests_decision_chk CHECK (
        (status IN ('pending','expired') OR decided_at IS NOT NULL)
    AND (status <> 'approved' OR portal_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_requests_pending_email_uq
  ON public.portal_access_requests (org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS portal_access_requests_org_status_idx
  ON public.portal_access_requests (org_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS portal_access_requests_portal_user_idx
  ON public.portal_access_requests (portal_user_id) WHERE portal_user_id IS NOT NULL;

ALTER TABLE public.portal_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_access_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_select ON public.portal_access_requests
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_insert ON public.portal_access_requests
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_update ON public.portal_access_requests
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_delete ON public.portal_access_requests
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_access_requests TO breeze_app;

-- 3. auth_method gains 'google': an approved Google request creates an identity-only
--    account (plan D2). 'password' remains the only password-eligible value.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_auth_method_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%google%') THEN
    ALTER TABLE public.portal_users DROP CONSTRAINT portal_users_auth_method_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_auth_method_check') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_auth_method_check CHECK (auth_method IN ('password','entra','google'));
  END IF;
END $$;

-- 4. Identities release B: repair at deploy, before reads switch (plan D10). Same INSERT as
--    release A (2027-01-22-230200 §5); ON CONFLICT with no target covers both unique keys.
DO $$
DECLARE n integer; left_over integer;
BEGIN
  INSERT INTO public.portal_user_identities
    (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at)
  SELECT pu.org_id, pu.id, 'entra',
         'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0',
         pu.entra_oid, pu.entra_tenant_id, 'migrated', pu.last_login_at, pu.created_at
    FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'portal_user_identities: release-B backfill inserted % identit(ies)', n;

  SELECT count(*) INTO left_over FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                      WHERE i.portal_user_id = pu.id AND i.provider = 'entra'
                        AND i.subject = pu.entra_oid AND i.entra_tenant_id = pu.entra_tenant_id);
  IF left_over > 0 THEN
    RAISE WARNING 'portal_users: % entra login(s) have no matching identity after backfill - run scripts/portal-identity-reconcile.ts', left_over;
  END IF;
END $$;
