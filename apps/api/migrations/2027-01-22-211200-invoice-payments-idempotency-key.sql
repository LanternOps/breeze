-- #3803 item 4 — caller-supplied idempotency key for manual invoice payments.
--
-- recordPayment locks the invoice row and checks the amount against the
-- balance recomputed under that lock, which stops two FULL-balance payments
-- from both landing. It cannot stop a retried PARTIAL payment: 40 + 40 still
-- fits a 100 balance, so the retry passes every check the lock serializes and
-- the customer is credited twice. A key the caller sends once per intended
-- payment, unique per invoice, makes the retry land once: recordPayment looks
-- the key up under the invoice lock and answers with the payment already
-- recorded instead of inserting another.
--
-- Nullable, no backfill: existing rows and callers that send no key keep the
-- current behaviour. The partial unique index is the integrity backstop:
-- recordPayment is the only writer of keyed rows and holds the invoice lock
-- across its lookup and insert, so it should never trip.
--
-- No rows are written, so no system-scope election is needed. The table is
-- small (one row per recorded payment), so a plain CREATE INDEX inside the
-- per-file transaction is fine.
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS idempotency_key varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_invoice_idempotency_key_uq
  ON invoice_payments (invoice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
