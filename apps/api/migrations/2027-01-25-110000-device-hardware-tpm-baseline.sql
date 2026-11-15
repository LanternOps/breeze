-- TPM endorsement-key baseline (#8318 wave T1; spec
-- docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §12.2, §5.1). Recorded before anyone reformats, so a later reinstall can
-- prove it holds the same EK (wave T2).
--
--   - tpm_ek_pub_sha256: SHA-256 (hex) of the EK's DER SubjectPublicKeyInfo,
--     written only by POST /agents/:id/attestation/complete after the agent
--     proved possession of the EK (TPM2_ActivateCredential). The inventory
--     writer never sets it, and a reattach keeps it (§5.1). Export
--     excludedSensitive.
--   - tpm_attested_at: when that proof last succeeded.
--   - tpm_available: what the agent's hardware report says; false when the
--     machine has no TPM or TBS is unavailable, NULL until an agent reports.
--     Tells "cannot attest" from "not attested yet" for the coverage metric.
--
-- All nullable, so existing rows are untouched and the ALTERs are
-- metadata-only. device_hardware's RLS, cascade and move-org handling are
-- unchanged.

ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_ek_pub_sha256 varchar(64);
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_attested_at timestamptz;
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS tpm_available boolean;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_ek_pub_sha256_chk
    CHECK (tpm_ek_pub_sha256 IS NULL OR tpm_ek_pub_sha256 ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_tpm_baseline_shape_chk
    CHECK ((tpm_ek_pub_sha256 IS NULL) = (tpm_attested_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
