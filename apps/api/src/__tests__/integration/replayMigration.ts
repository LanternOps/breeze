/**
 * Replay a shipped migration file by path — as several integration suites do
 * today to prove idempotency of a trigger/guard/backfill migration — while
 * keeping the database in the same state a fresh `autoMigrate` run produces.
 *
 * THE TRAP this exists to close (#3205 W07 / PR #4838): `autoMigrate` applies
 * every migration file exactly once, in filename order, on a fresh database.
 * When migration A defines a SQL function and a LATER migration B redefines
 * it (`CREATE OR REPLACE FUNCTION`), a fresh database ends up with B's body.
 * A test suite that replays A alone, by path
 * (`readFile(new URL('../../../migrations/A.sql', import.meta.url))` +
 * `db.execute(sql.raw(...))`), reverts the function to A's body for the rest
 * of that vitest process — silently breaking any LATER suite in the same
 * shard whose assertions depend on B's behavior. That is exactly what
 * happened in CI shard 4 of PR #4838:
 * `pamDeviceMoveGuard.integration.test.ts` replays
 * `2026-09-17-pam-device-move-guard.sql` (which (re)defines
 * `breeze_device_child_orgid_tables()`) to prove that migration is a
 * privilege-grant no-op on re-apply. That wiped out the
 * `invoice_line_devices` exclusion added by the LATER
 * `2026-10-08-101300-device-move-exclude-billing-evidence.sql`, so
 * `billingEvidenceDeviceMove.integration.test.ts` — running afterward in the
 * same shard — saw the exclusion gone and 500'd on
 * `invoice_line_devices_line_org_fk` for the rest of the run.
 *
 * `replayMigration` closes this generically: after executing the named file,
 * it finds every function/procedure name that file (re)defines
 * (`extractDefinedFunctionNames`, `../../db/autoMigrate.ts`), then re-applies,
 * in filename order, every LATER shipped migration that also (re)defines any
 * of those names — bringing the database back to the state a fresh migrate
 * would leave it in.
 *
 * `-- @no-transaction` files (`CREATE INDEX CONCURRENTLY` and friends) are
 * refused outright: this helper's single `db.execute(sql.raw(...))` call
 * cannot run one (Postgres rejects `CONCURRENTLY` inside a transaction), and
 * no shipped migration currently combines that directive with a function
 * definition anyway — extend this helper deliberately if that ever changes.
 */
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { discoverCoreMigrationFilenames, extractDefinedFunctionNames, hasNoTransactionDirective } from '../../db/autoMigrate';
import { getTestDb } from './setup';

async function readMigrationFile(fileName: string): Promise<string> {
  return readFile(new URL(`../../../migrations/${fileName}`, import.meta.url), 'utf8');
}

function assertReplayable(fileName: string, content: string): void {
  if (hasNoTransactionDirective(content)) {
    throw new Error(
      `replayMigration(${fileName}): this file carries "-- @no-transaction" — ` +
        `CREATE INDEX CONCURRENTLY and friends cannot run inside replayMigration's ` +
        `single db.execute(sql.raw(...)) call. Replay it manually instead.`,
    );
  }
}

/**
 * Replay `fileName` (a bare filename under `apps/api/migrations/`) against
 * the current integration test database, then re-apply every later shipped
 * migration that redefines a function/procedure `fileName` itself defines.
 *
 * Must be called from inside a suite that already imports `./setup` (real
 * Postgres connection via `getTestDb()`), same as every other file that
 * replays a migration by path today.
 */
export async function replayMigration(fileName: string): Promise<void> {
  const db = getTestDb();
  const baseContent = await readMigrationFile(fileName);
  assertReplayable(fileName, baseContent);
  await db.execute(sql.raw(baseContent));

  const baseDefines = extractDefinedFunctionNames(baseContent);
  if (baseDefines.length === 0) return;

  const allFilenames = await discoverCoreMigrationFilenames();
  const baseIndex = allFilenames.indexOf(fileName);
  if (baseIndex === -1) {
    throw new Error(`replayMigration(${fileName}): not found under apps/api/migrations.`);
  }

  for (const laterFile of allFilenames.slice(baseIndex + 1)) {
    const laterContent = await readMigrationFile(laterFile);
    const laterDefines = extractDefinedFunctionNames(laterContent);
    if (!laterDefines.some((name) => baseDefines.includes(name))) continue;
    assertReplayable(laterFile, laterContent);
    await db.execute(sql.raw(laterContent));
  }
}
