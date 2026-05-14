-- Curated catalog of third-party packages with Breeze metadata.
-- System-wide (no org_id); writes gated to partner-admin role at the route layer.
-- Intentionally unscoped — will be added to rls-coverage allowlist in Task 11.

CREATE TABLE IF NOT EXISTS third_party_package_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source patch_source NOT NULL,
  package_id varchar(256) NOT NULL,
  vendor varchar(255) NOT NULL,
  friendly_name varchar(255) NOT NULL,
  category varchar(64) NOT NULL DEFAULT 'application',
  default_severity patch_severity NOT NULL DEFAULT 'unknown',
  breeze_tested boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_tested_version varchar(64),
  last_tested_result varchar(32),
  notes text,
  homepage_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT third_party_package_catalog_source_package_id_unique
    UNIQUE (source, package_id)
);

CREATE INDEX IF NOT EXISTS third_party_package_catalog_vendor_idx
  ON third_party_package_catalog (vendor);
