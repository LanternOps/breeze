/**
 * One-time global setup for the integration suite (vitest `globalSetup`).
 *
 * Runs ONCE per `vitest run` invocation, in its own Node context, before any
 * test-file worker starts. Migrations are applied here — hoisted out of
 * setup.ts's per-file `beforeAll` because re-running autoMigrate for every
 * one of 200+ test files cost ~1.1s each (~4 min of CI wall clock) in pure
 * no-op verification: re-reading and re-checksumming all 400+ migration
 * files against an unchanged ledger.
 *
 * The auto-seed inside autoMigrate (step 8) is intentionally NOT re-run per
 * file either: setup.ts's global `beforeEach` TRUNCATEs the core tables
 * before every single test, so rows seeded in a per-file beforeAll were
 * always gone by the time the first test ran. Test files own their fixtures.
 *
 * #3066 additions, in order, before autoMigrate runs:
 *  1. Cross-session run lock — a Postgres advisory lock on the target DB,
 *     held for the whole run (released by the returned teardown), so two
 *     sessions sharing one database serialize instead of TRUNCATE-clobbering
 *     each other. Per-worktree stacks (`pnpm test-stack up`) never contend.
 *  2. Ledger-drift guard — refuses to run when the DB's `breeze_migrations`
 *     ledger contains core migrations this checkout doesn't have, i.e. a
 *     shared DB polluted by another worktree's branch. That exact state made
 *     environment pollution look byte-identical to a repo defect in #3064.
 */
import './loadEnv';

import postgres from 'postgres';

import { autoMigrate, discoverCoreMigrationFilenames, MIGRATION_TABLE } from '../../db/autoMigrate';
import { assertTestDatabaseUrlSafe } from '../../testUtils/integrationDatabaseSafety';
import {
  acquireIntegrationRunLock,
  releaseIntegrationRunLock,
} from '../../testUtils/integrationRunLock';
import {
  LEDGER_DRIFT_BYPASS_ENV,
  findUnknownCoreLedgerEntries,
  formatLedgerDriftError,
} from '../../testUtils/migrationLedgerGuard';

function describeDbTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

async function assertLedgerMatchesCheckout(client: postgres.Sql, dbTarget: string): Promise<void> {
  const [{ exists }] = await client<[{ exists: boolean }]>`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${MIGRATION_TABLE}
    ) AS exists
  `;
  if (!exists) return; // fresh database — nothing applied yet

  const rows = await client.unsafe<{ filename: string }[]>(
    `SELECT filename FROM ${MIGRATION_TABLE}`,
  );
  const unknown = findUnknownCoreLedgerEntries(
    rows.map((row) => row.filename),
    await discoverCoreMigrationFilenames(),
  );
  if (unknown.length === 0) return;

  const message = formatLedgerDriftError(unknown, dbTarget);
  if (process.env[LEDGER_DRIFT_BYPASS_ENV]) {
    console.warn(`[integration global-setup] ${LEDGER_DRIFT_BYPASS_ENV} set — proceeding despite ledger drift:\n${message}`);
    return;
  }
  throw new Error(message);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL ?? '';

  // Fail loud if either URL points at anything other than a known test DB —
  // autoMigrate would otherwise happily run DDL against it. setup.ts repeats
  // this guard before opening its own pools; guard here too so the very first
  // connection of the run is already covered.
  assertTestDatabaseUrlSafe(databaseUrl, 'globalSetup');
  assertTestDatabaseUrlSafe(
    process.env.DATABASE_URL_APP ?? '',
    'globalSetup (DATABASE_URL_APP)',
  );

  const dbTarget = describeDbTarget(databaseUrl);
  // max: 1 — advisory locks are session-scoped, so the lock must live on one
  // pinned connection, held open for the entire run and closed in teardown.
  const lockClient = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await acquireIntegrationRunLock(lockClient, dbTarget);
    await assertLedgerMatchesCheckout(lockClient, dbTarget);
    console.log('[integration global-setup] Running migrations (once per run)...');
    await autoMigrate();
    console.log('[integration global-setup] Database ready for testing');
  } catch (error) {
    await lockClient.end({ timeout: 5 }).catch(() => {});
    throw error;
  }

  return async () => {
    try {
      await releaseIntegrationRunLock(lockClient);
    } finally {
      await lockClient.end({ timeout: 5 });
    }
  };
}
