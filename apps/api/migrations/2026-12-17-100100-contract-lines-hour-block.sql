-- #4547 W01 (block hours): the hour_block columns on contract_lines and the
-- CHECKs that make a block line well-formed.
-- Spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C2).
--
-- Requires 2026-12-17-100000 (the enum value must already be committed). This
-- file writes no rows, so it needs no system-scope election.
--
-- Fields reuse the shipped allowance columns (#4607): included_quantity is the
-- block's hours, overage_unit_price its overage rate, overage_mode must be
-- 'bill' on a block (Decision 3 A; Open Decision 10 A).

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS rollover_policy text;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS rollover_cap_hours numeric(12,2);
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_alert_pct integer;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_first_period_start date;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_retired_at timestamptz;

COMMENT ON COLUMN contract_lines.hour_block_first_period_start IS
  'First billing period this block entitles hours for: the first period whose block fee has not yet been claimed. Server-stamped at insert (never client-supplied, never patchable).';
COMMENT ON COLUMN contract_lines.hour_block_retired_at IS
  'NULL = live. Set instead of deleting a block that has closed periods, and when the contract expires or is cancelled; frees the one-live-block-per-org index.';

-- contract_lines_allowance_chk, re-added: 'hour_block' joins the type list and is
-- exempt from the integrality conjunct (hours are fractional; devices and seats
-- are not). Every other conjunct and the ELSE branch are unchanged. DROP + re-ADD
-- is the only way to widen a shipped CHECK (2026-10-08-100200 is content-hash
-- immutable). Every conjunct is NULL-safe: each side of every `=` is a non-null
-- boolean and the CASE is total.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat', 'hour_block') THEN
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- Devices and seats are whole; hours are not (#4547).
    AND (line_type = 'hour_block' OR included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);

-- The block's own shape. Total over line_type: a block carries every required
-- column and no scoping column; every other type carries none of the five new
-- columns. NULL-safe — each conjunct is a non-null boolean (IS NULL / IS NOT
-- NULL / IS NOT DISTINCT FROM), and the two OR arms guard their comparisons.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_hour_block_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_hour_block_chk CHECK (
  CASE WHEN line_type = 'hour_block' THEN
    included_quantity IS NOT NULL
    AND overage_mode IS NOT DISTINCT FROM 'bill'
    AND site_id IS NULL AND site_name IS NULL
    AND device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND manual_quantity IS NULL
    AND rollover_policy IS NOT NULL AND rollover_policy IN ('none', 'carry_forward')
    AND (rollover_cap_hours IS NULL OR (rollover_policy = 'carry_forward' AND rollover_cap_hours > 0))
    AND (hour_block_alert_pct IS NULL OR hour_block_alert_pct BETWEEN 1 AND 100)
    AND hour_block_first_period_start IS NOT NULL
  ELSE
    rollover_policy IS NULL AND rollover_cap_hours IS NULL AND hour_block_alert_pct IS NULL
    AND hour_block_first_period_start IS NULL AND hour_block_retired_at IS NULL
  END
);

-- One LIVE block per org (Decision 2). Retired blocks do not count, so a
-- successor contract can start a new block once the old one is retired.
CREATE UNIQUE INDEX IF NOT EXISTS contract_lines_one_live_hour_block_per_org_uq
  ON contract_lines (org_id)
  WHERE line_type = 'hour_block' AND hour_block_retired_at IS NULL;
