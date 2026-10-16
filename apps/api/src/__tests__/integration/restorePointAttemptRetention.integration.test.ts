/**
 * Real-PostgreSQL proof for the restore-point attempt retention job (#8581),
 * running as the unprivileged `breeze_app` role under forced RLS through the
 * job's own per-batch system contexts.
 *
 * Seeds every row shape the two sweeps must tell apart and asserts that
 * exactly the right rows are gone afterwards:
 *
 *   - orphaned `requested` rows (command terminal, command row gone, no
 *     command link) past the window       -> deleted
 *   - an old `requested` row whose command is still `sent`  -> kept
 *   - a fresh `requested` row                                -> kept
 *   - a terminal row past the window                         -> deleted
 *   - a terminal row inside the window                       -> kept
 *
 * and that a short retention window never deletes a `requested` row inside
 * the command-lifetime ceiling. The EXPLAIN case proves the orphan scan's
 * predicate is one `device_restore_point_attempts_pending_idx` can serve.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands } from '../../db/schema';
import {
  deviceRestorePointAttempts,
  type RestorePointAttemptStatus,
} from '../../db/schema/deviceRestorePointAttempts';
import { __testOnly, runRestorePointAttemptRetention } from '../../jobs/restorePointAttemptRetention';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

async function seedDevice(): Promise<{ orgId: string; deviceId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  return { orgId: org.id, deviceId: device.id };
}

async function insertCommand(deviceId: string, status: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(deviceCommands).values({
      deviceId,
      type: 'script',
      status,
      payload: {},
    }).returning({ id: deviceCommands.id });
    return row!.id;
  });
}

async function insertAttempt(
  t: { orgId: string; deviceId: string },
  opts: { status: RestorePointAttemptStatus; ageMs: number; deviceCommandId: string | null },
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(deviceRestorePointAttempts).values({
      requestId: randomUUID(),
      orgId: t.orgId,
      deviceId: t.deviceId,
      deviceCommandId: opts.deviceCommandId,
      trigger: 'script',
      status: opts.status,
      requestedAt: new Date(Date.now() - opts.ageMs),
    }).returning({ id: deviceRestorePointAttempts.id });
    return row!.id;
  });
}

async function remainingIds(ids: string[]): Promise<Set<string>> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: deviceRestorePointAttempts.id })
      .from(deviceRestorePointAttempts)
      .where(inArray(deviceRestorePointAttempts.id, ids)),
  );
  return new Set(rows.map((r) => r.id));
}

describe('restore-point attempt retention (real Postgres, breeze_app)', () => {
  runDb('deletes orphaned and old terminal rows, and nothing else', async () => {
    const t = await seedDevice();
    const doneCommand = await insertCommand(t.deviceId, 'completed');
    const liveCommand = await insertCommand(t.deviceId, 'sent');

    const old = 120 * DAY_MS;
    const orphanCommandDone = await insertAttempt(t, { status: 'requested', ageMs: old, deviceCommandId: doneCommand });
    const orphanUnlinked = await insertAttempt(t, { status: 'requested', ageMs: old, deviceCommandId: null });
    // Command row no longer exists at all (no FK on device_command_id).
    const orphanCommandGone = await insertAttempt(t, { status: 'requested', ageMs: old, deviceCommandId: randomUUID() });
    const oldButCommandLive = await insertAttempt(t, { status: 'requested', ageMs: old, deviceCommandId: liveCommand });
    const freshRequested = await insertAttempt(t, { status: 'requested', ageMs: HOUR_MS, deviceCommandId: doneCommand });
    const oldTerminal = await insertAttempt(t, { status: 'created', ageMs: old, deviceCommandId: doneCommand });
    const recentTerminal = await insertAttempt(t, { status: 'failed', ageMs: 10 * DAY_MS, deviceCommandId: doneCommand });
    const all = [
      orphanCommandDone, orphanUnlinked, orphanCommandGone, oldButCommandLive,
      freshRequested, oldTerminal, recentTerminal,
    ];

    // batchSize 1 drives several committed batches per sweep.
    const result = await runRestorePointAttemptRetention({ retentionDays: 90, batchSize: 1, maxBatches: 50 });

    expect(result.orphansDeleted).toBe(3);
    expect(result.terminalDeleted).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(await remainingIds(all)).toEqual(new Set([oldButCommandLive, freshRequested, recentTerminal]));

    // The job never touches the command rows themselves.
    const commands = await withSystemDbAccessContext(() =>
      db.select({ id: deviceCommands.id, status: deviceCommands.status })
        .from(deviceCommands)
        .where(inArray(deviceCommands.id, [doneCommand, liveCommand])),
    );
    expect(new Map(commands.map((c) => [c.id, c.status]))).toEqual(
      new Map([[doneCommand, 'completed'], [liveCommand, 'sent']]),
    );
  });

  runDb('a 1-day window still keeps requested rows inside the command-lifetime ceiling', async () => {
    const t = await seedDevice();
    const doneCommand = await insertCommand(t.deviceId, 'completed');
    // The `standard` delivery TTL is 7 days by default, + 1 day of execution.
    const insideCeiling = await insertAttempt(t, { status: 'requested', ageMs: 3 * DAY_MS, deviceCommandId: doneCommand });
    const unlinkedInsideCeiling = await insertAttempt(t, { status: 'requested', ageMs: 3 * DAY_MS, deviceCommandId: null });
    const pastCeiling = await insertAttempt(t, { status: 'requested', ageMs: 10 * DAY_MS, deviceCommandId: null });
    const terminalPastWindow = await insertAttempt(t, { status: 'busy', ageMs: 3 * DAY_MS, deviceCommandId: doneCommand });

    const result = await runRestorePointAttemptRetention({ retentionDays: 1 });

    expect(result.orphansDeleted).toBe(1);
    expect(result.terminalDeleted).toBe(1);
    expect(await remainingIds([insideCeiling, unlinkedInsideCeiling, pastCeiling, terminalPastWindow]))
      .toEqual(new Set([insideCeiling, unlinkedInsideCeiling]));
  });

  runDb('the orphan scan is servable by device_restore_point_attempts_pending_idx', async () => {
    const cutoff = new Date(Date.now() - 90 * DAY_MS).toISOString();
    const plan = await withSystemDbAccessContext(async () => {
      // An empty test table makes a sequential scan cheapest, which would
      // prove nothing; disabling it asks "can the partial index serve this
      // predicate?" -- it can only if the query implies status = 'requested'.
      await db.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = await db.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN ${__testOnly.orphanDeleteStatement(cutoff, 100)}`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    // The CANDIDATE subquery's own scan (alias `a`) must be the partial index,
    // with the requested_at bound as its index condition. Matching the bare
    // index name is not enough: the outer DELETE's `status = 'requested'`
    // recheck can use the same index even when the subquery cannot.
    expect(plan).toMatch(
      /Index Scan using device_restore_point_attempts_pending_idx on device_restore_point_attempts a\b[^\n]*\n\s+Index Cond: \(requested_at < /,
    );
  });
});
