import postgres from 'postgres';
import { BREEZE_VERSION_HISTORY_TABLE } from '../db/versionHistory';
import { BREAKING_CHANGES_MANIFEST, BREAKING_CHANGES_MANIFEST_ERROR } from './breakingChangesManifest';
import {
  buildPreflightReport,
  formatPreflightReport,
  normalizeReleaseVersion,
  preflightExitCode,
  type DeploymentState,
  type PreflightReport,
} from './upgradePreflight';

/**
 * I/O half of the upgrade preflight (#6605): reads the deployment's recorded
 * version history and migration ledger, and records the running version after
 * migrations. Every read here is best-effort — a failure becomes a "missing"
 * state, which widens the report instead of aborting it.
 *
 * Runs on the migration connection (DATABASE_URL, the schema owner), exactly
 * like autoMigrate. It never takes the migration advisory lock: it only reads.
 */

type Logger = Pick<Console, 'log' | 'warn'>;

const DEFAULT_TIMEOUT_MS = 15_000;

function openConnection(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { application_name: 'breeze-upgrade-preflight', statement_timeout: 5_000 },
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present
  `;
  return rows[0]?.present === true;
}

async function readHistory(sql: postgres.Sql): Promise<DeploymentState['history']> {
  try {
    if (!(await tableExists(sql, BREEZE_VERSION_HISTORY_TABLE))) {
      return {
        status: 'missing',
        reason: `${BREEZE_VERSION_HISTORY_TABLE} does not exist yet — this deployment predates version recording`,
      };
    }
    const rows = await sql.unsafe<{ version: string; first_seen_at: Date }[]>(
      `SELECT version, first_seen_at FROM ${BREEZE_VERSION_HISTORY_TABLE} ORDER BY first_seen_at`,
    );
    return { status: 'ok', versions: rows.map((r) => ({ version: r.version, firstSeenAt: r.first_seen_at })) };
  } catch (err) {
    return { status: 'missing', reason: `could not read ${BREEZE_VERSION_HISTORY_TABLE}: ${describeError(err)}` };
  }
}

async function readLedger(sql: postgres.Sql): Promise<DeploymentState['ledger']> {
  try {
    const { MIGRATION_TABLE, discoverCoreMigrationFilenames } = await import('../db/autoMigrate');
    if (!(await tableExists(sql, MIGRATION_TABLE))) {
      return { status: 'missing', reason: `${MIGRATION_TABLE} does not exist — an empty database` };
    }
    const rows = await sql.unsafe<{ filename: string }[]>(`SELECT filename FROM ${MIGRATION_TABLE}`);
    // Extension migrations share the ledger as `<extension>/<file>`; count core only.
    const applied = new Set(rows.map((r) => r.filename).filter((f) => !f.includes('/')));
    const image = await discoverCoreMigrationFilenames();
    return {
      status: 'ok',
      appliedCount: applied.size,
      pendingCount: image.filter((f) => !applied.has(f)).length,
    };
  } catch (err) {
    return { status: 'missing', reason: `could not read the migration ledger: ${describeError(err)}` };
  }
}

export async function readDeploymentState(
  sql: postgres.Sql,
  currentVersion: string | null | undefined,
): Promise<DeploymentState> {
  return {
    currentVersion,
    history: await readHistory(sql),
    ledger: await readLedger(sql),
  };
}

function unreadableState(currentVersion: string | null | undefined, reason: string): DeploymentState {
  return {
    currentVersion,
    history: { status: 'missing', reason },
    ledger: { status: 'missing', reason },
  };
}

export interface RunUpgradePreflightOptions {
  databaseUrl: string | undefined;
  currentVersion: string | null | undefined;
  logger?: Logger;
  timeoutMs?: number;
  strict?: boolean;
}

/**
 * Build and log the report. Never throws for a database problem: an
 * unreachable or slow database yields the broad "no history" report.
 */
export async function runUpgradePreflight(
  options: RunUpgradePreflightOptions,
): Promise<{ report: PreflightReport; exitCode: number }> {
  const logger = options.logger ?? console;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let state: DeploymentState;

  if (!options.databaseUrl) {
    state = unreadableState(options.currentVersion, 'DATABASE_URL is not set');
  } else {
    const sql = openConnection(options.databaseUrl);
    let timer: NodeJS.Timeout | undefined;
    try {
      state = await Promise.race([
        readDeploymentState(sql, options.currentVersion),
        new Promise<DeploymentState>((resolve) => {
          timer = setTimeout(
            () => resolve(unreadableState(options.currentVersion, `the database did not answer within ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      state = unreadableState(options.currentVersion, `could not reach the database: ${describeError(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }

  const report = buildPreflightReport(BREAKING_CHANGES_MANIFEST, state, {
    manifestError: BREAKING_CHANGES_MANIFEST_ERROR,
  });
  const text = formatPreflightReport(report).join('\n');
  const needsAttention = report.crossing.length > 0 || report.manifestError !== null;
  if (needsAttention) logger.warn(text);
  else logger.log(text);

  return { report, exitCode: preflightExitCode(report, { strict: options.strict ?? false }) };
}

/**
 * Record `(version, first_seen_at)` for the running image so the next upgrade's
 * preflight knows what this deployment actually ran. Idempotent across boots
 * and replicas (ON CONFLICT DO NOTHING keeps the first sighting). Throws on a
 * database error; the boot caller turns that into a warning.
 */
export async function recordRunningVersion(options: {
  databaseUrl: string;
  currentVersion: string | null | undefined;
  logger?: Logger;
}): Promise<void> {
  const logger = options.logger ?? console;
  const raw = options.currentVersion?.trim().replace(/^v/, '') ?? '';
  if (normalizeReleaseVersion(raw) === null) {
    logger.log(
      `[upgrade-preflight] Version not recorded: APP_VERSION=${JSON.stringify(options.currentVersion ?? '')} is not a release version.`,
    );
    return;
  }

  const sql = openConnection(options.databaseUrl);
  try {
    const inserted = await sql.unsafe<{ version: string }[]>(
      `INSERT INTO ${BREEZE_VERSION_HISTORY_TABLE} (version) VALUES ($1)
       ON CONFLICT (version) DO NOTHING
       RETURNING version`,
      [raw],
    );
    if (inserted.length > 0) {
      logger.log(`[upgrade-preflight] Recorded first boot of version ${raw}.`);
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
