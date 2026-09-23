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
 * (`extractDefinedFunctionNames`) and every constraint name it rewrites
 * (`extractTouchedConstraintNames` — ADD/DROP/ALTER/VALIDATE/RENAME
 * CONSTRAINT), then re-applies, in filename order, every LATER shipped
 * migration that also writes any of those names (`selectReplayFollowers`, all
 * in `../../db/autoMigrate.ts`) — bringing the database back to the state a
 * fresh migrate would leave it in.
 *
 * Constraints joined the closure in #6700: `pamActuationLifecycle` replays
 * `2026-09-16-pam-actuation-lifecycle.sql`, which drops and re-adds
 * `intent_outbox_event_type_check` with its 09-16 list. Tracking functions
 * alone left the CHECK narrowed for the rest of the process, so every later
 * suite inserting a newer event type (widened by
 * `2026-10-08-100300-intent-cancelled-outbox-event.sql` and
 * `2026-10-14-100300-ai-operator-intent-terminal-events.sql`) failed.
 *
 * Blind spot: a constraint rewritten under a runtime-built name
 * (`format('... ALTER CONSTRAINT %I ...', r.conname)`, e.g. the deferrable
 * conversion loop in `2026-09-12-100001-org-lifecycle-foundations.sql`) is
 * invisible to the text scan. A suite whose replayed file collides with one
 * must restore that state itself AFTER `replayMigration` returns (see
 * `partnerApiReconstructionWatermark`, #6701).
 *
 * `-- @no-transaction` files (`CREATE INDEX CONCURRENTLY` and friends) are
 * refused outright: this helper's single `db.execute(sql.raw(...))` call
 * cannot run one (Postgres rejects `CONCURRENTLY` inside a transaction), and
 * no shipped migration currently combines that directive with a function
 * definition anyway — extend this helper deliberately if that ever changes.
 */
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { discoverCoreMigrationFilenames, hasNoTransactionDirective, selectReplayFollowers } from '../../db/autoMigrate';
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
 * migration that redefines a function/procedure, or rewrites a constraint,
 * that `fileName` (or an already re-applied follower) itself touches.
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

  // Transitive closure, not a fixed set (#5788 shard-4 failure): a re-applied
  // later file may define functions the base file never mentioned (e.g.
  // 2026-10-14-100000-ai-operator-thin-slice.sql redefines BOTH
  // breeze_device_child_orgid_tables() AND breeze_cascade_device_org_id()).
  // Re-applying it rolls the second function back to that file's body, so
  // every later definer of THAT name must be re-applied too — otherwise the
  // 2026-10-16-182100 script_executions AI-pointer detach silently vanished
  // for the rest of the vitest process. The same holds for constraint names
  // (#6700). selectReplayFollowers walks that closure in one forward pass.
  const allFilenames = await discoverCoreMigrationFilenames();
  const baseIndex = allFilenames.indexOf(fileName);
  if (baseIndex === -1) {
    throw new Error(`replayMigration(${fileName}): not found under apps/api/migrations.`);
  }

  const laterFiles = await Promise.all(
    allFilenames.slice(baseIndex + 1).map(async (name) => ({ name, content: await readMigrationFile(name) })),
  );
  const contentByName = new Map(laterFiles.map((f) => [f.name, f.content]));
  for (const laterFile of selectReplayFollowers(baseContent, laterFiles)) {
    const laterContent = contentByName.get(laterFile)!;
    assertReplayable(laterFile, laterContent);
    await db.execute(sql.raw(laterContent));
  }
}
