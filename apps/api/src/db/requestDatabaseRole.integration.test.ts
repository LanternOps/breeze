import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabaseUrlSafe } from '../testUtils/integrationDatabaseSafety';

const ADMIN_DATABASE_URL = process.env.DATABASE_URL;
const APP_DATABASE_URL = process.env.DATABASE_URL_APP;
const BYPASS_ROLE = 'breeze_request_bypassrls_test';
const BYPASS_PASSWORD = 'breeze_request_bypassrls_test_password';

if (!ADMIN_DATABASE_URL || !APP_DATABASE_URL) {
  throw new Error(
    'request database role tests require DATABASE_URL (admin) and DATABASE_URL_APP (breeze_app)',
  );
}

// These assertions intentionally run at module evaluation, before beforeAll can
// construct the admin client or execute DROP/CREATE ROLE. Both URLs must stay
// inside the same explicit local-test safety boundary as the shared integration
// runner despite this suite not importing its hook-heavy setup module.
assertTestDatabaseUrlSafe(ADMIN_DATABASE_URL, 'request database role admin setup');
assertTestDatabaseUrlSafe(APP_DATABASE_URL, 'request database role app setup');

let adminClient: Sql;
let closeRequestPool: (() => Promise<void>) | undefined;

async function loadFreshRequestPool(connectionUrl: string) {
  if (closeRequestPool) {
    await closeRequestPool();
    closeRequestPool = undefined;
  }

  vi.resetModules();
  process.env.DATABASE_URL_APP = connectionUrl;
  process.env.NODE_ENV = 'test';
  const database = await import('./index');
  closeRequestPool = database.closeDb;
  return database;
}

