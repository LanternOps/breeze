-- Portal Advanced Visibility W01 (#7731, parent #7730): a dedicated
-- fail-closed flag gating the customer portal's read-only hardware health
-- surface (component state, events, disks, battery). Same shape as the
-- existing visibility columns, default false so nothing changes until an
-- administrator turns it on for an organization.
-- DDL only, no rows written, so no breeze.scope election.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_hardware_health boolean NOT NULL DEFAULT false;
