// CI-only: apply EVERY migration through the real autoMigrate() entrypoint as
// a NON-SUPERUSER role no more privileged than a managed-Postgres admin
// (DigitalOcean `doadmin`, AWS RDS master, etc.): LOGIN, CREATEDB, CREATEROLE
// and ownership of the database. It is NOT a superuser, does NOT bypass RLS,
// and has no role-level createrole_self_grant (#8991).
//
// Why this exists — this is the class-complete guard against superuser-only
// DDL slipping into a migration. Superuser-only statements
// (`ALTER FUNCTION ... OWNER TO`, `SET <custom.guc> = ...` as a function
// attribute, `ALTER ROLE|DATABASE ... SET`, `ALTER SYSTEM`, writes that rely on
// bypassing RLS, `COPY ... FROM PROGRAM`, ...) all succeed when migrations are applied as the
// Postgres superuser — which is exactly what CI's `check-migrations` job and
// every integration shard's autoMigrate do. Prod migrates as a non-superuser
// and crash-loops on boot instead. This has shipped twice: v0.95.0
// (`ALTER FUNCTION ... OWNER TO`) and v0.97.0 (`SET breeze.scope` GUC
// attribute), each invisible until prod. A static grep is a blocklist that
// always lags the next novel construct; running the real migration set under
// the constrained role lets Postgres itself reject the whole class.
//
// The static guard `src/db/migrationGucAttributes.test.ts` remains as fast,
// precise feedback for the specific GUC-attribute form; this job is the
// backstop that catches everything else.
import postgres from 'postgres';

const SUPERUSER_URL =
  process.env.SUPERUSER_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/postgres';
const MIGRATOR_ROLE = process.env.MIGRATOR_ROLE || 'breeze_migrator';
const MIGRATOR_PASSWORD = process.env.MIGRATOR_PASSWORD || 'migrator';
const MIGRATOR_DB = process.env.MIGRATOR_DB || 'breeze';

/**
 * As the superuser, create the least-privileged migration role (no more
 * privileged than doadmin) and a database it owns. Everything else — including the unprivileged `breeze_app` login — is
 * created by autoMigrate()/ensureAppRole() running AS the migration role, so
 * those code paths are exercised under the same privilege constraints as prod.
 */
async function provisionMigratorRole(): Promise<void> {
  const admin = postgres(SUPERUSER_URL, { max: 1 });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
          -- The LEAST-privileged owner role a fresh install can be handed
          -- (#8991): LOGIN, CREATEDB, CREATEROLE, owner of the database (and so
          -- of schema public), and nothing else. NOSUPERUSER is the point of
          -- the job; NOBYPASSRLS is deliberate too.
          --
          -- NOBYPASSRLS: 122 shipped migrations write rows without electing
          -- breeze.scope='system' themselves (#4518). With BYPASSRLS on this
          -- role they applied anyway and masked that a plain owner role aborts
          -- at 2026-05-22-snmp-multi-vendor-templates.sql with 42501. autoMigrate
          -- now elects system scope for every file, so the set must apply
          -- without the attribute. Granting it here would hide a regression.
          --
          -- No REPLICATION and no role-level createrole_self_grant: PG16 gives
          -- a CREATEROLE creator ADMIN on the roles it makes but not
          -- membership, so 2026-07-16-td-synnex-sftp-price-file.sql's
          -- \`ALTER FUNCTION ... OWNER TO breeze_search\` fails with
          -- "must be able to SET ROLE". autoMigrate sets createrole_self_grant
          -- for its own session. Setting it on the role here would hide a
          -- regression there.
          CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}'
            NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE;
        END IF;
      END $$;
    `);
    // Re-assert the attributes when the role already existed. On a reused local
    // cluster, a role left over from an older version of this script would still
    // carry BYPASSRLS / REPLICATION / a role-level createrole_self_grant, and the
    // run would pass while hiding exactly the regressions it exists to catch.
    await admin.unsafe(
      `ALTER ROLE ${MIGRATOR_ROLE} NOSUPERUSER NOBYPASSRLS NOREPLICATION CREATEDB CREATEROLE`,
    );
    await admin.unsafe(`ALTER ROLE ${MIGRATOR_ROLE} RESET createrole_self_grant`);
    const dbExists = await admin`SELECT 1 FROM pg_database WHERE datname = ${MIGRATOR_DB}`;
    if (dbExists.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${MIGRATOR_DB} OWNER ${MIGRATOR_ROLE}`);
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  // DATABASE_URL (the migrator role) and DATABASE_URL_APP (breeze_app) are set
  // by the caller/CI job so the db modules resolve them at import time — do not
  // mutate DATABASE_URL here, because src/db/index.ts derives the unprivileged
  // request pool at module load, before this function runs.
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must point at the non-superuser migration role (breeze_migrator). ' +
        'Set it (and DATABASE_URL_APP for breeze_app) in the environment before running.',
    );
  }
  await provisionMigratorRole();
  // Imported lazily so the module-load-time db pool derivation reads the
  // already-set DATABASE_URL / DATABASE_URL_APP rather than a default.
  const { autoMigrate } = await import('../src/db/autoMigrate');
  await autoMigrate();
}

main()
  .then(() => {
    console.log(
      '[check-migrations-nonsuperuser] OK — full migration set applied as a non-superuser role',
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error('[check-migrations-nonsuperuser] FAILED');
    console.error(
      'A migration used a statement the non-superuser migration role could not run.\n' +
        'This is the class that crash-loops prod on boot (e.g. SET <custom.guc> as a\n' +
        'function attribute, ALTER FUNCTION ... OWNER TO, ALTER ROLE/DATABASE ... SET,\n' +
        'ALTER SYSTEM). Move the effect into a form a non-superuser may run (e.g. in-body\n' +
        'set_config with save/restore) and re-run.',
    );
    console.error(err);
    process.exit(1);
  });
