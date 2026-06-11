import postgres from 'postgres';

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
 */
export async function ensureAppRole(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

  // The password the breeze_app role should be (re)set to. In dev we fall back
  // to POSTGRES_PASSWORD so the same password works for both admin and app.
  const password =
    process.env.BREEZE_APP_DB_PASSWORD || process.env.POSTGRES_PASSWORD || '';

  if (!password) {
    console.warn(
      '[ensure-app-role] Neither BREEZE_APP_DB_PASSWORD nor POSTGRES_PASSWORD is set — skipping breeze_app role setup. RLS will NOT be enforced against the admin connection.',
    );
    return;
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
    //    there is nothing to reconcile on subsequent runs. The probe in
    //    autoMigrate already verifies rolsuper=false / rolbypassrls=false
    //    and hard-fails startup if either has drifted.
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
        END IF;
      END $$;
    `);

    console.log('[ensure-app-role] breeze_app role ensured (NOSUPERUSER, NOBYPASSRLS)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ensure-app-role] failed: ${message}`);
    throw err;
  } finally {
    await client.end();
  }
}
