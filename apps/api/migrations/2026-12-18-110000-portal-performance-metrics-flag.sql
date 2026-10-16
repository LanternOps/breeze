-- Portal Advanced Visibility W03 (#7733): per-org performance metrics visibility.
-- Fail closed for existing and new organizations.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_performance_metrics boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_performance_metrics IS
  'Expose read-only performance metrics in the customer portal. Off by default.';
