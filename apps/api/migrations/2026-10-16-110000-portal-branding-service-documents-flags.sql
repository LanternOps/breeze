-- Service deliverables W04 (spec §4.7, D10): two fail-closed customer-portal
-- visibility flags. Existing portal_branding RLS, FORCE RLS and breeze_app
-- grants already cover every column of this table, so nothing else is needed.
-- DDL only: no rows are written, so no breeze.scope election.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_service
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_documents
    boolean NOT NULL DEFAULT false;
