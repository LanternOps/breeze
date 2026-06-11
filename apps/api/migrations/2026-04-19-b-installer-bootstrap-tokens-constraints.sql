-- 2026-04-19 followup: tighten invariants on installer_bootstrap_tokens
-- Adds CHECK constraints for max_usage, expires_at vs created_at,
-- and sets ON DELETE SET NULL for the site_id FK (it was unset before,
-- leaving orphan-risk if a site is deleted while a token still references it).
--
-- Fully idempotent.
BEGIN;

-- max_usage must be at least 1
ALTER TABLE installer_bootstrap_tokens
  DROP CONSTRAINT IF EXISTS installer_bootstrap_tokens_max_usage_positive;
ALTER TABLE installer_bootstrap_tokens
  ADD CONSTRAINT installer_bootstrap_tokens_max_usage_positive
  CHECK (max_usage >= 1);

-- expires_at must be strictly after created_at
ALTER TABLE installer_bootstrap_tokens
  DROP CONSTRAINT IF EXISTS installer_bootstrap_tokens_expires_after_created;
ALTER TABLE installer_bootstrap_tokens
  ADD CONSTRAINT installer_bootstrap_tokens_expires_after_created
  CHECK (expires_at > created_at);

-- site_id: set NULL on site deletion (was NO ACTION originally, causing orphan risk)
-- Need to drop + re-add the FK to change onDelete behavior.
ALTER TABLE installer_bootstrap_tokens
  DROP CONSTRAINT IF EXISTS installer_bootstrap_tokens_site_id_fkey;
ALTER TABLE installer_bootstrap_tokens
  ADD CONSTRAINT installer_bootstrap_tokens_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;

COMMIT;
