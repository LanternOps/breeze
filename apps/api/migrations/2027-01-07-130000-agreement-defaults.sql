-- #9075 W4a (spec OD8 B): partner-level agreement-request defaults, edited
-- under Settings → Billing → Agreements.
--
--   agreement_default_expiry_days    — lifetime of a new agreement request when
--                                      the sender sets no expiry (was a
--                                      hard-coded 30 days).
--   agreement_reminder_interval_days — automatic reminders: email the same
--                                      signing link again every N days since
--                                      the last email. NULL = OFF (default): a
--                                      new outbound customer email must not
--                                      start firing on upgrade (#6635 rule).
--   agreement_max_reminders          — automatic reminders stop once a request
--                                      has had this many (manual ones count).
--
-- Dedicated columns, not partners.settings JSONB: the settings cards replace
-- sub-objects wholesale (#3597) and the reminder job's selector queries these
-- values (the partners.billing_enabled precedent). Bounds match
-- agreementDefaultsSettingsFields in @breeze/shared.
--
-- Tenancy: partners has no org_id (partner-axis, RLS already on), so no
-- cascade/merge/export registration. No DML: ADD COLUMN … DEFAULT fills
-- existing rows, so no system scope is needed. Idempotent.

SET LOCAL lock_timeout = '5s';

ALTER TABLE partners ADD COLUMN IF NOT EXISTS agreement_default_expiry_days integer NOT NULL DEFAULT 30;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS agreement_reminder_interval_days integer;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS agreement_max_reminders integer NOT NULL DEFAULT 3;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_agreement_default_expiry_days_check;
ALTER TABLE partners ADD CONSTRAINT partners_agreement_default_expiry_days_check
  CHECK (agreement_default_expiry_days BETWEEN 1 AND 365);

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_agreement_reminder_interval_days_check;
ALTER TABLE partners ADD CONSTRAINT partners_agreement_reminder_interval_days_check
  CHECK (agreement_reminder_interval_days IS NULL OR agreement_reminder_interval_days BETWEEN 1 AND 30);

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_agreement_max_reminders_check;
ALTER TABLE partners ADD CONSTRAINT partners_agreement_max_reminders_check
  CHECK (agreement_max_reminders BETWEEN 1 AND 10);
