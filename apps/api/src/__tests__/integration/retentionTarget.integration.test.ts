/**
 * #4342 W0 — the report/enforce retention runner against real Postgres,
 * through the production `db` pool (the unprivileged `breeze_app` role, forced
 * RLS). A batch that forgot to elect system scope matches zero rows here and
 * fails these tests, and a target spanning two orgs proves system scope sees
 * every tenant.
 *
 * The targets below are TEST FIXTURES over existing tables (`ticket_outbox`,
 * `device_commands`). W0 registers no production target: nothing here runs on
 * a schedule.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray, sql } from 'drizzle-orm';

import { deviceCommands, ticketOutbox, tickets } from '../../db/schema';
import { utcWallTime } from '../../jobs/retentionBatch';
import { runRetentionTarget, type RetentionKnobs, type RetentionTarget } from '../../jobs/retentionTarget';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const OPTS = { logPrefix: '[RetentionTargetIT]', label: 'retentionTarget.it', enforceVar: 'TEST_RETENTION_ENFORCE', now: NOW };

/** Fixture predicate: delivered outbox rows older than the window. timestamptz column. */
const OUTBOX_DELETE: RetentionTarget = {
  metricName: 'ticket_outbox_retention',
  table: 'ticket_outbox',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`published_at IS NOT NULL AND published_at < ${cutoffIso}::timestamptz`,
};

/** Fixture scrub: blank the payload of old delivered rows; excludes rows already scrubbed. */
const OUTBOX_SCRUB: RetentionTarget = {
  metricName: 'ticket_outbox_retention',
  table: 'ticket_outbox',
  action: { kind: 'scrub', set: sql`payload = '{"_scrubbed": true}'::jsonb` },
  where: (cutoffIso) => sql`published_at IS NOT NULL AND published_at < ${cutoffIso}::timestamptz
    AND payload->>'_scrubbed' IS NULL`,
};

/** Fixture over a `timestamp WITHOUT time zone` column, compared as UTC wall time. */
const COMMANDS_DELETE: RetentionTarget = {
  metricName: 'webhook_delivery_retention',
  table: 'device_commands',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`status IN ('completed', 'failed') AND created_at < ${utcWallTime(cutoffIso)}`,
};

const knobs = (overrides: Partial<RetentionKnobs> = {}): RetentionKnobs => ({
  retentionDays: 30, batchSize: 100, maxBatches: 10, enforce: false, ...overrides,
});

let seq = 0;
async function seedOrg(): Promise<{ orgId: string; ticketId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seq += 1;
  const [ticket] = await getTestDb().insert(tickets).values({
    orgId: org.id, ticketNumber: `RET-W0-${Date.now()}-${seq}`, subject: 'retention runner fixture',
  }).returning({ id: tickets.id });
  return { orgId: org.id, ticketId: ticket!.id };
}

async function insertOutbox(orgId: string, ticketId: string, publishedAt: Date | null, n = 1): Promise<number[]> {
  const rows = await getTestDb().insert(ticketOutbox).values(
    Array.from({ length: n }, () => ({
      orgId, ticketId, eventType: 'ticket.created' as const, payload: { body: 'secret' },
      createdAt: publishedAt ?? NOW, publishedAt,
    })),
  ).returning({ id: ticketOutbox.id });
  return rows.map((r) => r.id);
}

