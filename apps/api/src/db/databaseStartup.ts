import {
  formatUnsafeDbRoleOptOutBanner,
  formatUnsafeRequestDatabaseRoleMessage,
  isUnsafeDbRoleOptOutEnabled,
  UNSAFE_DB_ROLE_OPT_OUT_ENV,
  unsafeRequestDatabaseRoleCapabilities,
  type RequestDatabaseRole,
} from './requestDatabaseRoleSafety';

export interface DatabaseStartupOptions {
  autoMigrateEnabled: boolean;
  /**
   * Whether this process believes it is a production deployment. Used ONLY to
   * refuse the break-glass opt-out below — never to decide whether the request
   * role is verified at all.
   */
  production: boolean;
  migrate?: () => Promise<void>;
  /**
   * Reads the effective role of the pool that will serve requests. Classification
   * stays here so a failure to READ the role can never be mistaken for, or
   * suppressed alongside, a role that is merely known-unsafe.
   */
  readRequestRole?: () => Promise<RequestDatabaseRole>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Runs database startup work in its security-sensitive order: migrations may
 * create/configure the request role, then the exact pool that will serve
 * requests is verified to be NOSUPERUSER NOBYPASSRLS.
 *
 * The verification is unconditional. It used to run only when the process
 * considered itself production, which made a single operator-supplied string
 * (NODE_ENV) decide whether row-level security was checked at all — a value that
 * can fail to reach the container, or arrive with a dev/test spelling, without
 * anything else looking wrong. Disabling migrations does not disable
 * verification either; the only way past it is the explicit, loudly-logged,
 * non-production `BREEZE_ALLOW_UNSAFE_DB_ROLE` opt-out.
 */
export async function initializeDatabaseForStartup(
  options: DatabaseStartupOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const migrate = options.migrate ?? (async () => {
    const { autoMigrate } = await import('./autoMigrate');
    await autoMigrate();
  });
  const readRequestRole = options.readRequestRole ?? (async () => {
    const { getRequestDatabaseRole } = await import('./index');
    return getRequestDatabaseRole();
  });

  if (options.autoMigrateEnabled) {
    await migrate();
  }

  const role = await readRequestRole();
  const unsafeCapabilities = unsafeRequestDatabaseRoleCapabilities(role);

  if (unsafeCapabilities.length === 0) {
    logger.log(
      `[database] Request pool role verified: "${role.currentUser}" ` +
        '(NOSUPERUSER NOBYPASSRLS).',
    );
    return;
  }

  if (!isUnsafeDbRoleOptOutEnabled(env)) {
    throw new Error(
      formatUnsafeRequestDatabaseRoleMessage(role, unsafeCapabilities, {
        advertiseOptOut: !options.production,
      }),
    );
  }

  if (options.production) {
    throw new Error(
      `${formatUnsafeRequestDatabaseRoleMessage(role, unsafeCapabilities)} ` +
        `${UNSAFE_DB_ROLE_OPT_OUT_ENV} is ignored in production.`,
    );
  }

  logger.error(formatUnsafeDbRoleOptOutBanner(role, unsafeCapabilities));
}
