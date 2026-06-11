-- Defense-in-depth CHECK on c2c_connections.tenant_id, mirroring the
-- createConnectionSchema superRefine (apps/api/src/routes/c2c/schemas.ts) and
-- M365_TENANT_ID_REGEX (apps/api/src/services/c2cM365.ts).
--
-- tenant_id is varchar(100), NULLABLE, and SHARED across providers:
-- google_workspace (and future providers) legitimately store non-GUID values,
-- so the constraint is provider-conditional (only microsoft_365) and allows
-- NULL. The GUID match is case-insensitive (~*) to mirror the app-layer regex.
--
-- Added NOT VALID so existing (grandfathered) rows are not retroactively
-- rejected — a dev/prod DB may already hold legacy non-GUID microsoft_365 rows,
-- and a validated ADD would crash autoMigrate. NOT VALID still enforces the
-- predicate on every future INSERT/UPDATE, which is the trust boundary we care
-- about. Idempotent via a pg_constraint existence guard (re-apply = no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'c2c_connections_m365_tenant_guid_chk'
  ) THEN
    ALTER TABLE c2c_connections
      ADD CONSTRAINT c2c_connections_m365_tenant_guid_chk
      CHECK (
        provider <> 'microsoft_365'
        OR tenant_id IS NULL
        OR tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) NOT VALID;
  END IF;
END $$;
