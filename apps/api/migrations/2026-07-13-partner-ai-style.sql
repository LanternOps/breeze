-- Partner-configurable AI copy style for catalog/quote/invoice enrich + polish.
-- NULL = the built-in house format (generic customer-friendly name; description =
-- full product name line + "• " spec bullets). A non-null value overrides the
-- name/description style section of both AI prompts for this partner.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS catalog_ai_style text;
