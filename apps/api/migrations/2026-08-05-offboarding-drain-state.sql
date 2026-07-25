-- Offboarding drain state (#2774).
--
-- Adds a terminal-intent `offboarding` value to both tenant status enums plus
-- a drain-window start timestamp on each table. During `offboarding`, users
-- are locked out (every user-facing gate is an explicit allowlist that does
-- not admit the new value) while the agent auth gate stays open in a narrowed
-- "drain" mode so a queued self_uninstall can actually be delivered. The
-- offboarding drain reaper severs credentials and flips the tenant to
-- `churned` once the fleet drains or the window closes.
--
-- ALTER TYPE ... ADD VALUE runs inside autoMigrate's transaction; that is
-- legal (PG 12+) because nothing in this migration USES the new value.

ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'offboarding';
ALTER TYPE partner_status ADD VALUE IF NOT EXISTS 'offboarding';

-- NULL = not offboarding. Set on drain entry (preserved across re-entry),
-- cleared on abort/finalize. The drain deadline is computed at sweep time as
-- offboarding_started_at + OFFBOARDING_DRAIN_WINDOW_HOURS (default 72).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS offboarding_started_at timestamptz;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS offboarding_started_at timestamptz;
