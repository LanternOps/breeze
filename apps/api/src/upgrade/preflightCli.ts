/**
 * Strict mode for the operator-invoked preflight CLI (#6605): `--strict`, or
 * BREEZE_UPGRADE_PREFLIGHT_STRICT=true|1. Boot never reads this — the API's
 * own boot report is always report-only.
 */
export function strictRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes('--strict')) return true;
  const value = (env.BREEZE_UPGRADE_PREFLIGHT_STRICT ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Exit code when the preflight itself crashed (a bug — database failures are
 * already turned into a broad report). Only a strict run fails.
 */
export function crashExitCode(strict: boolean): number {
  return strict ? 1 : 0;
}
