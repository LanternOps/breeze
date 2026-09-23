#!/usr/bin/env tsx
/**
 * Upgrade preflight (#6605), operator-invoked form.
 *
 * Run the NEW image against the CURRENT database before bringing it up, to see
 * every retirement the upgrade crosses before any migration runs:
 *
 *   docker compose pull api
 *   docker compose run --rm --no-deps api node dist/scripts/upgrade-preflight.cjs
 *   docker compose run --rm --no-deps api node dist/scripts/upgrade-preflight.cjs --strict
 *
 * Read-only: it never migrates and never records a version. The API prints the
 * same report at every boot, before autoMigrate, so an operator who skips this
 * step still gets it in the logs.
 *
 * Exit codes:
 *   0  default mode, always (the report is informational), or strict mode
 *      with no removal crossed.
 *   1  strict mode only (`--strict` or BREEZE_UPGRADE_PREFLIGHT_STRICT=true):
 *      a removal is crossed, or may be because this deployment has no version
 *      history, or the bundled manifest is unreadable.
 */
import { runUpgradePreflight } from '../src/upgrade/upgradePreflightRunner';

function strictRequested(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes('--strict')) return true;
  const value = (env.BREEZE_UPGRADE_PREFLIGHT_STRICT ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

async function main(): Promise<number> {
  const { exitCode } = await runUpgradePreflight({
    databaseUrl: process.env.DATABASE_URL,
    currentVersion: process.env.APP_VERSION,
    strict: strictRequested(process.argv.slice(2), process.env),
  });
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // runUpgradePreflight turns database failures into a broad report, so
    // reaching here is a bug in the preflight itself. Say so, and only fail
    // the run when the operator asked for a gate.
    console.error('[upgrade-preflight] Preflight crashed:', err);
    process.exit(strictRequested(process.argv.slice(2), process.env) ? 1 : 0);
  });
