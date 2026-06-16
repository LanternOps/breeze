-- 2026-06-15-drop-approver-pin.sql — PIN removed in favor of L4 fresh re-auth.
-- The static approver PIN (added in 2026-06-14-a-authenticator-foundation.sql)
-- is replaced by an L4-only account re-authentication, so its storage columns
-- on `users` and the per-decision `pin_verified` audit flag on the approval /
-- elevation request tables are no longer written or read by any code path.
-- Idempotent: DROP COLUMN IF EXISTS is a no-op on a DB that never had the
-- columns or that has already applied this teardown. No inner BEGIN/COMMIT —
-- autoMigrate wraps each file in its own transaction.

ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_hash;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_set_at;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_failed_count;
ALTER TABLE users DROP COLUMN IF EXISTS approver_pin_locked_until;

ALTER TABLE approval_requests DROP COLUMN IF EXISTS pin_verified;
ALTER TABLE elevation_requests DROP COLUMN IF EXISTS pin_verified;
