-- #7431 / #7432: reconcile device_mtls_certificates with the certificate each
-- device actually holds.
--
-- Until this fix, certificates issued at enrollment, admin provisioning and
-- quarantine approve (issueMtlsCertForDevice) were written ONLY to the legacy
-- devices.mtls_cert_* columns, never to the history table that renewal
-- authorization and the agent certificate binding read. That left two kinds of
-- device behind, both refused in AGENT_MTLS_BINDING_MODE=enforce:
--
--   1. No history row at all (enrolled after the one-time import in
--      2026-08-06-d-device-mtls-certificate-history.sql): renewal is denied
--      with renewal_proof_missing.
--   2. An ACTIVE history row naming an OLDER certificate (re-enrolled or
--      quarantine-approved after it had a row): the binding check denies the
--      certificate the device presents with serial_mismatch, and the older
--      provider certificate was never revoked.
--
-- The application now records every issuance (services/
-- deviceMtlsCertificateIssuance.ts). This migration repairs the rows written
-- before that.
--
-- Which certificate is current: the legacy columns. Every path that writes a
-- history row updates them in the same transaction (or, for a v2 pending row,
-- when it is confirmed), and the only path that wrote them WITHOUT a history
-- row was issueMtlsCertForDevice. So when the provider id in the legacy
-- columns appears nowhere in the history, the legacy certificate is the one
-- the device was given last, and any active row is stale.
--
-- For each such device (all four legacy columns set, neither the legacy
-- provider id nor the legacy serial already recorded, and no other device
-- naming the same certificate):
--   a. the stale active row, if any, becomes pending_revocation with an
--      immediately due next_revoke_attempt_at, so the five-minute revocation
--      sweep (jobs/mtlsCertificateRevocation.ts) revokes it at the provider;
--   b. the legacy certificate is imported as the active row, exactly as the
--      original one-time import did: legacy_provenance = true, and NULL
--      fingerprint and SPKI, because the certificate itself was never stored.
--      Like every imported row, it supports renewal by a matching client-cert
--      assertion while unexpired, but never proof-of-possession recovery.
--
-- Both steps use the same device predicate, evaluated against the same
-- history, so a device is never demoted without its replacement being
-- imported. Devices that already agree are untouched.
--
-- Idempotent: after one run the legacy provider id of every repaired device is
-- in the history, so the predicate matches nothing. No inner BEGIN/COMMIT.
-- devices.mtls_cert_* timestamps are `timestamp` (no tz) written in UTC.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  candidates int;
  skipped_ambiguous int;
  demoted int;
  imported int;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  CREATE TEMP TABLE mtls_reconcile_candidates ON COMMIT DROP AS
  SELECT d.id AS device_id
  FROM devices d
  WHERE d.mtls_cert_cf_id IS NOT NULL
    AND d.mtls_cert_serial_number IS NOT NULL
    AND d.mtls_cert_issued_at IS NOT NULL
    AND d.mtls_cert_expires_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM device_mtls_certificates h
      WHERE h.provider_certificate_id = d.mtls_cert_cf_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM device_mtls_certificates h
      WHERE h.org_id = d.org_id
        AND h.serial_number = d.mtls_cert_serial_number
    );
  SELECT count(*) INTO candidates FROM mtls_reconcile_candidates;

  -- Two devices naming the same certificate is ambiguous: skip both rather
  -- than let the import hit a unique index and abort the migration. Counted
  -- below so the skip is visible.
  CREATE TEMP TABLE mtls_reconcile_devices ON COMMIT DROP AS
  SELECT c.device_id
  FROM mtls_reconcile_candidates c
  JOIN devices d ON d.id = c.device_id
  WHERE NOT EXISTS (
    SELECT 1 FROM devices o
    WHERE o.id <> d.id
      AND (
        o.mtls_cert_cf_id = d.mtls_cert_cf_id
        OR (o.org_id = d.org_id AND o.mtls_cert_serial_number = d.mtls_cert_serial_number)
      )
  );
  skipped_ambiguous := candidates - (SELECT count(*) FROM mtls_reconcile_devices);

  UPDATE device_mtls_certificates c
  SET state = 'pending_revocation',
      next_revoke_attempt_at = now(),
      updated_at = now()
  FROM mtls_reconcile_devices r
  WHERE c.device_id = r.device_id
    AND c.state = 'active';
  GET DIAGNOSTICS demoted = ROW_COUNT;

  INSERT INTO device_mtls_certificates (
    org_id, device_id, provider_certificate_id, serial_number,
    fingerprint_sha256, public_key_spki, legacy_provenance, state,
    issued_at, expires_at, activated_at
  )
  SELECT
    d.org_id, d.id, d.mtls_cert_cf_id, d.mtls_cert_serial_number,
    NULL, NULL, true, 'active',
    d.mtls_cert_issued_at AT TIME ZONE 'UTC',
    d.mtls_cert_expires_at AT TIME ZONE 'UTC',
    d.mtls_cert_issued_at AT TIME ZONE 'UTC'
  FROM devices d
  JOIN mtls_reconcile_devices r ON r.device_id = d.id;
  GET DIAGNOSTICS imported = ROW_COUNT;

  RAISE WARNING 'device mTLS history reconcile: demoted % stale active rows, imported % issued certificates, skipped % devices sharing a certificate with another device',
    demoted, imported, skipped_ambiguous;
END $$;
