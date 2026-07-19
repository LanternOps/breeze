// CI-only: apply EVERY migration through the real autoMigrate() entrypoint as
// a NON-SUPERUSER role that mirrors a managed-Postgres admin (DigitalOcean
// `doadmin`, AWS RDS master, etc.): it has LOGIN, CREATEDB, CREATEROLE,
// REPLICATION, and BYPASSRLS, but is NOT a superuser.
//
// Why this exists — this is the class-complete guard against superuser-only
// DDL slipping into a migration. Superuser-only statements
// (`ALTER FUNCTION ... OWNER TO`, `SET <custom.guc> = ...` as a function
// attribute, `ALTER ROLE|DATABASE ... SET`, `ALTER SYSTEM`, `CREATE ROLE`,
// `COPY ... FROM PROGRAM`, ...) all succeed when migrations are applied as the
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
 * As the superuser, create the doadmin-alike migration role and a database it
 * owns. Everything else — including the unprivileged `breeze_app` login — is
 * created by autoMigrate()/ensureAppRole() running AS the migration role, so
 * those code paths are exercised under the same privilege constraints as prod.
 */
async function provisionMigratorRole(): Promise<void> {
  const admin = postgres(SUPERUSER_URL, { max: 1 });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
          -- NOSUPERUSER is the whole point. The other attributes match a real
          -- managed-Postgres admin so the run is faithful: BYPASSRLS (doadmin
          -- has it — it is why RLS-seeding migrations apply), CREATEROLE (to
          -- create breeze_app), CREATEDB, REPLICATION.
          CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}'
            NOSUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;
        END IF;
      END $$;
    `);
    // PG16 tightened CREATEROLE: a non-superuser creator no longer implicitly
    // administers the roles it makes. doadmin behaves as if self-grant is on,
    // so set it here — without it, ensureAppRole()'s CREATE ROLE breeze_app
    // and the migrations' `REVOKE ... FROM breeze_app` fail with a privilege
    // error that prod would not hit.
    await admin.unsafe(
      `ALTER ROLE ${MIGRATOR_ROLE} SET createrole_self_grant = 'set, inherit'`,
    );
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
