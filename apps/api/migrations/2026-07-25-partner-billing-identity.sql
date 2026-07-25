-- Billing identity snapshot on `partners`, consumed by the abuse sweep
-- (services/abuseSignals/billingIdentity.ts) for:
--   * billing.cardholder_name_mismatch
--   * billing.shared_card_fingerprint  (cross-partner correlation)
--   * billing.card_testing
--   * invariant.suspended_partner_active_subscription
--
-- WRITE SIDE: these columns are populated by the separate billing service from
-- its payment-provider webhooks. The API only ever READS them — nothing in this
-- repo writes them, and the sweep never calls the payment provider.
--
-- Deliberately columns on `partners` rather than a new table: `partners`
-- already carries RLS + policies and is already registered in every cascade
-- list, so a nullable-column extension adds no new tenancy surface.
--
-- NOT added to partnerPublicColumns() in routes/orgs.ts — cardholder name and
-- card fingerprint must never be projected to a partner-scoped token.
--
-- billing_card_fingerprint is NULL for wallet/Link-style payments that expose
-- no card fingerprint, so it is a partial signal by construction; the readers
-- treat NULL as "unknown", never as a value that can match another NULL.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file).

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS billing_cardholder_name          text,
  ADD COLUMN IF NOT EXISTS billing_card_country             char(2),
  ADD COLUMN IF NOT EXISTS billing_card_fingerprint         text,
  ADD COLUMN IF NOT EXISTS billing_distinct_payment_methods integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_failed_attempts          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_identity_synced_at       timestamptz,
  ADD COLUMN IF NOT EXISTS billing_subscription_status      text;

-- Partial index: the shared-fingerprint correlation groups over non-NULL
-- fingerprints across ALL partners, and the vast majority of rows are NULL.
CREATE INDEX IF NOT EXISTS partners_billing_card_fingerprint_idx
  ON partners (billing_card_fingerprint)
  WHERE billing_card_fingerprint IS NOT NULL;
