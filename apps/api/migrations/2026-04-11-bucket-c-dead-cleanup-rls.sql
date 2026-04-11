-- 2026-04-11: Bucket C dead-table cleanup — RLS for two "potentially dead" tables
-- that turned out to have live read/delete paths.
--
-- Tables audited in this migration:
--
--   snmp_alert_thresholds
--     - Write path: write endpoints are deprecated (return 410 Gone).
--       One delete survives in discovery.ts:1147 (cascade on device removal).
--       One read survives in snmp.ts:570 (stats dashboard count).
--     - No direct org_id column. Tenancy is snmp_alert_thresholds.device_id
--       → snmp_devices.id, and snmp_devices has org_id + its own RLS policy.
--     - Policy shape: join-through snmp_devices (not the `devices` table).
--
--   psa_ticket_mappings
--     - Active reads in routes/psa.ts (list endpoints) and
--       services/aiToolsIntegrations.ts.
--     - One delete in psa.ts:513 (cascade on connection removal).
--     - No insert path found in the codebase — the PSA sync backend is
--       not yet implemented, so rows only arrive via future webhooks/sync jobs.
--     - No direct org_id column. Tenancy is psa_ticket_mappings.connection_id
--       → psa_connections.org_id. psa_connections already has RLS.
--     - Policy shape: join-through psa_connections.
--
-- Deferred tables (also flagged in the original audit, see plan doc):
--
--   policy_compliance
--     - Exists in the DB (baseline migration) but has NO Drizzle schema
--       variable and zero reads or writes anywhere in apps/api/src/.
--       The table is truly dead code — never written, never read.
--       Suggested action: DROP in a future cleanup PR after confirming no
--       external dependencies. Not dropped here to preserve history and
--       allow human review first.
--     - FK: device_id → devices, policy_id → policies (policies has org_id).
--       If it is ever revived, apply phase-5 join-through-devices policy.
--
--   mobile_sessions
--     - Schema defined in db/schema/mobile.ts but never referenced in any
--       route, service, or test file. Zero reads, zero writes.
--       Previously deferred in 2026-04-11-bucket-c-phase-6-user-scoped-rls.sql
--       with a comment "no writers found — likely dead."
--     - When a mobile session auth route is built, apply phase-6 user-scoped
--       policy (user_id → users.partner_id/org_id) matching the shape used
--       for user_sso_identities and push_notifications.
--
-- Fully idempotent.

BEGIN;

-- -------- snmp_alert_thresholds --------
-- Tenancy join: snmp_alert_thresholds.device_id → snmp_devices.org_id
DROP POLICY IF EXISTS breeze_org_isolation_select ON snmp_alert_thresholds;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON snmp_alert_thresholds;
DROP POLICY IF EXISTS breeze_org_isolation_update ON snmp_alert_thresholds;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON snmp_alert_thresholds;
ALTER TABLE snmp_alert_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE snmp_alert_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON snmp_alert_thresholds
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM snmp_devices sd
       WHERE sd.id = snmp_alert_thresholds.device_id
         AND public.breeze_has_org_access(sd.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_insert ON snmp_alert_thresholds
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM snmp_devices sd
       WHERE sd.id = snmp_alert_thresholds.device_id
         AND public.breeze_has_org_access(sd.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_update ON snmp_alert_thresholds
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM snmp_devices sd
       WHERE sd.id = snmp_alert_thresholds.device_id
         AND public.breeze_has_org_access(sd.org_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM snmp_devices sd
       WHERE sd.id = snmp_alert_thresholds.device_id
         AND public.breeze_has_org_access(sd.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_delete ON snmp_alert_thresholds
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM snmp_devices sd
       WHERE sd.id = snmp_alert_thresholds.device_id
         AND public.breeze_has_org_access(sd.org_id)
    )
  );

-- -------- psa_ticket_mappings --------
-- Tenancy join: psa_ticket_mappings.connection_id → psa_connections.org_id
-- Note: device_id on this table is nullable and points to `devices`, but
-- connection_id is NOT NULL and is the authoritative tenancy anchor.
DROP POLICY IF EXISTS breeze_org_isolation_select ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON psa_ticket_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON psa_ticket_mappings;
ALTER TABLE psa_ticket_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_ticket_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON psa_ticket_mappings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND public.breeze_has_org_access(pc.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_insert ON psa_ticket_mappings
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND public.breeze_has_org_access(pc.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_update ON psa_ticket_mappings
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND public.breeze_has_org_access(pc.org_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND public.breeze_has_org_access(pc.org_id)
    )
  );
CREATE POLICY breeze_org_isolation_delete ON psa_ticket_mappings
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM psa_connections pc
       WHERE pc.id = psa_ticket_mappings.connection_id
         AND public.breeze_has_org_access(pc.org_id)
    )
  );

COMMIT;
