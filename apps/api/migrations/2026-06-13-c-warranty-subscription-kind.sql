-- Warranty: distinguish active AppleCare subscriptions from fixed-term coverage.
--
-- macOS reports AppleCare subscription coverage via the NDO cache as a "Renews
-- <next billing date>" label, so the reported end date perpetually rolls ~30 days
-- forward and the "warranty expiring" alert fires forever. The agent now derives a
-- coverage kind (subscription vs fixed) from that label verb; persist it here so the
-- alert evaluator can suppress expiry alerts for renewing subscriptions.
--
-- device_warranty is a shape-1 (direct org_id) tenant table with org-isolation RLS
-- already in place (2026-04-11-bucket-a-rls-policies.sql). RLS policies apply to all
-- columns, so adding a column needs no policy changes. Idempotent per CLAUDE.md.

-- 1. is_subscription flag: true when coverage is a recurring subscription whose
--    warranty_end_date is the next renewal date, not a true expiry.
ALTER TABLE device_warranty
  ADD COLUMN IF NOT EXISTS is_subscription BOOLEAN NOT NULL DEFAULT false;

-- 2. New warranty_status value surfaced in the UI / consumed by the alert gate.
--    ADD VALUE IF NOT EXISTS is safe inside autoMigrate's per-file transaction
--    because the new value is not referenced elsewhere in this same migration.
ALTER TYPE warranty_status ADD VALUE IF NOT EXISTS 'subscription_active';
