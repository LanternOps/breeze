-- Wave 5 Task 1 (security remediation): durable device mTLS certificate
-- history, forced RLS.
--
-- devices.mtls_cert_* today holds only the CURRENT certificate's serial,
-- issued/expiry timestamps, and provider id — every rotation silently
-- overwrites the prior cert with no audit trail and no way to correlate a
-- past connection against the cert that was live at the time. This table
-- gives one durable row per issued certificate (never updated-over, only
-- transitioned through pending_activation -> active -> pending_revocation ->
-- revoked) so later Wave 5 tasks (services/routes) can build lifecycle
-- management and revocation retry on a real history instead of four mutable
-- columns. This migration lands ONLY the schema + RLS + a one-time import of
-- the legacy columns into history rows — no service/route code.
--
-- Tenancy: Shape 1 (direct org_id). The composite FK
-- (device_id, org_id) -> devices(id, org_id) structurally pins every
-- certificate row to the SAME org as its device (devices_id_org_id_uniq
-- already exists — added by 2026-07-23-partner-export-material-state-hardening.sql).
-- Auto-discovered by the RLS coverage contract test; not added to any
-- allowlist (see rls-coverage.integration.test.ts's explicit
-- "device_mtls_certificates is discovered as a direct-org table" assertion).
--
-- fingerprint_sha256 / public_key_spki are the proof-of-possession material a
-- later task needs to bind a cert to the key that requested it. Legacy rows
-- imported below predate that capture, so they get fingerprint_sha256 = NULL
-- and public_key_spki = NULL rather than an invented/derived value — this
-- deliberately means imported rows cannot support proof-of-possession
-- recovery. The fingerprint check constraint only requires a fingerprint for
-- NEW (non-legacy) rows.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO blocks for the
-- constraint/FK adds, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS
-- before each CREATE POLICY, and a WHERE NOT EXISTS + ON CONFLICT DO NOTHING
-- guard on the one-time legacy import so re-applying this file against a
-- database that already ran it imports nothing twice and raises no error.
-- No inner BEGIN/COMMIT — autoMigrate wraps this file in one transaction.

CREATE TABLE IF NOT EXISTS device_mtls_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  provider_certificate_id varchar(128) NOT NULL,
  serial_number varchar(128) NOT NULL,
  fingerprint_sha256 char(64),
  public_key_spki text,
  legacy_provenance boolean NOT NULL DEFAULT false,
  state varchar(32) NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  activation_expires_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoke_attempts integer NOT NULL DEFAULT 0,
  last_revoke_error varchar(255),
  next_revoke_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Composite FK: a certificate's org must equal its device's org (same-org
-- invariant), enforced structurally against devices(id, org_id).
--
-- Wave 5 Task 2 (security remediation) — ON UPDATE CASCADE + DEFERRABLE
-- INITIALLY DEFERRED: POST /devices/:id/move-org flips devices.org_id in
-- the same transaction that re-tenants every device-scoped child table
-- (see getDeviceOrgDenormalizedTables() in routes/devices/core.ts). Without
-- ON UPDATE CASCADE, that single UPDATE devices SET org_id=... would
-- immediately violate this FK for any existing certificate row (the
-- referenced (id, org_id) tuple changes out from under it). This exactly
-- mirrors the composite (device_id, org_id) -> devices(id, org_id) FKs
-- added for device_hardware/device_disks/device_network/device_ip_history/
-- software_inventory/device_warranty/hyperv_vms in
-- 2026-07-23-partner-export-material-state-hardening.sql. DROP+ADD
-- (unconditional, not an IF-NOT-EXISTS guard) so re-running this
-- unshipped migration against a database that already created the
-- constraint under its prior (task 1) definition still converges on the
-- corrected one.
ALTER TABLE device_mtls_certificates
  DROP CONSTRAINT IF EXISTS device_mtls_certificates_device_org_fkey;
