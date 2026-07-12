import type { RequestDatabaseRole } from './index';

export interface DatabaseStartupOptions {
  autoMigrateEnabled: boolean;
  production: boolean;
  migrate?: () => Promise<void>;
  verifyRequestRole?: () => Promise<RequestDatabaseRole>;
}

/**
 * Runs database startup work in its security-sensitive order: migrations may
 * create/configure the request role, then production verifies the exact pool
 * that will serve requests. Disabling migrations never disables verification.
 */
export async function initializeDatabaseForStartup(
  options: DatabaseStartupOptions,
): Promise<void> {
  const migrate = options.migrate ?? (async () => {
    const { autoMigrate } = await import('./autoMigrate');
    await autoMigrate();
  });
  const verifyRequestRole = options.verifyRequestRole ?? (async () => {
    const { assertRequestDatabaseRoleSafe } = await import('./index');
    return assertRequestDatabaseRoleSafe();
  });

  if (options.autoMigrateEnabled) {
    await migrate();
  }

  if (options.production) {
    await verifyRequestRole();
  }
}
