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
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, webhooks, webhookDeliveries } from '../../db/schema';
import {
  STALE_PENDING_MS,
  buildRecoveryClaimCas,
  buildUnresolvedScope
} from '../../jobs/webhookDeliveryRecovery';
import {
  claimDeliveryForExecution,
  recordWebhookDelivery
} from '../../services/webhookDeliveryRecord';

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
    const webhookConfig = { id: webhookId, orgId: 'unused', name: 'n', url: 'u', events: [] };
    const event = {
      id: randomUUID(),
      type: 'alert.triggered',
      orgId: 'unused',
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
    const otherWebhookId = await seedWebhook();
    const sharedEventId = randomUUID();
    const event = {
      id: sharedEventId,
      type: 'alert.triggered',
      orgId: 'unused',
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
    const job = { id: deliveryId } as never;

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

    expect(await claimDeliveryForExecution({ id: deliveryId } as never))
      .toMatchObject({ claimed: false, observedStatus: 'delivered' });
  });

  it('the execution claim reports a MISSING row distinctly from a lost race', async () => {
    // A DLQ replay's minted id has no row at all. Collapsing that to the same
    // "duplicate" verdict as a lost race sends triage after a race that never
    // happened.
    expect(await claimDeliveryForExecution({ id: randomUUID() } as never))
      .toMatchObject({ claimed: false, observedStatus: null });
  });

  it('the partial index the sweep depends on exists and is partial', async () => {
    // The sweep ticks every five minutes forever and this table has no
    // retention job, so a full index (or none) would mean a growing scan.
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
});
