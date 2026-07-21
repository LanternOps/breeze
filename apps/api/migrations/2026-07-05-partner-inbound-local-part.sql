-- Decouple the partner inbound ticket address from partners.slug.
-- NULL means "use slug" (resolver/outbound fall back). See
-- docs/superpowers/specs/ticketing/2026-06-29-inbound-alias-design.md.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS inbound_local_part varchar(63);
