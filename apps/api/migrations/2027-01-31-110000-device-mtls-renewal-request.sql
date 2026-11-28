-- Reinstall reattach #8318 wave D-1 — parked certificates (spec 2026-10-12
-- §10.4, §13 decision 9).
--
--   devices.mtls_renewal_requested_serial  varchar(128) NULL
--     The serial of a certificate the server wants replaced. While it equals
--     devices.mtls_cert_serial_number, the full heartbeat signals renewCert
--     (routes/agents/heartbeatCredentialMaintenance.ts). Renewal changes the
--     current serial, which ends the request by itself: nothing clears this
--     column, and a stale value never matches again (serials are unique per
--     org, device_mtls_certificates_org_serial_uq).
--
--     Written by parked-device assignment
--     (services/unassignedPool/assignParkedDevice.ts): the certificate issued
--     at pool enrollment lives no longer than the parking window, and parked
--     renewal is refused, so the first full beat in the customer org asks for
--     a certificate with that org's lifetime. Copied from the device's own
--     serial column, so it is NULL wherever mTLS was never configured.
--
-- No backfill: nothing has been parked under a bounded certificate yet.
-- Nullable, no default, no constraint: a metadata-only ADD COLUMN. `devices`
-- is read by every agent request; lock_timeout bounds the ACCESS EXCLUSIVE
-- wait, and on timeout the file rolls back and re-runs on the next start.
SET LOCAL lock_timeout = '5s';

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS mtls_renewal_requested_serial varchar(128);
