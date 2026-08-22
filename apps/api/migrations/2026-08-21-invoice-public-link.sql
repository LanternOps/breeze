-- Public invoice link (spec: docs/superpowers/specs/billing/2026-08-21-public-invoice-pay-link-design.md)
--
-- Durable, no-login view-and-pay link bound to the INVOICE (quotes already have
-- their accept-token surface; invoices had only the login-gated portal URL).
-- Token design per the quorum-reviewed spec: 256-bit random opaque token; the
-- row stores its SHA-256 hex (lookup key + revocation: replacing the hash kills
-- every previously issued link) and the token encrypted at rest (so copy-link /
-- re-send reproduce the SAME url instead of minting a family of live
-- credentials). Expiry is persisted at mint time — never recomputed from the
-- mutable due date.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_link_token_hash char(64);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_link_token_ct text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_link_expires_at timestamp;

-- The public GET resolves the invoice BY hash, so this is both the lookup index
-- and the global-uniqueness guarantee (a hash collision across invoices would
-- let one link resolve another tenant's invoice — unique makes that a write-time
-- error instead).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_public_link_hash_uq
  ON invoices (public_link_token_hash)
  WHERE public_link_token_hash IS NOT NULL;
