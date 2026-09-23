import { describe, expect, it, vi } from 'vitest';
import { initializeDatabaseForStartup } from './databaseStartup';
import { UNSAFE_DB_ROLE_OPT_OUT_ENV } from './requestDatabaseRoleSafety';

const SAFE_ROLE = {
  currentUser: 'breeze_app',
  isSuperuser: false,
  bypassesRls: false,
};

const SUPERUSER_ROLE = {
  currentUser: 'breeze',
  isSuperuser: true,
  bypassesRls: false,
};

const BYPASSRLS_ROLE = {
  currentUser: 'breeze_reporting',
  isSuperuser: false,
  bypassesRls: true,
};

function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('initializeDatabaseForStartup', () => {
  it('verifies the request role when AUTO_MIGRATE=false', async () => {
    const migrate = vi.fn();
    const readRequestRole = vi.fn().mockRejectedValue(new Error('unsafe request role'));

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: true,
        migrate,
        readRequestRole,
        env: {},
        logger: silentLogger(),
      }),
    ).rejects.toThrow('unsafe request role');

    expect(migrate).not.toHaveBeenCalled();
    expect(readRequestRole).toHaveBeenCalledOnce();
  });

  it('runs migrations before verifying the request role', async () => {
    const calls: string[] = [];
    const migrate = vi.fn(async () => {
      calls.push('migrate');
    });
    const readRequestRole = vi.fn(async () => {
      calls.push('verify');
      return SAFE_ROLE;
    });

    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      migrate,
      readRequestRole,
      env: {},
      logger: silentLogger(),
    });

    expect(calls).toEqual(['migrate', 'verify']);
  });

  // Role verification is a startup invariant, not a production-only one:
  // NODE_ENV is operator-supplied configuration and can disagree with the
  // deployment it is running in, so it must not decide whether the check runs.
  it('verifies the request role outside production too', async () => {
    const readRequestRole = vi.fn(async () => SAFE_ROLE);

    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: false,
      migrate: vi.fn(),
      readRequestRole,
      env: {},
      logger: silentLogger(),
    });

    expect(readRequestRole).toHaveBeenCalledOnce();
  });

  it('verifies the request role outside production even when migrations are disabled', async () => {
    const migrate = vi.fn();
    const readRequestRole = vi.fn(async () => SAFE_ROLE);

    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: false,
      migrate,
      readRequestRole,
      env: {},
      logger: silentLogger(),
    });

    expect(migrate).not.toHaveBeenCalled();
    expect(readRequestRole).toHaveBeenCalledOnce();
  });

  it('refuses a SUPERUSER request role outside production and names the opt-out', async () => {
    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate: vi.fn(),
        readRequestRole: async () => SUPERUSER_ROLE,
        env: { NODE_ENV: 'development' },
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/SUPERUSER[\s\S]*BREEZE_ALLOW_UNSAFE_DB_ROLE/);
  });

  it('refuses a BYPASSRLS request role outside production', async () => {
    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate: vi.fn(),
        readRequestRole: async () => BYPASSRLS_ROLE,
        env: { NODE_ENV: 'test' },
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it('allows an unsafe role only via the explicit opt-out, and logs it loudly', async () => {
    const logger = silentLogger();

    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: false,
      migrate: vi.fn(),
      readRequestRole: async () => BYPASSRLS_ROLE,
      env: { NODE_ENV: 'development', [UNSAFE_DB_ROLE_OPT_OUT_ENV]: 'true' },
      logger,
    });

    expect(logger.error).toHaveBeenCalledOnce();
    const logged = String(logger.error.mock.calls[0]?.[0]);
    expect(logged).toContain(UNSAFE_DB_ROLE_OPT_OUT_ENV);
    expect(logged).toContain('BYPASSRLS');
    expect(logged).toContain('breeze_reporting');
    expect(logged).toMatch(/tenant isolation is NOT enforced/i);
  });

  it('ignores the opt-out in production', async () => {
    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: true,
        migrate: vi.fn(),
        readRequestRole: async () => SUPERUSER_ROLE,
        env: { NODE_ENV: 'production', [UNSAFE_DB_ROLE_OPT_OUT_ENV]: 'true' },
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/SUPERUSER/);
  });

  it('never lets the opt-out swallow a failure to read the role', async () => {
    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate: vi.fn(),
        readRequestRole: async () => {
          throw new Error('[database] Could not query the effective request database role.');
        },
        env: { NODE_ENV: 'development', [UNSAFE_DB_ROLE_OPT_OUT_ENV]: 'true' },
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/Could not query the effective request database role/);
  });

  it('reads the opt-out from process.env when no env override is passed', async () => {
    const logger = silentLogger();
    vi.stubEnv(UNSAFE_DB_ROLE_OPT_OUT_ENV, 'true');
    try {
      await initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: false,
        migrate: vi.fn(),
        readRequestRole: async () => BYPASSRLS_ROLE,
        logger,
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(logger.error).toHaveBeenCalledOnce();
  });
});

