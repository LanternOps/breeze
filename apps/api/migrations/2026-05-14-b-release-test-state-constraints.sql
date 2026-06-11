-- Make impossible release-test states unrepresentable.
--   * status ∈ {queued, running, completed}
--   * result ∈ {pass, fail, inconclusive, skipped} (nullable while not completed)
--   * completed rows must carry a result + completed_at; non-completed rows must NOT
-- Also tighten third_party_package_catalog.last_tested_* to the same result set,
-- and require all-or-nothing on the (last_tested_at, last_tested_version, last_tested_result) tuple.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'third_party_release_tests_status_chk'
  ) THEN
    ALTER TABLE third_party_release_tests
      ADD CONSTRAINT third_party_release_tests_status_chk
      CHECK (status IN ('queued', 'running', 'completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'third_party_release_tests_result_chk'
  ) THEN
    ALTER TABLE third_party_release_tests
      ADD CONSTRAINT third_party_release_tests_result_chk
      CHECK (result IS NULL OR result IN ('pass', 'fail', 'inconclusive', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'third_party_release_tests_state_chk'
  ) THEN
    ALTER TABLE third_party_release_tests
      ADD CONSTRAINT third_party_release_tests_state_chk
      CHECK (
        (status = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND result IS NULL)
      );
  END IF;

  -- Match catalog.last_tested_result to the same set
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'third_party_package_catalog_last_tested_result_chk'
  ) THEN
    ALTER TABLE third_party_package_catalog
      ADD CONSTRAINT third_party_package_catalog_last_tested_result_chk
      CHECK (last_tested_result IS NULL OR last_tested_result IN ('pass', 'fail', 'inconclusive', 'skipped'));
  END IF;

  -- All-or-nothing on the test tuple
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'third_party_package_catalog_last_tested_tuple_chk'
  ) THEN
    ALTER TABLE third_party_package_catalog
      ADD CONSTRAINT third_party_package_catalog_last_tested_tuple_chk
      CHECK (
        (last_tested_at IS NULL AND last_tested_version IS NULL AND last_tested_result IS NULL)
        OR (last_tested_at IS NOT NULL AND last_tested_version IS NOT NULL AND last_tested_result IS NOT NULL)
      );
  END IF;
END $$;
