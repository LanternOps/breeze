-- M365 Customer Graph identity-first consent, legacy cleanup (#7910 W04).
--
-- 2026-12-06-090000-m365-consent-identity-first.sql (W02) admitted two
-- consent-session layouts: flow_version 1 (rows minted by the pre-identity-first
-- flow, in flight at the W02 deploy) and flow_version 2 (identity-first). No
-- shipped code has written or consumed a flow_version 1 row since W02, and every
-- such row expired long ago (10-minute TTL), so this migration deletes any that
-- remain and tightens the table to the identity-first layout only.
--
-- Order matters: the DELETE runs before the CHECKs are re-added, or a surviving
-- v1 row would fail validation of the new constraints.
--
-- m365_consent_sessions is FORCE ROW LEVEL SECURITY with a system-only policy,
-- so the DELETE elects system scope first; without it the DELETE would silently
-- match zero rows. m365_consent_sessions_phase_check is unchanged:
-- 'tenant_confirmation' is the live W03 confirm-tenant phase. No column is
-- dropped: tenant_hint_hash still pins a v2 identity-phase row to its bound
-- tenant.
--
-- Idempotent: the DELETE is a no-op once no v1 row exists, and every constraint
-- is DROP IF EXISTS + ADD.

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  DELETE FROM m365_consent_sessions WHERE flow_version = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % legacy m365_consent_sessions rows', n;
  END IF;
END $$;

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_flow_version_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_flow_version_check
  CHECK (flow_version = 2);

ALTER TABLE m365_consent_sessions
  ALTER COLUMN flow_version SET DEFAULT 2;

-- The two flow_version = 2 branches, copied verbatim from the W02 migration.
ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_fields_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_fields_check CHECK (
    (
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
