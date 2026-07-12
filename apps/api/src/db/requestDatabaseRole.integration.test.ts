import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabaseUrlSafe } from '../testUtils/integrationDatabaseSafety';

const rawAdminDatabaseUrl = process.env.DATABASE_URL;
const rawAppDatabaseUrl = process.env.DATABASE_URL_APP;
const BYPASS_ROLE = 'breeze_request_bypassrls_test';
const BYPASS_PASSWORD = 'breeze_request_bypassrls_test_password';

if (!rawAdminDatabaseUrl || !rawAppDatabaseUrl) {
  throw new Error(
    'request database role tests require DATABASE_URL (admin) and DATABASE_URL_APP (breeze_app)',
  );
}

// These assertions intentionally run at module evaluation, before beforeAll can
// construct the admin client or execute DROP/CREATE ROLE. Both URLs must stay
// inside the same explicit local-test safety boundary as the shared integration
// runner despite this suite not importing its hook-heavy setup module.
const ADMIN_DATABASE_URL = assertTestDatabaseUrlSafe(
  rawAdminDatabaseUrl,
  'request database role admin setup',
);
const APP_DATABASE_URL = assertTestDatabaseUrlSafe(
  rawAppDatabaseUrl,
  'request database role app setup',
);

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
    const safeBypassUrl = assertTestDatabaseUrlSafe(
      bypassUrl.toString(),
      'request database role bypass setup',
    );
    const { assertRequestDatabaseRoleSafe } = await loadFreshRequestPool(safeBypassUrl);

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
});
