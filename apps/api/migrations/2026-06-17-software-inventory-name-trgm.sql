-- 2026-06-17-software-inventory-name-trgm.sql
-- Trigram GIN index on software_inventory.name to back the device-filter
-- "software installed / not installed" picker's server-side distinct-name
-- search (issue #1459). The picker runs `name ILIKE '%q%'` against millions of
-- inventory rows; without a trigram index that is a full sequential scan per
-- keystroke. A pg_trgm GIN index makes the substring ILIKE indexable.
--
-- Idempotent: CREATE EXTENSION / CREATE INDEX both use IF NOT EXISTS, so
-- re-applying is a no-op. No tenancy change here — software_inventory already
-- has RLS enabled + forced (2026-04-11-bucket-c-phase-1-inventory-rls.sql).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS software_inventory_name_trgm_idx
  ON software_inventory USING gin (name gin_trgm_ops);
