import { describe, expect, it, vi } from 'vitest';
import { initializeDatabaseForStartup } from './databaseStartup';

describe('initializeDatabaseForStartup', () => {
  it('verifies the production request role when AUTO_MIGRATE=false', async () => {
    const migrate = vi.fn();
    const verifyRequestRole = vi.fn().mockRejectedValue(new Error('unsafe request role'));

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: false,
        production: true,
        migrate,
        verifyRequestRole,
      }),
    ).rejects.toThrow('unsafe request role');

    expect(migrate).not.toHaveBeenCalled();
    expect(verifyRequestRole).toHaveBeenCalledOnce();
  });

  it('runs migrations before verifying the production request role', async () => {
    const calls: string[] = [];
    const migrate = vi.fn(async () => {
      calls.push('migrate');
    });
    const verifyRequestRole = vi.fn(async () => {
      calls.push('verify');
      return {
        currentUser: 'breeze_app',
        isSuperuser: false,
        bypassesRls: false,
      };
    });

    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: true,
      migrate,
      verifyRequestRole,
    });

    expect(calls).toEqual(['migrate', 'verify']);
  });

  it('runs enabled migrations without probing the request role outside production', async () => {
    const migrate = vi.fn();
    const verifyRequestRole = vi.fn();

    await initializeDatabaseForStartup({
      autoMigrateEnabled: true,
      production: false,
      migrate,
      verifyRequestRole,
    });

    expect(migrate).toHaveBeenCalledOnce();
    expect(verifyRequestRole).not.toHaveBeenCalled();
  });

  it('does nothing when migrations are disabled outside production', async () => {
    const migrate = vi.fn();
    const verifyRequestRole = vi.fn();

    await initializeDatabaseForStartup({
      autoMigrateEnabled: false,
      production: false,
      migrate,
      verifyRequestRole,
    });

    expect(migrate).not.toHaveBeenCalled();
    expect(verifyRequestRole).not.toHaveBeenCalled();
  });
});
