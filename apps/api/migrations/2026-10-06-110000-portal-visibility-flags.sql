-- Portal visibility Wave 1 feature flags.
-- Existing portal_branding RLS and grants cover these columns.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_dashboard
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_security
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_backups
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_reports
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_support_usage
    boolean NOT NULL DEFAULT false;
