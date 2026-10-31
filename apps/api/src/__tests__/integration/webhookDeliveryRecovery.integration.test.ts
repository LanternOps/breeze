/**
 * #4095, against real Postgres: prove the recovery predicates actually select
 * and actually serialise.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The sweep is pinned by a mock-based unit suite and by compiled-SQL assertions
 * (`jobs/webhookDeliveryRecovery.sql.test.ts`), and neither can prove the two
 * things that decide whether this fix works in production:
 *
 *   1. that `next_retry_at IS NULL OR next_retry_at <= now` really matches a
 *      never-leased row. This repo has shipped a compiled-SQL assertion that
 *      was *correct* while only real Postgres caught the bug — `NOT (...)` over
 *      a nullable column silently dropping exactly the rows a sweep existed to
 *      find. Every orphan starts with `next_retry_at IS NULL`, so if that arm
 *      does not match, the sweep recovers NOTHING and #4095 is simply back.
 *
 *   2. that the claim CAS serialises. Two API instances sweep the same table on
 *      the same schedule; if both claims can win, the customer's endpoint is
 *      POSTed once per instance. That is a property of Postgres's concurrent
 *      UPDATE recheck, not of our SQL text, and a mock cannot exhibit it.
 *
 * The migration's partial index is also asserted to EXIST here, because the
 * sweep's cost argument depends on it and nothing else in CI checks it.
 *
 * FIXTURES ARE PER-TEST. The shared integration setup TRUNCATEs the core tenant
 * tables in a global `beforeEach`.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, webhooks, webhookDeliveries } from '../../db/schema';
import {
  MAX_RECOVERABLE_AGE_MS,
  STALE_PENDING_MS,
  runWebhookDeliveryRecoverySweep,
  buildRecoveryClaimCas,
  buildUnresolvedScope
} from '../../jobs/webhookDeliveryRecovery';
import {
  claimDeliveryForExecution,
  recordDeliveryOutcome,
  recordWebhookDelivery
} from '../../services/webhookDeliveryRecord';

import { closeWebhookDeliveryQueue, getWebhookDeliveryQueue, webhookAttemptJobId } from '../../jobs/webhookDeliveryQueue';
import { closeRedis } from '../../services/redis';

const recoveryJobIds: string[] = [];
afterAll(async () => {
  const queue = getWebhookDeliveryQueue();
  for (const id of recoveryJobIds) await (await queue.getJob(id))?.remove();
  await closeWebhookDeliveryQueue();
  await closeRedis();
});

const NOW = new Date('2026-09-11T12:00:00.000Z');
/** Comfortably past the staleness cut-off. */
const AGED = new Date(NOW.getTime() - STALE_PENDING_MS - 60_000);

async function seedWebhook(): Promise<string> {
  const sfx = randomUUID().slice(0, 8);
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `Recovery Partner ${sfx}`, slug: `recovery-${sfx}` })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId: partner!.id,
        name: 'Recovery Org',
        slug: `recovery-org-${sfx}`
      })
      .returning({ id: organizations.id });
    const [webhook] = await db
      .insert(webhooks)
      .values({
        orgId: org!.id,
        name: 'Recovery Hook',
        url: 'https://example.test/hook',
        events: ['alert.triggered']
      })
      .returning({ id: webhooks.id });
    return webhook!.id;
  });
}

async function insertDelivery(
  webhookId: string,
  overrides: Partial<typeof webhookDeliveries.$inferInsert> = {}
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId,
        eventType: 'alert.triggered',
        eventId: randomUUID(),
        payload: {},
        status: 'pending',
        createdAt: AGED,
        ...overrides
      })
      .returning({ id: webhookDeliveries.id });
    return row!.id;
  });
}

const scan = (webhookId: string) =>
  withSystemDbAccessContext(() =>
    db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookId, webhookId), buildUnresolvedScope(NOW)))
  );

