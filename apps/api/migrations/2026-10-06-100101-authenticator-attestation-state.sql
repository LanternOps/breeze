-- #1374 (feature #4707, wave W01) — server-verified platform attestation for L4
-- (critical-tier) approvals.
--
-- Until now `authenticator_devices.is_platform_bound` was set to TRUE
-- unconditionally for every mobile_hw_key registration (routes/authenticator.ts)
-- with no attestation of any kind, while escalateAchievedLevel() gated L4 on it.
-- This migration adds the state needed to record WHY a key is considered
-- platform-bound. It deliberately does NOT flip is_platform_bound on existing
-- rows: the CODE predicate refuses an untrusted basis, which is revertible via
-- BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED without a second migration.
--
-- Tenancy: shape 6 (user-id scoped). RLS is already ENABLE + FORCE with policy
-- authenticator_devices_user_scope (2026-06-14-a-authenticator-foundation.sql),
-- and the table is already in USER_ID_SCOPED_TABLES. Columns only — no new
-- policy, no new table, no cascade/export registration entry: the table has
-- neither an `org_id` nor a `device_id` column (`mobile_device_id` FKs
-- `mobile_devices`, not `devices`), so it appears in none of
-- CORE_ORG_CASCADE_DELETE_ORDER / CORE_DEVICE_CASCADE_DELETE_TABLES /
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES / CORE_TENANT_EXPORT_POLICY. Rows are
-- reaped by `user_id ... ON DELETE CASCADE` when the user goes, and `users` is
-- itself org-cascaded.

-- 1. Basis enum -------------------------------------------------------------
-- Ordered weakest -> strongest so enumsortorder is meaningful in queries.
DO $$ BEGIN
  CREATE TYPE authenticator_platform_bound_basis AS ENUM (
    'unattested',                       -- registered post-#1374 with no attestation
    'legacy_unattested',                -- registered pre-#1374; is_platform_bound was forced true
    'webauthn_backup_flags',            -- browser: singleDevice && !backedUp, NOT hardware attestation
    'ios_keychain_rsa_app_attest',      -- App Attest verified, but the signing key is RSA/Keychain (NOT Secure Enclave)
    'ios_se_p256_app_attest',           -- App Attest verified AND the signing key is a Secure Enclave P-256 key
    'android_tee_key_attestation',      -- Key Attestation verified, keyMintSecurityLevel = TrustedEnvironment
    'android_strongbox_key_attestation' -- Key Attestation verified, keyMintSecurityLevel = StrongBox
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Columns ----------------------------------------------------------------
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS platform_bound_basis authenticator_platform_bound_basis
    NOT NULL DEFAULT 'unattested';
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_verified_at timestamptz;
-- Apple App Attest keyId (base64) / Android attestation leaf serial. Not secret.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_key_id text;
-- SHA-256 of the canonical SPKI DER the attestation actually bound. A later wave
-- re-derives this from public_key and compares, so an attestation verified for
-- key A can never vouch for a substituted key B.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attested_public_key_sha256 bytea;
-- NORMALIZED, SERVER-VERIFIED claims only (securityLevel, verifiedBootState,
-- appId, verifier version, evidence digests). Never the raw client blob, and
-- never an unverified client assertion.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Android Play Integrity verdict time. Null on iOS, where App Attest covers
-- app integrity itself.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS app_integrity_verified_at timestamptz;
-- Registration-time proof-of-possession (W02). Distinct from last_used_at,
-- which keeps its meaning: null = never used for a real approval.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS possession_verified_at timestamptz;

-- 3. Classify existing rows -------------------------------------------------
-- Row counts are RAISEd because these rows are exactly the ones that could
-- evidence a critical-tier bypass. A recorded 0 is as useful as a recorded 500.
--
-- REPLAY SAFETY. `platform_bound_basis = 'unattested'` alone is NOT a
-- pre-existing-row marker: after this wave ships, every NEW mobile registration
-- writes exactly that value on purpose (routes/authenticator.ts), so a bare
-- basis predicate would relabel legitimate new keys as `legacy_unattested` on
-- any replay — corrupting the very forensic count these WARNINGs exist to
-- produce. The cutoff below is this migration's own ledger timestamp:
--   * first run  -> no ledger row yet (autoMigrate INSERTs it after the file
--                   body, in the same transaction) -> cutoff NULL -> classify
--                   every pre-existing row, which is the whole point;
--   * any replay -> cutoff = the ORIGINAL application time -> the predicate
--                   selects the identical row set -> a true no-op.
-- Note the filename date cannot be used as the cutoff: shipped migration names
-- run weeks ahead of real time in this repo, so a literal would sit in the
-- future and re-classify anyway.
DO $$
DECLARE
  n integer;
  cutoff timestamptz := NULL;
BEGIN
  IF to_regclass('public.breeze_migrations') IS NOT NULL THEN
    SELECT applied_at INTO cutoff
      FROM breeze_migrations
     WHERE filename = '2026-10-06-100101-authenticator-attestation-state.sql';
  END IF;

  UPDATE authenticator_devices
     SET platform_bound_basis = 'legacy_unattested'
   WHERE kind = 'mobile_hw_key'
     AND platform_bound_basis = 'unattested'
     AND (cutoff IS NULL OR created_at < cutoff);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING '#1374: classified % pre-existing mobile_hw_key rows as legacy_unattested (these lose L4 eligibility)', n;

  -- `is_platform_bound = true` is part of the predicate on purpose: the
  -- webauthn_backup_flags basis MEANS `singleDevice && !backedUp`, so labelling
  -- a synced/backed-up passkey with it would be simply false. Such a row keeps
  -- the honest 'unattested' default. This matches what the webauthn verify
  -- route now writes at registration (routes/authenticator.ts), so the
  -- migration and the live insert path cannot disagree about the same row.
  UPDATE authenticator_devices
     SET platform_bound_basis = 'webauthn_backup_flags'
   WHERE kind = 'webauthn_platform'
     AND platform_bound_basis = 'unattested'
     AND is_platform_bound = true
     AND (cutoff IS NULL OR created_at < cutoff);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING '#1374: classified % webauthn_platform rows as webauthn_backup_flags (backup-eligibility flags, not hardware attestation)', n;
END $$;

-- 4. Integrity constraint ---------------------------------------------------
-- A basis that claims a real, verified attestation must carry the evidence that
-- proves it. The three derived/unattested bases are exempt: there is nothing to
-- time-stamp for them (see BASES_WITHOUT_ATTESTATION_TIMESTAMP and
-- L4_TRUSTED_PLATFORM_BOUND_BASES in services/authenticatorAssurance.ts).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticator_devices_attested_basis_chk'
  ) THEN
    ALTER TABLE authenticator_devices
      ADD CONSTRAINT authenticator_devices_attested_basis_chk CHECK (
        platform_bound_basis IN ('unattested','legacy_unattested','webauthn_backup_flags')
        OR (attestation_verified_at IS NOT NULL AND attested_public_key_sha256 IS NOT NULL)
      );
  END IF;
END $$;
