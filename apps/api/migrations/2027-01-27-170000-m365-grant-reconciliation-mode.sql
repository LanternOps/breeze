-- #12085: record how a Microsoft 365 connection's grants were verified.
--
--   'exact'            the executor read the full appRoleAssignments inventory
--                      across every resource (Read always; Admin actions when
--                      the tenant granted Application.Read.All).
--   'graph_token_only' the inventory read was denied, so the Admin actions
--                      executor checked the Microsoft Graph roles in its own
--                      app-only token. Roles on other resources were not checked.
--   NULL               no grant observation has been stored by a build that
--                      records the mode (never verified, or verified before
--                      this column existed — those were all exact).
--
-- Schema only: no rows are written, so no system scope is needed. Both
-- statements are no-ops when re-applied.

ALTER TABLE m365_connections
  ADD COLUMN IF NOT EXISTS grant_reconciliation_mode varchar(32);

DO $$
BEGIN
  ALTER TABLE m365_connections
    ADD CONSTRAINT m365_connections_grant_reconciliation_mode_check
    CHECK (grant_reconciliation_mode IS NULL
      OR grant_reconciliation_mode IN ('exact', 'graph_token_only'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
