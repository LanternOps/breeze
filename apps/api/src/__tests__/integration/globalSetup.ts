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
 */
import './loadEnv';

import { autoMigrate } from '../../db/autoMigrate';
import { assertTestDatabaseUrlSafe } from '../../testUtils/integrationDatabaseSafety';

export default async function globalSetup(): Promise<void> {
  // Fail loud if either URL points at anything other than a known test DB —
  // autoMigrate would otherwise happily run DDL against it. setup.ts repeats
  // this guard before opening its own pools; guard here too so the very first
  // connection of the run is already covered.
  assertTestDatabaseUrlSafe(process.env.DATABASE_URL ?? '', 'globalSetup');
  assertTestDatabaseUrlSafe(
    process.env.DATABASE_URL_APP ?? '',
    'globalSetup (DATABASE_URL_APP)',
  );

  console.log('[integration global-setup] Running migrations (once per run)...');
  await autoMigrate();
  console.log('[integration global-setup] Database ready for testing');
}
