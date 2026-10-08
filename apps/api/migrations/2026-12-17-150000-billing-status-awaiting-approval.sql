-- #4617 (customer work approval, W01): hold state for time entries awaiting
-- customer approval. Spec: docs/superpowers/specs/ticketing/2026-10-06-customer-work-approval-design.md §4.4.
--
-- ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds it, and
-- autoMigrate wraps each file in one, so this file adds the value only. Later
-- files (2026-12-17-150300) reference 'awaiting_approval' after this commits.
-- Same rule as 2026-10-05-100000-contract-line-type-per-device-role.sql.
--
-- The value ships dark: nothing writes it until the W02 gate lands, and every
-- invoice gatherer already selects billing_status = 'not_billed' only.
SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE billing_status ADD VALUE IF NOT EXISTS 'awaiting_approval';
