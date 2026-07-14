-- Preserve the Breeze manual quantity against which a direct Pax8 quantity
-- change was authorized. Submit must match this value under lock before any
-- vendor write so a later billing edit cannot invert increase/decrease policy.

ALTER TABLE pax8_order_lines
  ADD COLUMN IF NOT EXISTS authorized_baseline_quantity NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pax8_order_lines_authorized_baseline_chk'
      AND conrelid = 'pax8_order_lines'::regclass
  ) THEN
    ALTER TABLE pax8_order_lines
      ADD CONSTRAINT pax8_order_lines_authorized_baseline_chk CHECK (
        authorized_baseline_quantity IS NULL
        OR (action = 'change_quantity' AND authorized_baseline_quantity >= 0)
      );
  END IF;
END $$;
