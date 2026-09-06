import postgres from 'postgres';
import { selectAppRolePassword } from './requestDatabaseConfig';

/**
 * Ensures a non-superuser, non-BYPASSRLS role `breeze_app` exists and has the
 * minimum privileges required to run the API. The main DATABASE_URL typically
 * points at a superuser (e.g. the Postgres image's POSTGRES_USER), which
 * bypasses every RLS policy. The API should connect as `breeze_app` instead so
 * that row-level security is actually enforced.
 *
 * This runs from autoMigrate (which connects as the admin) because that is the
 * one place at startup where we have an admin connection and can afford to do
 * DDL. It is idempotent and safe to re-run.
 *
 * Returns `true` if the role was created/updated, `false` if the call was
 * skipped because neither password env var is set. Callers that need
 * `breeze_app` to exist (e.g. autoMigrate, before applying RLS-policy
 * migrations) should check the return value and fail fast with a pointed
 * error rather than let Postgres surface an unrelated-looking
 * `role "breeze_app" does not exist` failure many files later.
 */
export async function ensureAppRole(): Promise<boolean> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

  // The password the breeze_app role should be (re)set to. In dev we fall back
  // to POSTGRES_PASSWORD so the same password works for both admin and app.
  const password = selectAppRolePassword() ?? '';

  if (!password) {
    console.warn(
      '[ensure-app-role] Neither BREEZE_APP_DB_PASSWORD nor POSTGRES_PASSWORD is set — skipping breeze_app role setup. RLS will NOT be enforced against the admin connection.',
    );
    return false;
  }

  const client = postgres(connectionString, { max: 1 });

  try {
    // 1. Create the role if it doesn't exist. NOSUPERUSER + NOBYPASSRLS is the
    //    whole point — these flags are why RLS will actually apply.
    //
    //    If the role already exists we deliberately do NOT run
    //    `ALTER ROLE ... WITH NOSUPERUSER NOBYPASSRLS`, because on managed
    //    Postgres platforms (DigitalOcean, AWS RDS, etc.) the admin user is
    //    itself non-superuser and is blocked from altering the SUPERUSER
    //    attribute — even a no-op `NOSUPERUSER → NOSUPERUSER` call raises
    //    "ERROR: permission denied to alter role / Only roles with the
    //    SUPERUSER attribute may change the SUPERUSER attribute."
    //    The role was created with the right attributes on first run;
    //    there is nothing to reconcile on subsequent runs. Production startup
    //    enforcement probes the effective request pool role and hard-fails if
    //    rolsuper or rolbypassrls has drifted (see databaseStartup.ts).
    await client.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
          CREATE ROLE breeze_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
        END IF;
      END $$;
    `);

    // 2. Set the password. Postgres does not allow bind parameters in
    //    ALTER ROLE ... PASSWORD, and DO-block params can't be type-inferred
    //    inside EXECUTE, so we build the literal ourselves by doubling single
    //    quotes (the standard SQL string escape). Password comes from env vars
    //    (BREEZE_APP_DB_PASSWORD or POSTGRES_PASSWORD), not user input.
    const escapedPassword = password.replace(/'/g, "''");
    await client.unsafe(`ALTER ROLE breeze_app WITH PASSWORD '${escapedPassword}'`);

    // 3. Grant CONNECT on whichever database we are currently attached to
    //    (don't hardcode "breeze" — the compose file allows POSTGRES_DB to be
    //    overridden).
    const dbRow = await client`SELECT current_database() AS db`;
    const dbName = dbRow[0]?.db as string | undefined;
    if (dbName) {
      // Quote the identifier to be safe against unusual db names.
      const quoted = '"' + dbName.replace(/"/g, '""') + '"';
      await client.unsafe(`GRANT CONNECT ON DATABASE ${quoted} TO breeze_app`);
    }

    // 4. Table/sequence privileges + default privileges so future migrations
    //    that create new tables automatically grant access to breeze_app.
    await client.unsafe(`
      GRANT USAGE ON SCHEMA public TO breeze_app;
      GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO breeze_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO breeze_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO breeze_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO breeze_app;
    `);

    // 5. Per-table privilege overrides that MUST survive the blanket GRANT above.
    //    The launch-readiness audit_logs append-only invariant (Task 1; migration
    //    `2026-05-25-a-audit-log-append-only.sql`) revokes UPDATE/DELETE on
    //    audit_logs from breeze_app. The blanket GRANT in step 4 silently
    //    re-permits those, so we must re-revoke here on every boot. The trigger
    //    in the migration is the last line of defense — but the GRANT half of
    //    the belt-and-suspenders pair has to actually stick to be worth shipping.
    //
    //    Wrapped in DO ... IF EXISTS because ensureAppRole runs both BEFORE and
    //    AFTER migrations (autoMigrate.ts:366 and :432). On a fresh DB the first
    //    call lands before the audit_logs table itself exists; without the
    //    existence check, startup would crash.
    await client.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_logs') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM breeze_app;
          -- The append-only trigger fires per-row on UPDATE/DELETE only;
          -- TRUNCATE is statement-level and bypasses the trigger entirely.
          -- Belt-and-suspenders: revoke TRUNCATE from PUBLIC too so a future
          -- engineer who adds TRUNCATE to a blanket GRANT (or grants it to a
          -- new role inheriting from breeze_app) doesn't silently open the
          -- bypass. Idempotent re-revoke is a no-op.
          REVOKE TRUNCATE ON TABLE audit_logs FROM PUBLIC;
        END IF;
        -- audit_log_chain is also append-only from breeze_app's perspective:
        -- the chain seal trigger + REVOKE in migration -g- together enforce
        -- immutability, but the blanket GRANT above re-permits UPDATE/DELETE.
        -- Re-revoke here so the privilege restriction actually sticks on boot.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_log_chain') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log_chain FROM breeze_app;
          -- The blanket sequence GRANT in step 4 also re-permits UPDATE (setval)
          -- on chain_seq. setval() lets breeze_app rewind or jump the sequence,
          -- causing PK collisions and sealing failures — DoS-grade. Revoke UPDATE
          -- only; SELECT (currval) and USAGE (nextval via column DEFAULT) are safe
          -- and harmless to keep. The INSERT DEFAULT calls nextval as the table
          -- owner, so USAGE alone is sufficient for normal sealing.
          IF EXISTS (SELECT 1 FROM information_schema.sequences WHERE sequence_schema='public' AND sequence_name='audit_log_chain_chain_seq_seq') THEN
            REVOKE UPDATE ON SEQUENCE audit_log_chain_chain_seq_seq FROM breeze_app;
            GRANT USAGE ON SEQUENCE audit_log_chain_chain_seq_seq TO breeze_app;
          END IF;
        END IF;
        -- audit_chain_anchors (issue #916) is the external anchor — append-only
        -- from breeze_app's perspective in exactly the same way as
        -- audit_log_chain: the immutable trigger + REVOKE in migration -c-
        -- enforce it, but the blanket GRANT above re-permits UPDATE/DELETE.
        -- Re-revoke here so the restriction sticks on every boot.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_chain_anchors') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_chain_anchors FROM breeze_app;
          -- The blanket sequence GRANT in step 4 re-permits UPDATE (setval) on
          -- the anchor's serial sequence. setval() lets breeze_app rewind/jump
          -- anchor_seq, breaking the monotonic anchor ordering the off-box
          -- verifier relies on — DoS-grade, identical to the chain_seq case
          -- above. Revoke UPDATE only; USAGE (nextval via INSERT DEFAULT) and
          -- SELECT (currval) stay.
          IF EXISTS (SELECT 1 FROM information_schema.sequences WHERE sequence_schema='public' AND sequence_name='audit_chain_anchors_anchor_seq_seq') THEN
            REVOKE UPDATE ON SEQUENCE audit_chain_anchors_anchor_seq_seq FROM breeze_app;
            GRANT USAGE ON SEQUENCE audit_chain_anchors_anchor_seq_seq TO breeze_app;
          END IF;
        END IF;
        -- Agent health evidence is append-only except for trusted tenant
        -- restamping during a device move. The migration trigger protects the
        -- evidence fields; this override keeps ordinary app-role UPDATE and
        -- TRUNCATE unavailable after the blanket grants above run at boot.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_health_observations') THEN
          REVOKE UPDATE, TRUNCATE ON TABLE agent_health_observations FROM breeze_app;
          REVOKE TRUNCATE ON TABLE agent_health_observations FROM PUBLIC;
        END IF;
        -- Software inventory observations are retained evidence. The migration
        -- grants the app role only read/append/delete capabilities, but the
        -- blanket grant above runs at every boot, so re-revoke direct UPDATE
        -- and TRUNCATE here. The structural UPDATE RLS policy and immutable
        -- trigger remain in place for trusted tenant restamping.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='software_inventory_observations') THEN
          REVOKE UPDATE, TRUNCATE ON TABLE software_inventory_observations FROM breeze_app;
          REVOKE TRUNCATE ON TABLE software_inventory_observations FROM PUBLIC;
        END IF;
        -- Reconstruction material clocks are maintained only by trusted
        -- SECURITY DEFINER triggers. The API may read them for incremental
        -- exports, but direct writes could suppress or forge change signals.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='partner_export_device_material_state') THEN
          REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE partner_export_device_material_state FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='partner_export_site_material_state') THEN
          REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE partner_export_site_material_state FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='partner_export_configuration_org_state') THEN
          REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE partner_export_configuration_org_state FROM breeze_app;
        END IF;
        -- #3922: llm_egress_events records what an LLM egress attempt DID --
        -- which host, which resolved IP, allowed or blocked. Nothing in the API
        -- updates it (the recorder only INSERTs), and a tenant-reachable role
        -- that can rewrite the blocked flag after the fact turns the audit trail
        -- into a claim. The migration narrows the GRANT, but step 4's blanket
        -- GRANT ... UPDATE ... ON ALL TABLES re-permits it on the very next
        -- boot, so the narrowing only sticks if it is re-applied here.
        -- DELETE stays: the table is in CORE_ORG_CASCADE_DELETE_ORDER and org
        -- erasure has to be able to remove these rows.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='llm_egress_events') THEN
          REVOKE UPDATE, TRUNCATE ON TABLE llm_egress_events FROM breeze_app;
        END IF;
        -- #4371 — WRITER-PATH MATRIX for the six tables re-revoked below.
        --
        -- The original bug: pam_actuation_results shipped a migration REVOKE
        -- with no matching re-revoke here, so the blanket GRANT in step 4
        -- silently restored it every boot. Closing that gap is not enough on
        -- its own: every LEGITIMATE writer of these tables (device permanent-
        -- delete, device org-move, org merge, org erasure) also has to keep
        -- working under the now-real privilege wall, or the fix just trades
        -- one bug for a different one. Below is the audit — table, what
        -- breeze_app keeps vs loses, and how each writer path copes:
        --
        --  pam_actuation_results   UPDATE/DELETE/TRUNCATE all revoked (full
        --                          append-only). Device delete: DELETE
        --                          routes through breeze_audit_admin +
        --                          breeze.allow_audit_retention='1'
        --                          (DEVICE_CASCADE_AUDIT_ADMIN_TABLES,
        --                          deviceDeletion.ts). Device org-move:
        --                          N/A — a device with PAM history cannot
        --                          move orgs at all (devices_pam_history_
        --                          move_guard / PamDeviceMoveBlockedError;
        --                          also excluded from the generic org_id
        --                          cascade discovery, migrations/2026-09-17-
        --                          pam-device-move-guard.sql). Org merge:
        --                          'blocks-merge' (orgMergeRegistry.ts) — a
        --                          loser org holding any row refuses the
        --                          merge outright. Org erasure: breeze_
        --                          audit_admin (AUDIT_ADMIN_REQUIRED_TABLES,
        --                          tenantCascade.ts). No app path ever needs
        --                          breeze_app UPDATE/DELETE — full
        --                          privilege-wall protection.
        --
        --  agent_rollback_events   UPDATE/DELETE/TRUNCATE all revoked (full
        --                          append-only). Device delete: same
        --                          breeze_audit_admin escalation as above.
        --                          Device org-move: restamped by the
        --                          SECURITY DEFINER breeze_cascade_device_
        --                          org_id() trigger (migrations/2026-05-18-
        --                          device-child-orgid-cascade.sql), not an
        --                          app-role UPDATE — DEVICE_ORG_FK_CASCADE_
        --                          TABLES in routes/devices/core.ts skips
        --                          the redundant app-level statement. Org
        --                          merge: 'leave-for-erasure' (orgMerge
        --                          Registry.ts) — no role can ever UPDATE
        --                          it, so a repoint was never valid. Org
        --                          erasure: breeze_audit_admin. Full
        --                          privilege-wall protection.
        --
        --  ml_feedback_events      UPDATE/DELETE revoked (TRUNCATE too, as
        --                          defense-in-depth — see the audit_logs/
        --                          agent_health_observations pattern above).
        --                          No device_id column, so neither device
        --                          delete nor device org-move ever touch it.
        --                          Org merge: 'leave-for-erasure'. Org
        --                          erasure: breeze_audit_admin. Full
        --                          privilege-wall protection.
        --
        --  peripheral_policy_      UPDATE/DELETE/TRUNCATE all revoked (full
        --  delivery_events         append-only, #4806 fixup). Device
        --                          org-move: restamped by the SECURITY
        --                          DEFINER breeze_cascade_device_org_id()
        --                          trigger (migrations/2026-05-18-device-
        --                          child-orgid-cascade.sql), not an app-role
        --                          UPDATE — DEVICE_ORG_FK_CASCADE_TABLES in
        --                          routes/devices/core.ts skips the
        --                          redundant app-level statement, same as
        --                          agent_rollback_events above. Device
        --                          delete: DELETE routes through breeze_
        --                          audit_admin (same escalation set as
        --                          above). Org merge: 'leave-for-erasure'
        --                          (orgMergeRegistry.ts) — no role can ever
        --                          UPDATE it, so a repoint was never valid,
        --                          same reclassification as agent_rollback_
        --                          events. Org erasure: breeze_audit_admin.
        --                          Full privilege-wall protection — closes
        --                          the residual gap tracked as issue #4806.
        --
        --  automation_action_      Only TRUNCATE revoked; UPDATE/DELETE stay
        --  results                 granted. NOT an append-only table by
        --                          design (no append-only trigger exists for
        --                          it at all) — TRUNCATE-only was always a
        --                          defense-in-depth bulk-wipe guard, not part
        --                          of an append-only contract. No writer path
        --                          needs TRUNCATE (grep confirms no app code
        --                          issues one), so nothing to reconcile.
        --
        --  device_software_        Only TRUNCATE revoked; UPDATE/DELETE stay
        --  inventory_state         granted. Same as automation_action_results:
        --                          genuinely mutable current-device-state
        --                          (unlike its append-only sibling
        --                          software_inventory_observations above),
        --                          no append-only trigger, no writer path
        --                          needs TRUNCATE.
        --
        -- Verified against real Postgres: apps/api/src/__tests__/integration/
        -- ensureAppRoleAppendOnlyPrivileges.integration.test.ts (privilege
        -- shape) plus the specific writer-path suites (pamActuationLifecycle,
        -- quickSupportChain, deviceDeleteDiscoveredAssetLink, agentRunMove
        -- Semantics, deviceMoveOrgCurrency, orgMergeRegistry, ticketDraftsRls,
        -- inboundEmailContactRequester).
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ml_feedback_events') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ml_feedback_events FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='peripheral_policy_delivery_events') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE peripheral_policy_delivery_events FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_rollback_events') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE agent_rollback_events FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pam_actuation_results') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE pam_actuation_results FROM breeze_app;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='automation_action_results') THEN
          REVOKE TRUNCATE ON TABLE automation_action_results FROM breeze_app;
          REVOKE TRUNCATE ON TABLE automation_action_results FROM PUBLIC;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='device_software_inventory_state') THEN
          REVOKE TRUNCATE ON TABLE device_software_inventory_state FROM breeze_app;
          REVOKE TRUNCATE ON TABLE device_software_inventory_state FROM PUBLIC;
        END IF;
      END $$;
    `);

    console.log('[ensure-app-role] breeze_app role ensured (NOSUPERUSER, NOBYPASSRLS)');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ensure-app-role] failed: ${message}`);
    throw err;
  } finally {
    await client.end();
  }
}
