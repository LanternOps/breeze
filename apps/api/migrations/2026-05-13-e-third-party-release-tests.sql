-- Per-version release test results for Breeze-tested catalog packages.
-- Status transitions: queued -> running -> completed (result: pass/fail/inconclusive/skipped).
CREATE TABLE IF NOT EXISTS third_party_release_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES third_party_package_catalog(id) ON DELETE CASCADE,
  version varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  result varchar(32),
  log text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT third_party_release_tests_catalog_version_unique
    UNIQUE (catalog_id, version)
);

CREATE INDEX IF NOT EXISTS third_party_release_tests_status_idx
  ON third_party_release_tests (status) WHERE status IN ('queued', 'running');
