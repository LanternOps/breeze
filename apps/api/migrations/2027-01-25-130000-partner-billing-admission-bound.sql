-- The billing admission allowance now scales with the partner's reserved
-- capacity: up to GREATEST(1100, 2 x max_devices), the same bound
-- effectivePartnerAdmissionLimit (services/partnerDeviceCapacity.ts) honours.
-- The fixed 1..1100 range from 2026-12-18-120000 rejected the annual
-- per-device allowance (ceilingFor(commitment) + pending) for any commitment
-- above 1,000, and with it the whole grant write that carries it.
-- Strictly wider than the old range, so every stored row still validates.
-- DDL only, no rows written. DROP + ADD is idempotent; replaying the older
-- 2026-12-18-120000 migration afterwards is a no-op because it only adds the
-- constraint when absent.
SET LOCAL lock_timeout = '5s';

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_billing_admission_valid;

ALTER TABLE partners ADD CONSTRAINT partners_billing_admission_valid CHECK (
  (billing_admission_limit IS NULL AND billing_admission_expires_at IS NULL)
  OR (
    billing_admission_limit >= 1
    AND billing_admission_limit <= GREATEST(1100, 2 * COALESCE(max_devices, 0))
    AND billing_admission_expires_at IS NOT NULL
  )
);
