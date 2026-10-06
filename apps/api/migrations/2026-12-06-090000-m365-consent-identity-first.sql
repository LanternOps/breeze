-- M365 Customer Graph identity-first admin consent (#7910 W02).
--
-- The consent-session phases are reversed: identity verification (v2 OIDC +
-- PKCE, at /organizations or the already-bound tenant) now runs FIRST, and the
-- admin-consent phase carries the tenant and administrator that phase
-- cryptographically verified. flow_version tells the two layouts apart:
--   1 = rows minted by the pre-W02 flow (in-flight sessions at deploy time,
--       10-minute TTL). New code never reads or consumes them; a later
--       fix-forward migration (W04) deletes them and tightens the CHECK.
--   2 = identity-first rows.
-- 'tenant_confirmation' is admitted now so the W03 confirm-tenant interstitial
-- needs no migration.
--
-- DDL only: no rows are written, so no breeze.scope election is required.
-- Existing rows take flow_version = 1 from the DEFAULT and keep satisfying the
-- unchanged v1 branch of the phase/field CHECK.

ALTER TABLE m365_consent_sessions
  ADD COLUMN IF NOT EXISTS flow_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS verified_tenant_id uuid,
  ADD COLUMN IF NOT EXISTS verified_admin_object_id uuid,
  ADD COLUMN IF NOT EXISTS verified_admin_username varchar(256),
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_flow_version_check'
      AND conrelid = 'public.m365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions
      ADD CONSTRAINT m365_consent_sessions_flow_version_check
      CHECK (flow_version IN (1, 2));
  END IF;
END $$;

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_check
  CHECK (phase IN ('admin_consent', 'identity_verification', 'tenant_confirmation'));

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_fields_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_fields_check CHECK (
    (
      flow_version = 1
      AND verified_tenant_id IS NULL
      AND verified_admin_object_id IS NULL
      AND verified_admin_username IS NULL
      AND identity_verified_at IS NULL
      AND (
        (phase = 'admin_consent'
          AND tenant_hint_hash IS NULL AND nonce IS NULL AND code_verifier IS NULL)
        OR (phase = 'identity_verification'
          AND tenant_hint_hash IS NOT NULL AND nonce IS NOT NULL AND code_verifier IS NOT NULL)
      )
    ) OR (
      flow_version = 2
      AND phase = 'identity_verification'
      AND nonce IS NOT NULL
      AND code_verifier IS NOT NULL
      AND verified_tenant_id IS NULL
      AND verified_admin_object_id IS NULL
      AND verified_admin_username IS NULL
      AND identity_verified_at IS NULL
    ) OR (
      flow_version = 2
      AND phase IN ('tenant_confirmation', 'admin_consent')
      AND tenant_hint_hash IS NULL
      AND nonce IS NULL
      AND code_verifier IS NULL
      AND verified_tenant_id IS NOT NULL
      AND verified_admin_object_id IS NOT NULL
      AND identity_verified_at IS NOT NULL
    )
  );
