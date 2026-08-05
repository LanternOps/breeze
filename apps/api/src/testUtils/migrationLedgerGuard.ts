/**
 * Migration-ledger drift guard for the integration suite (#3066).
 *
 * The failure it exists for (#3064): a sibling worktree's branch applied ITS
 * migrations to the shared :5433 test database, so the DB's
 * `breeze_migrations` ledger — and `information_schema` — contained tables
 * that do not exist on the current checkout. Suites that enumerate the live
 * schema (tenantCascade, rls-coverage, export-policy) then fail in ways that
 * are byte-identical to a genuine missing-registration defect, and even a
 * "clean worktree repro against origin/main" reproduces it because the clean
 * worktree still dials the same polluted database. This guard turns that
 * multi-hour false-positive investigation into an immediate, self-explaining
 * failure BEFORE autoMigrate touches anything.
 *
 * Pure logic only — no postgres import — so the unit suite covers it without
 * a database. The orchestration (reading the ledger, discovering checkout
 * files) lives in `__tests__/integration/globalSetup.ts`.
 */

/** Env var that downgrades the guard to a warning (deliberate operator opt-out). */
export const LEDGER_DRIFT_BYPASS_ENV = 'BREEZE_INTEGRATION_ALLOW_LEDGER_DRIFT';

/**
 * Ledger rows applied to the connected DB that this checkout has no migration
 * file for. Extension-namespaced rows (`<extension>/<file>`) are ignored: the
 * checksum loop already tolerates absent extensions (see
 * `partitionLedgerRows`), and core migrations are where every observed
 * pollution incident actually manifested.
 */
export function findUnknownCoreLedgerEntries(
  ledgerFilenames: readonly string[],
  checkoutFilenames: readonly string[],
): string[] {
  const known = new Set(checkoutFilenames);
  return ledgerFilenames
    .filter((filename) => !filename.includes('/'))
    .filter((filename) => !known.has(filename))
    .sort((a, b) => a.localeCompare(b));
}

export function formatLedgerDriftError(
  unknown: readonly string[],
  dbTarget: string,
): string {
  const listed = unknown.slice(0, 10).map((f) => `  - ${f}`).join('\n');
  const more = unknown.length > 10 ? `\n  ... and ${unknown.length - 10} more` : '';
  return (
    `Integration run refused: the test database at ${dbTarget} has ${unknown.length} applied migration(s) `
    + 'this checkout does not contain:\n'
    + `${listed}${more}\n\n`
    + 'This almost always means a SHARED test database was migrated by another worktree/branch '
    + '(or your checkout is behind the branch that last used it). Running against it produces false '
    + 'failures in the schema-enumerating suites (tenantCascade / rls-coverage / export-policy — see #3064), '
    + 'so results would not be trustworthy either way.\n\n'
    + 'Fix one of:\n'
    + '  1. Give this worktree its own isolated stack:  pnpm test-stack up   (then rerun; `pnpm test-stack down` when done)\n'
    + '  2. Reset the shared stack (ONLY if no other session needs its state):\n'
    + '     docker compose -f docker-compose.test.yml down -v && docker compose -f docker-compose.test.yml up -d\n'
    + `  3. Deliberately proceed anyway:  ${LEDGER_DRIFT_BYPASS_ENV}=1\n`
  );
}
