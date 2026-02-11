-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction.
-- Run this statement first, separately:
ALTER TYPE device_status ADD VALUE IF NOT EXISTS 'quarantined';

-- Then run the rest in a transaction:
BEGIN;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_serial_number varchar(128);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_expires_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_issued_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtls_cert_cf_id varchar(128);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_reason varchar(255);

CREATE INDEX IF NOT EXISTS devices_mtls_cert_expires_idx
  ON devices (mtls_cert_expires_at)
  WHERE mtls_cert_expires_at IS NOT NULL AND status NOT IN ('decommissioned');

CREATE INDEX IF NOT EXISTS devices_quarantined_idx
  ON devices (org_id, status)
  WHERE status = 'quarantined';

COMMIT;