async function survivingOutboxIds(ids: number[]): Promise<number[]> {
  const rows = await getTestDb().select({ id: ticketOutbox.id }).from(ticketOutbox).where(inArray(ticketOutbox.id, ids));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

describe('runRetentionTarget (real Postgres, breeze_app pool)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('report mode counts exactly the predicate rows across every org and deletes nothing', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const oldA = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 3);
    const oldB = await insertOutbox(b.orgId, b.ticketId, daysAgo(45), 2);
    const recent = await insertOutbox(a.orgId, a.ticketId, daysAgo(5), 2);
    const undelivered = await insertOutbox(b.orgId, b.ticketId, null, 2);
    const all = [...oldA, ...oldB, ...recent, ...undelivered];

    const result = await runRetentionTarget(OUTBOX_DELETE, knobs({ enforce: false }), OPTS);

    expect(result).toMatchObject({ mode: 'report', table: 'ticket_outbox', eligible: 5, eligibleCapped: false });
    expect(await survivingOutboxIds(all)).toEqual([...all].sort((x, y) => x - y));
  });

  it('report count is bounded at batchSize * maxBatches and flags the cap', async () => {
    const a = await seedOrg();
    await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 7);

    const result = await runRetentionTarget(OUTBOX_DELETE, knobs({ batchSize: 2, maxBatches: 2 }), OPTS);

    expect(result).toMatchObject({ mode: 'report', eligible: 4, eligibleCapped: true });
  });

  it('enforce deletes exactly the rows report counted, across orgs, and keeps the rest', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const oldA = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 3);
    const oldB = await insertOutbox(b.orgId, b.ticketId, daysAgo(45), 2);
    const keep = [
      ...(await insertOutbox(a.orgId, a.ticketId, daysAgo(5), 2)),
      ...(await insertOutbox(b.orgId, b.ticketId, null, 2)),
    ];

    const report = await runRetentionTarget(OUTBOX_DELETE, knobs({ enforce: false }), OPTS);
    const enforce = await runRetentionTarget(OUTBOX_DELETE, knobs({ enforce: true, batchSize: 2 }), OPTS);

    expect(report).toMatchObject({ mode: 'report', eligible: 5 });
    // 5 rows at batch size 2: 2 + 2 + 1, stopping on the short batch.
    expect(enforce).toMatchObject({ mode: 'enforce', affected: 5, batches: 3, hasMore: false });
    expect(await survivingOutboxIds([...oldA, ...oldB, ...keep])).toEqual([...keep].sort((x, y) => x - y));
  });

  it('enforce stops on the batch cap, reports the backlog, and the next run drains it', async () => {
    const a = await seedOrg();
    const old = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 7);

    const first = await runRetentionTarget(OUTBOX_DELETE, knobs({ enforce: true, batchSize: 2, maxBatches: 2 }), OPTS);
    expect(first).toMatchObject({ mode: 'enforce', affected: 4, batches: 2, hasMore: true });
    expect(await survivingOutboxIds(old)).toHaveLength(3);

    const second = await runRetentionTarget(OUTBOX_DELETE, knobs({ enforce: true, batchSize: 2, maxBatches: 2 }), OPTS);
    expect(second).toMatchObject({ mode: 'enforce', affected: 3, batches: 2, hasMore: false });
    expect(await survivingOutboxIds(old)).toEqual([]);
  });

  it('enforce scrub rewrites only eligible rows and a second run touches nothing', async () => {
    const a = await seedOrg();
    const old = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 3);
    const recent = await insertOutbox(a.orgId, a.ticketId, daysAgo(5), 1);

    const first = await runRetentionTarget(OUTBOX_SCRUB, knobs({ enforce: true, batchSize: 2 }), OPTS);
    expect(first).toMatchObject({ mode: 'enforce', affected: 3, hasMore: false });

    const rows = await getTestDb().select({ id: ticketOutbox.id, payload: ticketOutbox.payload })
      .from(ticketOutbox).where(inArray(ticketOutbox.id, [...old, ...recent]));
    for (const row of rows) {
      expect(row.payload).toEqual(old.includes(row.id) ? { _scrubbed: true } : { body: 'secret' });
    }

    // The predicate excludes scrubbed rows, so the sweep terminates instead of
    // re-selecting them every batch.
    const second = await runRetentionTarget(OUTBOX_SCRUB, knobs({ enforce: true, batchSize: 2 }), OPTS);
    expect(second).toMatchObject({ mode: 'enforce', affected: 0, batches: 1, hasMore: false });
    expect(await runRetentionTarget(OUTBOX_SCRUB, knobs(), OPTS)).toMatchObject({ mode: 'report', eligible: 0 });
  });

  it('a failing batch rejects once and leaves every row in place', async () => {
    const a = await seedOrg();
    const old = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 3);
    const broken: RetentionTarget = {
      ...OUTBOX_DELETE,
      where: (cutoffIso) => sql`published_at < ${cutoffIso}::timestamptz AND no_such_column = 1`,
    };

    await expect(runRetentionTarget(broken, knobs({ enforce: true }), OPTS)).rejects.toThrow();
    expect(await survivingOutboxIds(old)).toHaveLength(3);
  });

  // Negative control: proves the rows above were reachable only because each
  // batch elected system scope, not because the pool bypasses RLS.
  it('the same rows are invisible to a contextless breeze_app statement', async () => {
    const a = await seedOrg();
    const old = await insertOutbox(a.orgId, a.ticketId, daysAgo(60), 2);

    const visible = await getAppDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ticket_outbox WHERE id IN (${sql.join(old.map((id) => sql`${id}`), sql`, `)})
    `);
    expect(visible[0]?.n).toBe(0);
    expect(await survivingOutboxIds(old)).toHaveLength(2);
  });

  // Review Focus 5, discriminating: under a non-UTC session TimeZone the naive
  // comparison of a tz-less UTC value against `::timestamptz` flips, and
  // utcWallTime does not. The naive control proves the session TZ took effect.
  it('utcWallTime keeps a tz-less comparison correct under a non-UTC session TimeZone', async () => {
    const cutoffIso = '2026-06-01T12:00:00.000Z';
    const out = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`);
      const [row] = await tx.execute<{ before_wall: boolean; after_wall: boolean; before_naive: boolean }>(sql`
        SELECT
          (TIMESTAMP '2026-06-01 11:00:00' < ${utcWallTime(cutoffIso)}) AS before_wall,
          (TIMESTAMP '2026-06-01 13:00:00' < ${utcWallTime(cutoffIso)}) AS after_wall,
          (TIMESTAMP '2026-06-01 11:00:00' < ${cutoffIso}::timestamptz) AS before_naive
      `);
      return row!;
    });
    expect(out.before_wall).toBe(true);
    expect(out.after_wall).toBe(false);
    // Read as New York local time, 11:00 is 15:00 UTC: after the cutoff.
    expect(out.before_naive).toBe(false);
  });

  it('compares a timestamp-without-time-zone column against the UTC wall-time cutoff', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site.id });

    // Store UTC wall time explicitly, an hour either side of the 30-day cutoff.
    const cutoffMs = NOW.getTime() - 30 * DAY_MS;
    const rows = await getTestDb().execute<{ id: string; status: string }>(sql`
      INSERT INTO device_commands (id, device_id, type, status, created_at) VALUES
        (${randomUUID()}, ${device.id}, 'script', 'completed', (${new Date(cutoffMs - 3_600_000).toISOString()}::timestamptz AT TIME ZONE 'UTC')),
        (${randomUUID()}, ${device.id}, 'script', 'failed',    (${new Date(cutoffMs + 3_600_000).toISOString()}::timestamptz AT TIME ZONE 'UTC')),
        (${randomUUID()}, ${device.id}, 'script', 'pending',   (${new Date(cutoffMs - 90 * DAY_MS).toISOString()}::timestamptz AT TIME ZONE 'UTC'))
      RETURNING id, status
    `);
    const ids = rows.map((r) => r.id);
    const idOf = (status: string) => rows.find((r) => r.status === status)!.id;

    const report = await runRetentionTarget(COMMANDS_DELETE, knobs(), OPTS);
    expect(report).toMatchObject({ mode: 'report', eligible: 1 });

    await runRetentionTarget(COMMANDS_DELETE, knobs({ enforce: true }), OPTS);
    const left = await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands).where(inArray(deviceCommands.id, ids));
    expect(left.map((r) => r.id).sort()).toEqual([idOf('failed'), idOf('pending')].sort());
  });
});
