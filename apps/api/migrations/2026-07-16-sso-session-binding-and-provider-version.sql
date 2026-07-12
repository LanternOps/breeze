-- PR 3 (SR2-11): SSO provider config generations + pending-session binding.
--
-- 1. sso_providers.config_version — monotonic generation, bumped by every
--    config change AND every status change. A pending SSO session snapshots it;
--    the callback rejects a drift, so a provider reconfigured or disabled during
--    the <=10-minute state TTL cannot complete a login or an account link.
--    No RLS change needed: sso_providers already carries the dual-axis ALL
--    policy sso_providers_org_isolation (2026-07-03), which covers all columns.
--
-- 1b. sso_providers.default_role_configured_by (SR2-10) -- the admin who LAST SET
--    default_role_id. This is the principal the callback re-validates the
--    delegated role against just before JIT provisioning. created_by is the wrong
--    principal: it names the ORIGINAL creator while config-time validation checks
--    the CURRENT caller, and no route ever rewrites it -- so an offboarded creator
--    would make JIT fail permanently with no repair path (the provider cannot be
--    recreated without orphaning every user_sso_identities row, since
--    (provider_id, external_id) is the identity key).
--
-- 2. sso_sessions binding columns. NULLABLE by construction: a LOGIN session has
--    no initiating user, so the three initiating_* columns are only ever set by
--    POST /sso/link/start. provider_version is nullable only so this migration
--    needs no backfill; the callback treats NULL as a REJECT (fail closed) --
--    defaulting pre-deploy rows to 1 would bless exactly the unbound sessions
--    this change exists to invalidate. Worst case is one <=10-minute window of
--    in-flight SSO round-trips at deploy time.
--
-- 3. sso_sessions RLS. The table had NONE (created in 0001-baseline.sql:5828,
--    never given a policy). It is a pre-auth CSRF/PKCE transaction store with no
--    tenant column, written and consumed only by unauthenticated (/sso/callback,
--    /sso/login/*) or system-context (/sso/link/start) code. Classification:
--    system-scope-only -- ENABLE + FORCE RLS with one ALL-command policy keyed on
--    breeze.scope = 'system'. Same shape as partner_abuse_signals (2026-07-13)
--    and software_product_resolutions. Registered in INTENTIONAL_UNSCOPED in
--    rls-coverage.integration.test.ts.

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS default_role_configured_by UUID REFERENCES users(id);

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS provider_version INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_auth_epoch INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_mfa_epoch INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_session_id UUID;

COMMENT ON COLUMN sso_providers.config_version IS
  'Monotonic config generation. Bumped on every provider config change and status change. Pending sso_sessions snapshot it; the callback rejects a mismatch (SR2-11).';
COMMENT ON COLUMN sso_providers.default_role_configured_by IS
  'The admin who last SET default_role_id. The SSO callback re-validates the delegated role against THIS user''s live permission ceiling before JIT provisioning (SR2-10). Re-saving the default role as a current admin is the repair path when the previous configurer is offboarded.';
COMMENT ON COLUMN sso_sessions.provider_version IS
  'sso_providers.config_version snapshot at session creation. NULL = pre-deploy row; the callback rejects it (fail closed).';
COMMENT ON COLUMN sso_sessions.initiating_session_id IS
  'Link mode only: refresh_token_families.family_id (the initiating access token''s `sid`). The link callback requires that family to still be live.';

-- Purge any session rows that predate the binding columns. They are all <=10
-- minutes from expiry and cannot satisfy the new callback checks anyway; purging
-- them makes the invalidation explicit (and auditable) instead of surfacing as a
-- burst of session_expired redirects. Report the count -- silently discarding
-- rows destroys the forensic trail.
DO $$
DECLARE
  n INTEGER;
BEGIN
  DELETE FROM sso_sessions WHERE provider_version IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'purged % in-flight sso_sessions rows with no provider_version binding (SR2-11 rollout)', n;
  END IF;
END $$;

ALTER TABLE sso_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_sessions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sso_sessions'
      AND policyname = 'sso_sessions_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY sso_sessions_system_only
        ON sso_sessions
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END $$;
