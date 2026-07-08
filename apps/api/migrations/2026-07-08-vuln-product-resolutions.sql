-- apps/api/migrations/2026-07-08-vuln-product-resolutions.sql
-- Global DisplayName→product resolution cache + unmatched-name log (#2290).
-- System-only RLS, same shape as vulnerabilities/software_products.

CREATE TABLE IF NOT EXISTS software_product_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_name VARCHAR(500) NOT NULL,          -- lower(trim(software_inventory.name)) — SQL join key
  lookup_vendor VARCHAR(200),                 -- lower(trim(software_inventory.vendor))
  normalized_name VARCHAR(500) NOT NULL,      -- post-token-strip form (observability only)
  software_product_id UUID REFERENCES software_products(id),  -- NULL = unmatched (the log)
  confidence VARCHAR(16) NOT NULL,            -- curated | exact | fuzzy | none
  matched_via VARCHAR(32) NOT NULL,           -- dictionary | catalog_exact | token | unmatched
  resolver_version INTEGER NOT NULL,
  resolved_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS software_product_resolutions_key_idx
  ON software_product_resolutions (lookup_name, lookup_vendor) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS software_product_resolutions_product_idx
  ON software_product_resolutions (software_product_id);

ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(16);

-- System-only RLS (mirror 2026-06-22-vulnerability-management.sql). Forced RLS with a
-- single system-scope policy; breeze_app (non-BYPASSRLS) is denied unless scope=system.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE software_product_resolutions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE software_product_resolutions FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'software_product_resolutions'
      AND policyname = 'software_product_resolutions_system_only'
  ) THEN
    EXECUTE $f$CREATE POLICY software_product_resolutions_system_only ON software_product_resolutions
      USING (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system')$f$;
  END IF;
END $$;
