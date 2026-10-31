-- Preserve the approved billing baseline for every line action across reconciliation.
ALTER TABLE pax8_order_lines DROP CONSTRAINT IF EXISTS pax8_order_lines_authorized_baseline_chk;
ALTER TABLE pax8_order_lines ADD CONSTRAINT pax8_order_lines_authorized_baseline_chk
  CHECK (authorized_baseline_quantity IS NULL OR authorized_baseline_quantity >= 0);
