SELECT set_config('breeze.scope','system',true);
-- The mapping is created at initiation, potentially days before ACH settles.
-- Preserve successful capture independently of the removable principal row.
ALTER TABLE invoice_stripe_payments
  ADD COLUMN IF NOT EXISTS payment_captured_at timestamptz;
-- Historical date-only payment_received_at cannot establish an exact activation
-- boundary; created_at/updated_at and restored principal rows cannot either.
-- Leave unknown provenance NULL rather than invent a successful-capture time.
