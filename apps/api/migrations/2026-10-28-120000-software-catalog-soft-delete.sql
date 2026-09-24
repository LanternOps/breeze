-- Soft delete for software catalog packages (issue #4980).
--
-- software_deployments.software_version_id / install_method_id reference the
-- catalog's children with ON DELETE NO ACTION, and no route removes deployment
-- history, so a package that was ever deployed could never be hard-deleted:
-- DELETE /software/catalog/:id returned a 409 telling the operator to remove
-- references they had no way to remove. Mirroring scripts (#1208,
-- 2026-06-10-c-scripts-soft-delete.sql), a referenced package is now archived:
-- the DELETE handler stamps deleted_at, forward-looking read paths filter
-- `deleted_at IS NULL`, and deployment-history joins intentionally keep it.
-- Unreferenced packages are still hard-deleted together with their uploads.

ALTER TABLE software_catalog ADD COLUMN IF NOT EXISTS deleted_at timestamp;

-- Partial index keeps the common "active packages" listing fast.
CREATE INDEX IF NOT EXISTS software_catalog_active_idx
  ON software_catalog (org_id) WHERE deleted_at IS NULL;
