-- @no-transaction
-- #3205 wave 7 / #4656. Composite-FK targets on EXISTING hot tables.
--
-- Built CONCURRENTLY because a plain CREATE UNIQUE INDEX takes a SHARE lock and
-- would block every invoice write for the duration on a busy tenant. The
-- `-- @no-transaction` directive above makes autoMigrate run this file OUTSIDE a
-- transaction, statement by statement, which is what makes CONCURRENTLY legal.
-- That same contract is why IF NOT EXISTS is mandatory: a failed CONCURRENTLY
-- build leaves an INVALID index behind that an operator must DROP INDEX before
-- the next deploy, and re-applying this file must otherwise be a no-op.
--
-- Migration 2026-10-08-100400 REFERENCES both indexes and will simply fail to
-- apply until this file has succeeded. That separation is deliberate.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS invoice_lines_id_org_uq
  ON invoice_lines (id, org_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS contract_billing_periods_id_org_uq
  ON contract_billing_periods (id, org_id);
