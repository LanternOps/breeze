-- Portal Hardware Lifecycle (#5719, spec sec 4, decision A2): a dedicated
-- fail-closed flag, required alongside enable_reports, gating the customer
-- portal's live replacement-plan page separately from generic report
-- self-service. Same shape as the seven existing visibility columns.
-- DDL only, no rows written, so no breeze.scope election.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_lifecycle boolean NOT NULL DEFAULT false;