describe('webhook delivery recovery against real Postgres', () => {
  let webhookId: string;

  beforeEach(async () => {
    webhookId = await seedWebhook();
  });

  it('selects the never-leased orphan — the NULL arm is not dropped', async () => {
    const orphanId = await insertDelivery(webhookId); // next_retry_at IS NULL

    const rows = await scan(webhookId);

    // If `or(isNull(...), lte(...))` were ever written as a negation, this row
    // would vanish and the sweep would recover nothing at all.
    expect(rows.map((r) => r.id)).toEqual([orphanId]);
  });

  it('ignores rows that are fresh, leased, or already resolved', async () => {
    await insertDelivery(webhookId, { createdAt: NOW }); // too fresh
    await insertDelivery(webhookId, {
      nextRetryAt: new Date(NOW.getTime() + 60_000)     // leased by someone else
    });
    await insertDelivery(webhookId, { status: 'delivered' });
    await insertDelivery(webhookId, { status: 'failed' });
    const orphanId = await insertDelivery(webhookId);

    const rows = await scan(webhookId);

    // Terminal rows especially: re-driving a `delivered` row would POST to the
    // customer's endpoint a second time for an event they already received.
    expect(rows.map((r) => r.id)).toEqual([orphanId]);
  });

  it('picks up a `retrying` row whose execution lease has expired', async () => {
    const abandonedId = await insertDelivery(webhookId, {
      status: 'retrying',
      nextRetryAt: new Date(NOW.getTime() - 1_000) // lease expired
    });

    const rows = await scan(webhookId);

    expect(rows.map((r) => r.id)).toEqual([abandonedId]);
  });

  it('the claim CAS lets exactly ONE concurrent sweeper win', async () => {
    const orphanId = await insertDelivery(webhookId);
    const lease = new Date(NOW.getTime() + 15 * 60_000);

    const claim = () =>
      withSystemDbAccessContext(() =>
        db
          .update(webhookDeliveries)
          .set({ recoveryAttempts: 1, nextRetryAt: lease })
          .where(buildRecoveryClaimCas(orphanId, NOW))
          .returning({ id: webhookDeliveries.id })
      );

    // Two instances racing on the same row. Postgres rechecks the predicate
    // after the first UPDATE commits, so the loser matches nothing.
    const [a, b] = await Promise.all([claim(), claim()]);

    expect(a.length + b.length).toBe(1);

    // And the winner's lease removes the row from the candidate set, so the
    // NEXT tick cannot re-queue it either.
    expect(await scan(webhookId)).toEqual([]);
  });

  it('a second claim after the lease is taken matches nothing', async () => {
    const orphanId = await insertDelivery(webhookId);
    const lease = new Date(NOW.getTime() + 15 * 60_000);

    await withSystemDbAccessContext(() =>
      db
        .update(webhookDeliveries)
        .set({ recoveryAttempts: 1, nextRetryAt: lease })
        .where(buildRecoveryClaimCas(orphanId, NOW))
        .returning({ id: webhookDeliveries.id })
    );

    const second = await withSystemDbAccessContext(() =>
      db
        .update(webhookDeliveries)
        .set({ recoveryAttempts: 99 })
        .where(buildRecoveryClaimCas(orphanId, NOW))
        .returning({ id: webhookDeliveries.id })
    );

    expect(second).toEqual([]);
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select({ recoveryAttempts: webhookDeliveries.recoveryAttempts })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, orphanId))
    );
    expect(row!.recoveryAttempts).toBe(1);
  });

  it('records a delivery, and on the second attempt reports the row that won', async () => {
    const [webhookConfig] = await withSystemDbAccessContext(() => db.select().from(webhooks).where(eq(webhooks.id, webhookId)));
    const event = {
      id: randomUUID(),
      type: 'alert.triggered',
      orgId: webhookConfig!.orgId,
      source: 'test',
      priority: 'normal',
      payload: { a: 1 },
      metadata: { timestamp: new Date().toISOString() }
    };

    const first = await recordWebhookDelivery(webhookConfig as never, event as never);
    const second = await recordWebhookDelivery(webhookConfig as never, event as never);

    expect(first.created).toBe(true);
    // The read-back is the whole point of the new contract: without it the skip
    // has nothing to report and #4095's silent `continue` is back.
    expect(second.created).toBe(false);
    expect(second.created === false && second.existing?.id)
      .toBe(first.created === true ? first.deliveryId : undefined);
    expect(second.created === false && second.existing?.status).toBe('pending');
  });

  it('the read-back does not confuse a SIBLING webhook’s delivery for this one', async () => {
    // One event fans out to every subscribed webhook, so `event_id` alone is
    // not unique. A read-back keyed only on event_id would report the sibling's
    // status as this webhook's.
    const [webhookConfig] = await withSystemDbAccessContext(() => db.select().from(webhooks).where(eq(webhooks.id, webhookId)));
    const [sibling] = await withSystemDbAccessContext(() => db.insert(webhooks).values({
      orgId: webhookConfig!.orgId, name: 'Sibling', url: 'https://example.test/sibling', events: ['alert.triggered'],
    }).returning());
    const otherWebhookId = sibling!.id;
    const sharedEventId = randomUUID();
    const event = {
      id: sharedEventId,
      type: 'alert.triggered',
      orgId: webhookConfig!.orgId,
      source: 'test',
      priority: 'normal',
      payload: {},
      metadata: { timestamp: new Date().toISOString() }
    };

    const mine = await recordWebhookDelivery({ id: webhookId } as never, event as never);
    const theirs = await recordWebhookDelivery({ id: otherWebhookId } as never, event as never);

    // Both must WIN their insert — the unique index is (webhook_id, event_id),
    // so the same event legitimately gets one row per webhook.
    expect(mine.created).toBe(true);
    expect(theirs.created).toBe(true);
    const myId = mine.created === true ? mine.deliveryId : null;
    const theirId = theirs.created === true ? theirs.deliveryId : null;
    expect(myId).not.toBe(theirId);

    // Now force the READ-BACK, which the two winning inserts above never reach.
    // With a sibling row present under the SAME event_id, a lookup keyed only
    // on event_id could return either row — and Postgres is free to hand back
    // the sibling's. It must name THIS webhook's delivery.
    const again = await recordWebhookDelivery({ id: webhookId } as never, event as never);

    expect(again.created).toBe(false);
    expect(again.created === false && again.existing?.id).toBe(myId);
    expect(again.created === false && again.existing?.id).not.toBe(theirId);
  });

  it('the execution claim lets exactly ONE popped copy of a job deliver', async () => {
    const deliveryId = await insertDelivery(webhookId);
    const job = { deliveryId, attemptsMade: 0 };

    // Two copies of the same job, popped by two workers at once. If both won,
    // the customer's endpoint would be POSTed twice for one event.
    const [a, b] = await Promise.all([
      claimDeliveryForExecution(job),
      claimDeliveryForExecution(job)
    ]);

    expect([a, b].filter((r) => r.claimed)).toHaveLength(1);
    // The loser must be able to say WHY: the winner moved the row to
    // `retrying`, which is "already claimed", not "no row" or "already done".
    const loser = [a, b].find((r) => !r.claimed);
    expect(loser).toMatchObject({ claimed: false, observedStatus: 'retrying' });

    const [row] = await withSystemDbAccessContext(() =>
      db
        .select({ status: webhookDeliveries.status, nextRetryAt: webhookDeliveries.nextRetryAt })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
    );
    // The winner moved it out of `pending`, which is also what removes it from
    // the recovery sweep's candidate set.
    expect(row!.status).toBe('retrying');
    expect(row!.nextRetryAt).not.toBeNull();
  });

  it('the execution claim refuses a row that has already resolved', async () => {
    const deliveryId = await insertDelivery(webhookId, { status: 'delivered' });

    expect(await claimDeliveryForExecution({ deliveryId, attemptsMade: 0 }))
      .toMatchObject({ claimed: false, observedStatus: 'delivered' });
  });

  it('the execution claim reports a MISSING row distinctly from a lost race', async () => {
    // An erased delivery has no row at all. Collapsing that to the same
    // "duplicate" verdict as a lost race sends triage after a race that never
    // happened.
    expect(await claimDeliveryForExecution({ deliveryId: randomUUID(), attemptsMade: 0 }))
      .toMatchObject({ claimed: false, observedStatus: null });
  });

  it('claims due scheduled attempts with a DB-clock delay and ignores pending recovery leases', async () => {
    const now = new Date();
    const futureId = await insertDelivery(webhookId, { status: 'scheduled', attempts: 2, nextRetryAt: new Date(now.getTime() + 600_000) });
    const future = await claimDeliveryForExecution({ deliveryId: futureId, attemptsMade: 2 });
    expect(future).toMatchObject({ claimed: false, observedStatus: 'scheduled', observedAttempts: 2 });
    if (!future.claimed) {
      expect(future.dueInMs).toBeGreaterThan(0);
      expect(future.dueInMs).toBeLessThanOrEqual(600_000);
    }
    const dueId = await insertDelivery(webhookId, { status: 'scheduled', attempts: 2, nextRetryAt: new Date(now.getTime() - 60_000) });
    expect(await claimDeliveryForExecution({ deliveryId: dueId, attemptsMade: 1 })).toMatchObject({ claimed: false, observedAttempts: 2 });
    expect(await claimDeliveryForExecution({ deliveryId: dueId, attemptsMade: 2 })).toMatchObject({ claimed: true });
    const [due] = await withSystemDbAccessContext(() => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, dueId)));
    expect(due!.status).toBe('retrying');
    const pendingId = await insertDelivery(webhookId, { nextRetryAt: new Date(now.getTime() + 900_000) });
    expect(await claimDeliveryForExecution({ deliveryId: pendingId, attemptsMade: 0 })).toMatchObject({ claimed: true });
  });

  it('lets exactly one concurrent claim win for a due scheduled attempt', async () => {
    const deliveryId = await insertDelivery(webhookId, { status: 'scheduled', attempts: 3, nextRetryAt: new Date(Date.now() - 60_000) });
    const outcomes = await Promise.all([0, 1].map(() => claimDeliveryForExecution({ deliveryId, attemptsMade: 3 })));
    expect(outcomes.filter(outcome => outcome.claimed)).toHaveLength(1);
  });

  it('a past-due scheduled row is re-driven exactly once with its recorded generation', async () => {
    const now = new Date();
    const dueId = await insertDelivery(webhookId, { status: 'scheduled', attempts: 2, webhookGeneration: 1, createdAt: now, nextRetryAt: new Date(now.getTime() - 20 * 60_000) });
    const futureId = await insertDelivery(webhookId, { status: 'scheduled', attempts: 2, createdAt: now, nextRetryAt: new Date(now.getTime() + 600_000) });
    await withSystemDbAccessContext(() => db.update(webhooks).set({ approvalGeneration: 2 }).where(eq(webhooks.id, webhookId)));
    const jobId = webhookAttemptJobId(dueId, 2);
    recoveryJobIds.push(jobId, webhookAttemptJobId(futureId, 2));
    await Promise.all([runWebhookDeliveryRecoverySweep(now), runWebhookDeliveryRecoverySweep(now)]);
    const queue = getWebhookDeliveryQueue();
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    expect(jobs.filter(job => job.id === jobId)).toHaveLength(1);
    expect(await queue.getJob(webhookAttemptJobId(futureId, 2))).toBeUndefined();
    expect((await queue.getJob(jobId))!.data).toMatchObject({ deliveryId: dueId, webhookId, generation: 1, attemptsMade: 2 });
    await (await queue.getJob(jobId))!.remove();
  });

  // #9946: failure_count counts failed DELIVERIES. A failed attempt that
  // scheduled a retry is not counted, so when recovery abandons that delivery
  // the terminal write must count it, or the stuck delivery vanishes from the count.
  it('a delivery that fails attempt 1 and is then abandoned as too old counts as ONE failed delivery', async () => {
    const failureCount = async () => (await withSystemDbAccessContext(() =>
      db.select({ n: webhooks.failureCount, last: webhooks.lastDeliveryAt }).from(webhooks).where(eq(webhooks.id, webhookId))))[0]!;
    const deliveryId = await insertDelivery(webhookId, {
      status: 'retrying', attempts: 0, createdAt: new Date(NOW.getTime() - MAX_RECOVERABLE_AGE_MS - 60_000)
    });
    expect(await recordDeliveryOutcome({
      deliveryId, webhookId, eventId: 'event-9946', eventType: 'alert.triggered', success: false, attempts: 1,
      responseStatus: 500, nextAttemptAt: new Date(NOW.getTime() - 60 * 60_000)
    })).toBe(true);
    const afterAttempt = await failureCount();
    expect(afterAttempt.n).toBe(0);

    const summary = await runWebhookDeliveryRecoverySweep(NOW);
    expect(summary).toMatchObject({ scheduledTooOld: 1, scheduledTerminalWriteLost: 0 });
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: webhookDeliveries.status }).from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)));
    expect(row!.status).toBe('failed');
    const afterAbandon = await failureCount();
    expect(afterAbandon.n).toBe(1);
    // No attempt was made by the sweep, so "Last Triggered" stays put.
    expect(afterAbandon.last).toEqual(afterAttempt.last);

    // A second sweep finds nothing to resolve and counts nothing.
    await runWebhookDeliveryRecoverySweep(NOW);
    expect((await failureCount()).n).toBe(1);
  });

  it('the partial index the sweep depends on exists and is partial', async () => {
    // The sweep ticks every five minutes; only pending/retrying rows belong
    // in its lease index. Scheduled rows have their own due-time index.
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'webhook_deliveries'
          AND indexname = 'webhook_deliveries_unresolved_idx'
      `)
    );

    const defs = (rows as unknown as Array<{ indexdef: string }>);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.indexdef).toMatch(/WHERE/i);
    expect(defs[0]!.indexdef).toMatch(/pending/);
    expect(defs[0]!.indexdef).toMatch(/retrying/);
  });
  it('the scheduled due index is partial and ordered by the next attempt time', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'webhook_deliveries'
        AND indexname = 'webhook_deliveries_scheduled_due_idx'
    `));
    const defs = rows as unknown as Array<{ indexdef: string }>;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.indexdef).toMatch(/\(next_retry_at\)/i);
    expect(defs[0]!.indexdef).toMatch(/WHERE.*'scheduled'/i);
  });

});