ALTER TABLE device_mtls_certificates
  ADD CONSTRAINT device_mtls_certificates_device_org_fkey
  FOREIGN KEY (device_id, org_id)
  REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX IF NOT EXISTS device_mtls_certificates_provider_uq
  ON device_mtls_certificates(provider_certificate_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_mtls_certificates_org_serial_uq
  ON device_mtls_certificates(org_id, serial_number);
-- Partial unique: at most one 'active' certificate per device at a time.
CREATE UNIQUE INDEX IF NOT EXISTS device_mtls_certificates_one_active_uq
  ON device_mtls_certificates(device_id) WHERE (state = 'active');
CREATE INDEX IF NOT EXISTS device_mtls_certificates_org_device_state_idx
  ON device_mtls_certificates(org_id, device_id, state);
CREATE INDEX IF NOT EXISTS device_mtls_certificates_retry_idx
  ON device_mtls_certificates(state, next_revoke_attempt_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_mtls_certificates_state_chk') THEN
    ALTER TABLE device_mtls_certificates
      ADD CONSTRAINT device_mtls_certificates_state_chk
      CHECK (state IN ('pending_activation', 'active', 'pending_revocation', 'revoked'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_mtls_certificates_pending_expiry_chk') THEN
    ALTER TABLE device_mtls_certificates
      ADD CONSTRAINT device_mtls_certificates_pending_expiry_chk
      CHECK (state <> 'pending_activation' OR activation_expires_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_mtls_certificates_active_time_chk') THEN
    ALTER TABLE device_mtls_certificates
      ADD CONSTRAINT device_mtls_certificates_active_time_chk
      CHECK (state <> 'active' OR activated_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_mtls_certificates_revoked_time_chk') THEN
    ALTER TABLE device_mtls_certificates
      ADD CONSTRAINT device_mtls_certificates_revoked_time_chk
      CHECK (state <> 'revoked' OR revoked_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_mtls_certificates_fingerprint_chk') THEN
    ALTER TABLE device_mtls_certificates
      ADD CONSTRAINT device_mtls_certificates_fingerprint_chk
      CHECK (legacy_provenance OR fingerprint_sha256 IS NOT NULL);
  END IF;
END $$;

-- RLS: direct org_id (Shape 1) -- standard org isolation.
ALTER TABLE device_mtls_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_mtls_certificates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_mtls_certificates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_mtls_certificates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_mtls_certificates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_mtls_certificates;

CREATE POLICY breeze_org_isolation_select ON device_mtls_certificates FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON device_mtls_certificates FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON device_mtls_certificates FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON device_mtls_certificates FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_mtls_certificates TO breeze_app;

-- One-time legacy import: promote devices.mtls_cert_* columns into durable
-- history rows. Only import when provider id, serial, issued, and expiry are
-- ALL non-NULL -- a partial legacy cert is not enough provenance to trust.
-- Imported rows are 'active', legacy_provenance = true, fingerprint_sha256 =
-- NULL (never invented from the serial), public_key_spki = NULL. activated_at
-- is backfilled from issued_at since the legacy columns never tracked
-- activation separately from issuance, and the active-state check constraint
-- requires activated_at to be non-NULL.
--
-- WHERE NOT EXISTS + ON CONFLICT DO NOTHING makes this safe to re-run: once a
-- device already has a history row, or a legacy value collides with an
-- existing unique constraint, that device is skipped rather than erroring or
-- duplicating.
--
-- devices.mtls_cert_issued_at / mtls_cert_expires_at are `timestamp` (no tz);
-- the target columns are `timestamptz`. `AT TIME ZONE 'UTC'` makes the
-- interpretation explicit (these legacy values were always written in UTC)
-- instead of relying on the executing session's TimeZone GUC.
DO $$
DECLARE
  imported int;
BEGIN
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
  WHERE d.mtls_cert_cf_id IS NOT NULL
    AND d.mtls_cert_serial_number IS NOT NULL
    AND d.mtls_cert_issued_at IS NOT NULL
    AND d.mtls_cert_expires_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM device_mtls_certificates existing
      WHERE existing.device_id = d.id
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS imported = ROW_COUNT;
  RAISE WARNING 'imported % legacy device mTLS certificate rows', imported;
END $$;
