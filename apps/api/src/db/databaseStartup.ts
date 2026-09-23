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
   * Run the upgrade preflight (#6605) and record the running version. Only the
   * API server sets this; the worker shares the image but never migrates, so a
   * second report from it would be noise. Explicit `upgradePreflight` /
   * `recordRunningVersion` functions run regardless (tests).
   */
  upgradeChecks?: boolean;
  /** Report retirements this upgrade crosses. Runs BEFORE migrations. */
  upgradePreflight?: () => Promise<void>;
  /** Record `(version, first_seen_at)`. Runs AFTER migrations succeed. */
  recordRunningVersion?: () => Promise<void>;
  /**
   * Reads the effective role of the pool that will serve requests. Classification
   * stays here so a failure to READ the role can never be mistaken for, or
   * suppressed alongside, a role that is merely known-unsafe.
   */
  readRequestRole?: () => Promise<RequestDatabaseRole>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveUpgradeChecks(
  options: DatabaseStartupOptions,
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, 'log'>,
): { upgradePreflight?: () => Promise<void>; recordRunningVersion?: () => Promise<void> } {
  if (!options.upgradeChecks) {
    return { upgradePreflight: options.upgradePreflight, recordRunningVersion: options.recordRunningVersion };
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl && (!options.upgradePreflight || !options.recordRunningVersion)) {
    logger.log('[upgrade-preflight] Skipped: DATABASE_URL is not set.');
  }
  return {
    upgradePreflight:
      options.upgradePreflight ??
      (databaseUrl
        ? async () => {
            const { runUpgradePreflight } = await import('../upgrade/upgradePreflightRunner');
            await runUpgradePreflight({ databaseUrl, currentVersion: env.APP_VERSION, logger: options.logger ?? console });
          }
        : undefined),
    recordRunningVersion:
      options.recordRunningVersion ??
      (databaseUrl
        ? async () => {
            const { recordRunningVersion } = await import('../upgrade/upgradePreflightRunner');
            await recordRunningVersion({ databaseUrl, currentVersion: env.APP_VERSION, logger: options.logger ?? console });
          }
        : undefined),
  };
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

  const { upgradePreflight, recordRunningVersion } = resolveUpgradeChecks(options, env, logger);

  // Upgrade preflight (#6605): report every retirement this upgrade crosses
  // BEFORE any migration mutates the database. Report-only by contract — a
  // failure here is logged and boot continues; refusing to boot is a non-goal.
  if (upgradePreflight) {
    try {
      await upgradePreflight();
    } catch (err) {
      logger.warn(`[upgrade-preflight] Preflight failed; continuing boot: ${describeError(err)}`);
    }
  }

  if (options.autoMigrateEnabled) {
    await migrate();
  }

  // Only after migrations succeeded (a throw above skips this), so a version is
  // never recorded against a schema it did not finish applying.
  if (recordRunningVersion) {
    try {
      await recordRunningVersion();
    } catch (err) {
      logger.warn(
        `[upgrade-preflight] Could not record the running version; the next upgrade's preflight ` +
          `will report more broadly: ${describeError(err)}`,
      );
    }
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
