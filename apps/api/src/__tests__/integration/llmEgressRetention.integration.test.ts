/**
 * `llm_egress_events` retention + daily rollup against real Postgres (#4120).
 *
 * The fold-and-prune statement is the whole contract and a mocked test can only
 * see its text, so the properties that matter are asserted here:
 *
 *  - a raw row past the window is deleted AND counted into its UTC day's rollup
 *    in the same statement (no window where raw is gone and the rollup is not);
 *  - rows inside the window are untouched;
 *  - a second run (or a day folded across several batches / runs) ADDS to the
 *    existing rollup row instead of overwriting it or double counting;
 *  - the rollup is bucketed by the UTC calendar day, regardless of session TZ.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { llmEgressEvents } from '../../db/schema/llmEgressEvents';
import { llmEgressDailyRollups } from '../../db/schema/llmEgressDailyRollups';
import { foldAndPruneLlmEgressEvents } from '../../jobs/llmEgressRetention';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 86_400_000;

async function seedOrg() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { orgId: org.id, partnerId: partner.id };
  });
}

async function insertEvent(
  t: { orgId: string; partnerId: string },
  createdAt: Date,
  opts: { host?: string; blocked?: boolean; surface?: 'sdk_proxy_connect' | 'one_shot_probe' } = {},
) {
  await withSystemDbAccessContext(() =>
    db.insert(llmEgressEvents).values({
      orgId: t.orgId,
      partnerId: t.partnerId,
      surface: opts.surface ?? 'sdk_proxy_connect',
      host: opts.host ?? 'api.provider.test',
      blocked: opts.blocked ?? false,
      createdAt,
    }),
  );
}

async function rollupsFor(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(llmEgressDailyRollups).where(eq(llmEgressDailyRollups.orgId, orgId)),
  );
}

async function rawCount(orgId: string) {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: llmEgressEvents.id }).from(llmEgressEvents).where(eq(llmEgressEvents.orgId, orgId)),
  );
  return rows.length;
}

describe('llm_egress_events fold-and-prune (#4120)', () => {
  runDb('folds expired raw rows into UTC-day rollups and deletes them; recent rows stay raw', async () => {
    const t = await seedOrg();
    const now = new Date('2026-12-26T12:00:00Z');
    const old = new Date('2026-09-01T23:30:00Z'); // >90d before `now`
    const oldNextDay = new Date('2026-09-02T00:15:00Z');
    const recent = new Date(now.getTime() - 5 * DAY);

    await insertEvent(t, old);
    await insertEvent(t, old, { blocked: true });
    await insertEvent(t, new Date(old.getTime() + 60_000));
    await insertEvent(t, old, { host: 'other.provider.test', surface: 'one_shot_probe' });
    await insertEvent(t, oldNextDay);
    await insertEvent(t, recent);

    const result = await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 1000, maxBatches: 5 });
    expect(result.folded).toBeGreaterThanOrEqual(5);
    expect(result.retentionDays).toBe(90);

    expect(await rawCount(t.orgId)).toBe(1); // only the recent row survives

    const rollups = await rollupsFor(t.orgId);
    const key = (r: (typeof rollups)[number]) => `${r.day}|${r.surface}|${r.host}`;
    const byKey = Object.fromEntries(rollups.map((r) => [key(r), r]));
    expect(Object.keys(byKey).sort()).toEqual([
      '2026-09-01|one_shot_probe|other.provider.test',
      '2026-09-01|sdk_proxy_connect|api.provider.test',
      '2026-09-02|sdk_proxy_connect|api.provider.test',
    ]);
    const main = byKey['2026-09-01|sdk_proxy_connect|api.provider.test']!;
    expect(main.requestCount).toBe(3);
    expect(main.blockedCount).toBe(1);
    expect(main.partnerId).toBe(t.partnerId);
    expect(main.firstEventAt.toISOString()).toBe(old.toISOString());
    expect(main.lastEventAt.toISOString()).toBe(new Date(old.getTime() + 60_000).toISOString());
    expect(byKey['2026-09-02|sdk_proxy_connect|api.provider.test']!.requestCount).toBe(1);
  });

  runDb('a day folded across several batches and runs accumulates instead of overwriting', async () => {
    const t = await seedOrg();
    const now = new Date('2026-12-26T12:00:00Z');
    const old = new Date('2026-08-10T10:00:00Z');
    for (let i = 0; i < 5; i += 1) await insertEvent(t, new Date(old.getTime() + i * 1000), { blocked: i === 4 });

    // Batch size 2, cap 2 → only 4 rows folded on the first run; backlog reported.
    const first = await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 2, maxBatches: 2 });
    expect(first.batches).toBe(2);

    // A late row for the same (already partly rolled-up) day arrives in a later run.
    await insertEvent(t, new Date(old.getTime() + 10_000));
    await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 2, maxBatches: 10 });
    // Idempotent: a further run with nothing to fold changes nothing.
    await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 2, maxBatches: 10 });

    expect(await rawCount(t.orgId)).toBe(0);
    const rollups = await rollupsFor(t.orgId);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.day).toBe('2026-08-10');
    expect(rollups[0]!.requestCount).toBe(6);
    expect(rollups[0]!.blockedCount).toBe(1);
    expect(rollups[0]!.firstEventAt.toISOString()).toBe(old.toISOString());
    expect(rollups[0]!.lastEventAt.toISOString()).toBe(new Date(old.getTime() + 10_000).toISOString());
  });

  runDb('orgs under different partners sharing a day/surface/host keep separate rollups with their own partner', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    expect(a.partnerId).not.toBe(b.partnerId);
    const now = new Date('2026-12-26T12:00:00Z');
    const old = new Date('2026-08-20T08:00:00Z');
    await insertEvent(a, old);
    await insertEvent(a, old, { blocked: true });
    await insertEvent(b, old);
    // One batch holds both orgs' rows for the same (day, surface, host).
    await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 1000, maxBatches: 5 });

    const [ra] = await rollupsFor(a.orgId);
    const [rb] = await rollupsFor(b.orgId);
    expect(ra).toMatchObject({ partnerId: a.partnerId, requestCount: 2, blockedCount: 1 });
    expect(rb).toMatchObject({ partnerId: b.partnerId, requestCount: 1, blockedCount: 0 });
  });

  runDb('the cutoff is exact: a row 1s past the window is folded, 1s inside it stays raw', async () => {
    const t = await seedOrg();
    const now = new Date('2026-12-26T12:00:00Z');
    const cutoff = new Date(now.getTime() - 90 * DAY);
    await insertEvent(t, new Date(cutoff.getTime() - 1000));
    await insertEvent(t, new Date(cutoff.getTime() + 1000));
    await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 1000, maxBatches: 5 });

    expect(await rawCount(t.orgId)).toBe(1);
    const rollups = await rollupsFor(t.orgId);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.requestCount).toBe(1);
  });

  runDb('rollup rows die with the org (composite FK cascade)', async () => {
    const t = await seedOrg();
    const now = new Date('2026-12-26T12:00:00Z');
    await insertEvent(t, new Date('2026-07-01T00:00:00Z'));
    await foldAndPruneLlmEgressEvents({ retentionDays: 90, now, batchSize: 100, maxBatches: 5 });
    expect(await rollupsFor(t.orgId)).toHaveLength(1);

    await withSystemDbAccessContext(async () => {
      const { organizations } = await import('../../db/schema');
      await db.delete(organizations).where(and(eq(organizations.id, t.orgId)));
    });
    expect(await rollupsFor(t.orgId)).toHaveLength(0);
  });
});
