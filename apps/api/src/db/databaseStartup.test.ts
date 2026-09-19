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