describe('request database role startup enforcement', () => {
  beforeAll(async () => {
    adminClient = postgres(ADMIN_DATABASE_URL, { max: 1 });
    await adminClient.unsafe(`DROP ROLE IF EXISTS ${BYPASS_ROLE}`);
    await adminClient.unsafe(
      `CREATE ROLE ${BYPASS_ROLE} LOGIN PASSWORD '${BYPASS_PASSWORD}' NOSUPERUSER BYPASSRLS`,
    );
  });

  afterEach(async () => {
    await closeRequestPool?.();
    closeRequestPool = undefined;
    vi.resetModules();
    process.env.DATABASE_URL = ADMIN_DATABASE_URL;
    process.env.DATABASE_URL_APP = APP_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    delete process.env.AUTO_MIGRATE;
    delete process.env.BREEZE_ALLOW_UNSAFE_DB_ROLE;
  });

  afterAll(async () => {
    await adminClient.unsafe(`DROP ROLE IF EXISTS ${BYPASS_ROLE}`);
    await adminClient.end();
  });

  it('reports the exact breeze_app request-pool role', async () => {
    const { getRequestDatabaseRole } = await loadFreshRequestPool(APP_DATABASE_URL);

    await expect(getRequestDatabaseRole()).resolves.toEqual({
      currentUser: 'breeze_app',
      isSuperuser: false,
      bypassesRls: false,
    });
  });

  it('rejects a SUPERUSER request pool', async () => {
    const { assertRequestDatabaseRoleSafe } = await loadFreshRequestPool(ADMIN_DATABASE_URL);

    await expect(assertRequestDatabaseRoleSafe()).rejects.toThrow(/SUPERUSER/);
  });

  it('rejects a BYPASSRLS request pool', async () => {
    const bypassUrl = new URL(ADMIN_DATABASE_URL);
    bypassUrl.username = BYPASS_ROLE;
    bypassUrl.password = BYPASS_PASSWORD;
    const { assertRequestDatabaseRoleSafe } = await loadFreshRequestPool(bypassUrl.toString());

    await expect(assertRequestDatabaseRoleSafe()).rejects.toThrow(/BYPASSRLS/);
  });

  it('rejects unsafe production startup when AUTO_MIGRATE=false without invoking migrations', async () => {
    vi.resetModules();
    process.env.DATABASE_URL = ADMIN_DATABASE_URL;
    process.env.DATABASE_URL_APP = ADMIN_DATABASE_URL;
    process.env.NODE_ENV = 'production';
    process.env.AUTO_MIGRATE = 'false';

    const database = await import('./index');
    closeRequestPool = database.closeDb;
    const { initializeDatabaseForStartup } = await import('./databaseStartup');
    const migrate = vi.fn();

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: process.env.AUTO_MIGRATE !== 'false',
        production: process.env.NODE_ENV === 'production',
        migrate,
      }),
    ).rejects.toThrow(/SUPERUSER/);
    expect(migrate).not.toHaveBeenCalled();
  });

  // The startup role check is unconditional. NODE_ENV is operator-supplied
  // configuration and can disagree with the deployment it describes, so it must
  // not decide whether the check runs. These cases drive the real pool with a
  // genuinely privileged connection while NODE_ENV says otherwise, and require
  // refusal anyway.
  it('rejects a SUPERUSER request pool at startup when NODE_ENV is not production', async () => {
    const { getRequestDatabaseRole } = await loadFreshRequestPool(ADMIN_DATABASE_URL);
    process.env.NODE_ENV = 'development';
    // Control: this connection really is the privileged one, so the refusal below
    // is the guard firing and not a vacuously-unreachable branch.
    await expect(getRequestDatabaseRole()).resolves.toMatchObject({ isSuperuser: true });

    const { initializeDatabaseForStartup } = await import('./databaseStartup');
    const migrate = vi.fn();

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate,
      }),
    ).rejects.toThrow(/SUPERUSER[\s\S]*BREEZE_ALLOW_UNSAFE_DB_ROLE/);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('rejects a BYPASSRLS request pool at startup when NODE_ENV is not production', async () => {
    const bypassUrl = new URL(ADMIN_DATABASE_URL);
    bypassUrl.username = BYPASS_ROLE;
    bypassUrl.password = BYPASS_PASSWORD;
    const { getRequestDatabaseRole } = await loadFreshRequestPool(bypassUrl.toString());
    process.env.NODE_ENV = 'test';
    await expect(getRequestDatabaseRole()).resolves.toEqual({
      currentUser: BYPASS_ROLE,
      isSuperuser: false,
      bypassesRls: true,
    });

    const { initializeDatabaseForStartup } = await import('./databaseStartup');

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate: vi.fn(),
      }),
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it('boots an unsafe request pool only under the explicit opt-out, logging loudly', async () => {
    const bypassUrl = new URL(ADMIN_DATABASE_URL);
    bypassUrl.username = BYPASS_ROLE;
    bypassUrl.password = BYPASS_PASSWORD;
    await loadFreshRequestPool(bypassUrl.toString());
    process.env.NODE_ENV = 'development';
    process.env.BREEZE_ALLOW_UNSAFE_DB_ROLE = 'true';

    const { initializeDatabaseForStartup } = await import('./databaseStartup');
    const errors: unknown[] = [];

    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: false,
      migrate: vi.fn(),
      logger: {
        log: () => {},
        warn: () => {},
        error: (...args: unknown[]) => errors.push(args[0]),
      },
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('BYPASSRLS');
    expect(String(errors[0])).toContain('BREEZE_ALLOW_UNSAFE_DB_ROLE');
  });

  it('ignores the opt-out in production', async () => {
    await loadFreshRequestPool(ADMIN_DATABASE_URL);
    process.env.NODE_ENV = 'production';
    process.env.BREEZE_ALLOW_UNSAFE_DB_ROLE = 'true';

    const { initializeDatabaseForStartup } = await import('./databaseStartup');

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: true,
        migrate: vi.fn(),
      }),
    ).rejects.toThrow(/SUPERUSER/);
  });
});
