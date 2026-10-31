// Drift check — verifies that the hand-written migration set in
// `apps/api/migrations/` applies cleanly to a fresh Postgres and matches the
// expected `breeze_migrations` ledger when finished.
//
// History. Three earlier scripts in this slot did not actually detect drift:
//   - `drizzle-kit generate --out .drizzle-tmp` always emitted a full-schema
//     SQL file because `.drizzle-tmp` started empty each run, so the
//     wrapping `ls .drizzle-tmp/*.sql` was always true. Reported "drift"
//     every run.
//   - `drizzle-kit check --config drizzle.config.ts` validates only the meta
//     journal inside `.drizzle-tmp` (which is empty), so it always reported
//     "no drift". False pass.
//   - `drizzle-kit push --strict` is destructive (executes non-data-loss
//     DDL before any prompt) and 0.31.10 errors on missing TTY before it
//     can be answered "no".
//
// What is intentionally NOT checked here. Schema-vs-live-DB drift would
// require drizzle-kit's introspect/generate round-trip, which is not
// symmetric enough to be useful in this repo: it produces ~2k lines of
// false-positive diffs from foreign-key naming normalisation, array default
// introspection gaps, and RLS/policy/trigger statements that drizzle does
// not model. Schema-vs-DB correctness is instead enforced by:
//   - `pnpm --filter @breeze/api test:integration` (real DB)
//   - `pnpm --filter @breeze/api test:rls-coverage`
//   - the `autoMigrate.test.ts` regression test
//   - PR-time review of every schema and migration change
//
// What IS checked. The migration set is applied to a fresh database and the
// `breeze_migrations` ledger is verified to contain one row per migration
// file in `apps/api/migrations/`. This catches:
//   - ordering bugs (later migration depends on something not yet created)
//   - SQL syntax errors that escaped local testing
//   - missing IF EXISTS / IF NOT EXISTS guards (non-idempotent migrations)
//   - migration files that are skipped by the runner's filename regex
//
// Namespaced `<extension>/<file>` ledger rows are checked for their file in
// the built-in's migrations directory; only a row whose file is gone fails
// (strict by default, #2424 / #10357).
//
// CI runs this in the `check-migrations` job, right after that job migrates an
// empty Postgres (#10357). Exit codes: 0 clean, 1 drift, 2 no DB / crash.
//
// Usage.
//   pnpm test:docker:up
//   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test \
//     pnpm db:check-drift

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  classifyExtensionLedgerRows,
  partitionLedgerRows,
  planMigrations,
} from '../src/db/autoMigrate';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolvePath(scriptDir, '..');
const migrationsDir = join(projectDir, 'migrations');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is required. Point it at a database with all migrations applied:',
  );
  console.error('  pnpm test:docker:up');
  console.error(
    '  DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:migrate',
  );
  console.error('  DATABASE_URL=... pnpm db:check-drift');
  process.exit(2);
}

/**
 * Resolve `<extension>/<file>` to the built-in's migrations directory exactly
 * as the boot path does (builtinExtensions.ts: `resolveBuiltinRoot(packageDir)`
 * + `manifest.migrationsDir`). Imported lazily: the registry pulls in the
 * built-in modules, which a DB with no extension rows (CI) never needs.
 * An unknown extension name, or a built-in whose manifest cannot be read, has
 * no file on disk.
 */
async function builtinExtensionFileExists(): Promise<
  (extension: string, filename: string) => boolean
> {
  const { BUILTINS, resolveBuiltinRoot } = await import('../src/extensions/builtinRegistry');
  return (extension, filename) => {
    const builtin = BUILTINS.find((candidate) => candidate.name === extension);
    if (!builtin) return false;
    let migrationsDir: string;
    try {
      migrationsDir = builtin.manifest.migrationsDir;
    } catch (err) {
      console.warn(
        `[check-drift] WARN: built-in "${extension}" manifest unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    return existsSync(join(resolveBuiltinRoot(builtin.packageDir), migrationsDir, filename));
  };
}

async function main() {
  // Mirror autoMigrate's filename filter: `^\d{4}-.*\.sql$`.
  const onDisk = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}-.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b));

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    // Treat "undefined_table" (Postgres 42P01) as "migrations have not been
    // applied" and surface the actionable hint. Any other error (auth,
    // connection drop, permission denied) must propagate to the top-level
    // crash handler so the operator sees the real cause rather than a
    // misleading "table not found".
    const ledger = await sql<{ filename: string }[]>`
      SELECT filename FROM breeze_migrations ORDER BY filename
    `.catch((err) => {
      if (err?.code === '42P01') return null;
      throw err;
    });

    if (!ledger) {
      console.error(
        'breeze_migrations table not found. Run `pnpm db:migrate` against this DB first.',
      );
      process.exit(1);
    }

    const expected = planMigrations(onDisk).map((migration) => migration.ledgerName);
    const { verify: ledgerVerifiable, skip: extensionRows } = partitionLedgerRows(
      ledger.map((row) => row.filename),
    );
    // #10357: a namespaced row is only "absent" when its file is really gone.
    // Rows for a built-in whose migrations are still on disk are fine.
    const { present: presentExtensionRows, absent: absentExtensionRows } =
      classifyExtensionLedgerRows(
        extensionRows,
        extensionRows.length > 0 ? await builtinExtensionFileExists() : () => false,
      );

    if (presentExtensionRows.length > 0) {
      console.log(
        `[check-drift] ${presentExtensionRows.length} extension ledger row(s) have their migration file on disk`,
      );
    }
    for (const row of absentExtensionRows) {
      console.warn(
        `[check-drift] WARN: ledger row "${row}" has no migration file on disk (extension removed, or its migration was deleted)`,
      );
    }
    // Strict by default (#2424): an absent-extension ledger row usually means
    // an extension was removed without cleaning up — its migrations can no
    // longer be checksum-verified. Set STRICT_EXTENSION_DRIFT=false only for a
    // deliberate, acknowledged extension removal.
    if (absentExtensionRows.length > 0 && process.env.STRICT_EXTENSION_DRIFT !== 'false') {
      console.error(
        '[check-drift] failing on absent-extension ledger rows (set STRICT_EXTENSION_DRIFT=false to tolerate a deliberate extension removal)',
      );
      process.exit(1);
    }

    const applied = new Set(ledgerVerifiable);
    const missing = expected.filter((f) => !applied.has(f));
    const extra = ledgerVerifiable.filter((f) => !expected.includes(f));

    if (missing.length === 0 && extra.length === 0) {
      console.log(
        `No drift detected — all ${expected.length} migration files match the breeze_migrations ledger.`,
      );
      console.log(
        '(Schema-vs-live-DB structural drift is covered by integration + RLS coverage tests, not by this script.)',
      );
      process.exit(0);
    }

    if (missing.length > 0) {
      console.error(`Drift detected — ${missing.length} migration file(s) on disk but not in ledger:`);
      for (const f of missing) console.error(`  + ${f}`);
    }
    if (extra.length > 0) {
      console.error(
        `Drift detected — ${extra.length} ledger entry(s) without a matching file on disk:`,
      );
      for (const f of extra) console.error(`  - ${f}`);
    }
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Drift check crashed:', err);
  process.exit(2);
});
