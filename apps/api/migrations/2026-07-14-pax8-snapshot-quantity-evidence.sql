-- Pax8 omits Subscription.quantity in some responses. The client normalizes
-- that absence to 0.00 for wire compatibility; retain the evidence bit so a
-- synthesized zero can never be mistaken for real billing drift.
ALTER TABLE pax8_subscription_snapshots
  ADD COLUMN IF NOT EXISTS quantity_known boolean NOT NULL DEFAULT true;
