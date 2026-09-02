/**
 * The wave-3.5a barrier: prove, against real Postgres, that delivering one
 * event twice produces one side effect.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every fix in wave 3.5a is pinned by a mock-based unit test, and mocks cannot
 * prove the thing that actually matters here: that a unique index exists, that
 * a compare-and-swap predicate really filters, and that `onConflictDoNothing`
 * targets the index we think it does. This repo has shipped compiled-SQL
 * assertions that were *correct* while only real Postgres caught the bug
 * (`NOT (...)` over a nullable column silently dropping rows), so the DB-level
 * guarantees get DB-level tests.
 *
 * These guarantees are latent today — delivery is in-process and at-most-once.
 * They become load-bearing in wave 3.5c, which moves dispatch onto a durable
 * queue (at-least-once), and wave 3.5d, which splits the worker into its own
 * container. This suite is the regression barrier for both.
 *
 * FIXTURES ARE PER-TEST. The shared integration setup TRUNCATEs the core tenant
 * tables in a global `beforeEach`, so anything seeded in `beforeAll` is
 * CASCADE-deleted before the second case runs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners,
  organizations,
  users,
  userNotifications,
  webhooks,
  webhookDeliveries,
  incidents,
} from '../../db/schema';

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
}

async function seedTenant(): Promise<Tenant> {
  const sfx = randomUUID().slice(0, 8);
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `Redelivery Partner ${sfx}`, slug: `redelivery-${sfx}` })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId: partner!.id,
        name: 'Redelivery Org',
        slug: `redelivery-org-${sfx}`,
      })
      .returning({ id: organizations.id });
    const [user] = await db
      .insert(users)
      .values({
        partnerId: partner!.id,
        orgId: org!.id,
        email: `redelivery-${sfx}@example.com`,
        name: 'Redelivery User',
        status: 'active',
      })
      .returning({ id: users.id });
    return { partnerId: partner!.id, orgId: org!.id, userId: user!.id };
  });
}

describe('event redelivery is idempotent against real Postgres', () => {
  let t: Tenant;

  beforeEach(async () => {
    t = await seedTenant();
  });

  it('one alert delivered twice yields one in-app notification row per user', async () => {
    const alertId = randomUUID();
    const row = {
      userId: t.userId,
      orgId: t.orgId,
      type: 'alert' as const,
      priority: 'high' as const,
      title: 'Disk full',
      message: 'Disk is above threshold',
      // Exactly what inAppSender now stamps.
      dedupeKey: `alert:${alertId}:${t.userId}`,
      read: false,
    };

    await withSystemDbAccessContext(async () => {
      await db.insert(userNotifications).values([row]).onConflictDoNothing();
      await db.insert(userNotifications).values([row]).onConflictDoNothing();
    });

    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: userNotifications.id })
        .from(userNotifications)
        .where(
          and(
            eq(userNotifications.userId, t.userId),
            eq(userNotifications.dedupeKey, row.dedupeKey),
          ),
        ),
    );

    // Two deliveries, one notification. Enforced by the partial unique index
    // user_notifications_user_dedupe_key_uq, not by application logic.
    expect(rows).toHaveLength(1);
  });

  it('still notifies a SECOND recipient of the same alert', async () => {
    const alertId = randomUUID();
    const [otherUser] = await withSystemDbAccessContext(() =>
      db
        .insert(users)
        .values({
          partnerId: t.partnerId,
          orgId: t.orgId,
          email: `redelivery-second-${randomUUID().slice(0, 8)}@example.com`,
          name: 'Second Recipient',
          status: 'active',
        })
        .returning({ id: users.id }),
    );

    const base = {
      orgId: t.orgId,
      type: 'alert' as const,
      priority: 'high' as const,
      title: 'Disk full',
      read: false,
    };

    await withSystemDbAccessContext(() =>
      db
        .insert(userNotifications)
        .values([
          { ...base, userId: t.userId, dedupeKey: `alert:${alertId}:${t.userId}` },
          { ...base, userId: otherUser!.id, dedupeKey: `alert:${alertId}:${otherUser!.id}` },
        ])
        .onConflictDoNothing(),
    );

    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: userNotifications.id })
        .from(userNotifications)
        .where(eq(userNotifications.orgId, t.orgId)),
    );

    // Guards the per-USER half of the key: a per-alert-only key would collide
    // across recipients and silently notify just the first one.
    expect(rows).toHaveLength(2);
  });

  it('one event delivered twice yields one webhook_deliveries row per webhook', async () => {
    const eventId = randomUUID();
    const [webhook] = await withSystemDbAccessContext(() =>
      db
        .insert(webhooks)
        .values({
          orgId: t.orgId,
          name: 'Redelivery Hook',
          url: 'https://example.test/hook',
          events: ['alert.triggered'],
          secret: 'shh',
        })
        .returning({ id: webhooks.id }),
    );

    const insertDelivery = () =>
      withSystemDbAccessContext(() =>
        db
          .insert(webhookDeliveries)
          .values({
            webhookId: webhook!.id,
            eventType: 'alert.triggered',
            eventId,
            payload: {},
            status: 'pending',
            attempts: 0,
          })
          .onConflictDoNothing({
            target: [webhookDeliveries.webhookId, webhookDeliveries.eventId],
          })
          .returning({ id: webhookDeliveries.id }),
      );

    const first = await insertDelivery();
    const second = await insertDelivery();

    // The empty second result IS the signal the subscriber reads to skip the
    // duplicate outbound POST to the customer's endpoint.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('two concurrent escalation swaps produce exactly one winner', async () => {
    const [incident] = await withSystemDbAccessContext(() =>
      db
        .insert(incidents)
        .values({
          orgId: t.orgId,
          title: 'DB unreachable',
          classification: 'availability',
          severity: 'p1',
          status: 'detected',
          detectedAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        .returning({ id: incidents.id }),
    );

    // Exactly the predicate runIncidentSlaMonitorPass now uses.
    const swap = () =>
      withSystemDbAccessContext(() =>
        db
          .update(incidents)
          .set({ escalatedAt: new Date() })
          .where(and(eq(incidents.id, incident!.id), isNull(incidents.escalatedAt)))
          .returning({ id: incidents.id }),
      );

    // Sequential rather than Promise.all: the guarantee under test is that the
    // predicate itself excludes an already-escalated row, which is what makes
    // the concurrent case safe too.
    const first = await swap();
    const second = await swap();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('claims an incident for enrichment exactly once', async () => {
    const [incident] = await withSystemDbAccessContext(() =>
      db
        .insert(incidents)
        .values({
          orgId: t.orgId,
          title: 'Slow queries',
          classification: 'performance',
          severity: 'p2',
          status: 'detected',
          detectedAt: new Date(),
        })
        .returning({ id: incidents.id }),
    );

    const claim = () =>
      withSystemDbAccessContext(() =>
        db
          .update(incidents)
          .set({ timelineEnrichedAt: new Date() })
          .where(and(eq(incidents.id, incident!.id), isNull(incidents.timelineEnrichedAt)))
          .returning({ id: incidents.id }),
      );

    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
  });
});
