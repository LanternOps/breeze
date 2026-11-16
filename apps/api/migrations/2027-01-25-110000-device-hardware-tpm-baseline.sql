-- TPM endorsement-key baseline (#8318 wave T1; spec
-- docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §12.2, §5.1). Recorded before anyone reformats, so a later reinstall can
-- prove it holds the same EK (wave T2).
--
--   - tpm_ek_pub_sha256: SHA-256 (hex) of the EK's DER SubjectPublicKeyInfo,
--     written only by POST /agents/:id/attestation/complete after the agent
--     proved possession of the EK (TPM2_ActivateCredential), and only when no
--     baseline is recorded yet: the first baseline is kept. The inventory
--     writer never sets it, and a reattach keeps it (§5.1). Export
--     excludedSensitive.
--   - tpm_attested_at: when a proof for that EK last succeeded.
--   - tpm_ek_mismatch_sha256 / tpm_ek_mismatch_at: the latest proven EK that
--     is NOT the baseline, and when. Never replaces the baseline: a different
--     key is held for an operator's review (wave T2 adds the accept path).
--     The server checks no EK certificate in T1, so a proof shows possession
--     of a key shaped like an EK, not that it lives in a TPM; keeping the
--     first baseline means a stolen agent token cannot swap it. Export: the
--     hash excludedSensitive, the time included.
--   - tpm_available: what the agent's hardware report says; false when the
--     machine has no TPM or TBS is unavailable, NULL until an agent reports.
--     Tells "cannot attest" from "not attested yet" for the coverage metric.
--
-- All nullable, so existing rows are untouched. The CHECKs are added NOT
-- VALID (no scan under the ALTER's lock) and then validated, which takes only
-- a SHARE UPDATE EXCLUSIVE lock. device_hardware's RLS, cascade and move-org
-- handling are unchanged.

ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_ek_pub_sha256 varchar(64);
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_attested_at timestamptz;
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_ek_mismatch_sha256 varchar(64);
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_ek_mismatch_at timestamptz;
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_available boolean;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_ek_pub_sha256_chk
    CHECK (tpm_ek_pub_sha256 IS NULL OR tpm_ek_pub_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE device_hardware VALIDATE CONSTRAINT device_hardware_tpm_ek_pub_sha256_chk;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_baseline_shape_chk
    CHECK ((tpm_ek_pub_sha256 IS NULL) = (tpm_attested_at IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE device_hardware VALIDATE CONSTRAINT device_hardware_tpm_baseline_shape_chk;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_ek_mismatch_sha256_chk
    CHECK (tpm_ek_mismatch_sha256 IS NULL OR tpm_ek_mismatch_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE device_hardware VALIDATE CONSTRAINT device_hardware_tpm_ek_mismatch_sha256_chk;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_ek_mismatch_shape_chk
    CHECK ((tpm_ek_mismatch_sha256 IS NULL) = (tpm_ek_mismatch_at IS NULL)
      AND (tpm_ek_mismatch_sha256 IS NULL OR tpm_ek_pub_sha256 IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE device_hardware VALIDATE CONSTRAINT device_hardware_tpm_ek_mismatch_shape_chk;