// #6605: the upgrade preflight reports retirements before any migration runs,
// and the running version is recorded only after migrations. Neither may ever
// block or crash boot — refusing to boot is an explicit non-goal.
describe('initializeDatabaseForStartup upgrade preflight', () => {
  function tracked(calls: string[]) {
    return {
      upgradePreflight: vi.fn(async () => { calls.push('preflight'); }),
      migrate: vi.fn(async () => { calls.push('migrate'); }),
      recordRunningVersion: vi.fn(async () => { calls.push('record'); }),
      readRequestRole: vi.fn(async () => { calls.push('verify'); return SAFE_ROLE; }),
    };
  }

  it('reports before migrating and records the version after migrating', async () => {
    const calls: string[] = [];
    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      ...tracked(calls),
      env: {},
      logger: silentLogger(),
    });
    expect(calls).toEqual(['preflight', 'migrate', 'record', 'verify']);
  });

  it('still reports and records when AUTO_MIGRATE=false', async () => {
    const calls: string[] = [];
    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: true,
      ...tracked(calls),
      env: {},
      logger: silentLogger(),
    });
    expect(calls).toEqual(['preflight', 'record', 'verify']);
  });

  it('continues boot when the preflight throws', async () => {
    const logger = silentLogger();
    const migrate = vi.fn();
    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      upgradePreflight: vi.fn().mockRejectedValue(new Error('preflight exploded')),
      migrate,
      recordRunningVersion: vi.fn(),
      readRequestRole: vi.fn(async () => SAFE_ROLE),
      env: {},
      logger,
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('preflight exploded');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('continues boot when recording the version throws', async () => {
    const logger = silentLogger();
    const readRequestRole = vi.fn(async () => SAFE_ROLE);
    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      upgradePreflight: vi.fn(),
      migrate: vi.fn(),
      recordRunningVersion: vi.fn().mockRejectedValue(new Error('history insert failed')),
      readRequestRole,
      env: {},
      logger,
    });
    expect(readRequestRole).toHaveBeenCalledOnce();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('history insert failed');
  });

  it('does not record the version when migrations fail', async () => {
    const recordRunningVersion = vi.fn();
    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: true,
        production: true,
        upgradePreflight: vi.fn(),
        migrate: vi.fn().mockRejectedValue(new Error('migration failed')),
        recordRunningVersion,
        readRequestRole: vi.fn(async () => SAFE_ROLE),
        env: {},
        logger: silentLogger(),
      }),
    ).rejects.toThrow('migration failed');
    expect(recordRunningVersion).not.toHaveBeenCalled();
  });

  it('skips the default preflight and recording quietly when DATABASE_URL is unset', async () => {
    const logger = silentLogger();
    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      upgradeChecks: true,
      migrate: vi.fn(),
      readRequestRole: vi.fn(async () => SAFE_ROLE),
      env: {},
      logger,
    });
    expect(logger.log).toHaveBeenCalledWith('[upgrade-preflight] Skipped: DATABASE_URL is not set.');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('runs no default upgrade checks unless asked (the worker shares this path)', async () => {
    const logger = silentLogger();
    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: true,
      readRequestRole: vi.fn(async () => SAFE_ROLE),
      // A reachable-looking URL: if the defaults ran, they would log a report.
      env: { DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', APP_VERSION: '0.116.0' },
      logger,
    });
    const logged = logger.log.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[upgrade-preflight]'))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
