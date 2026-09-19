/**
 * Real-Postgres + real-Redis/BullMQ integration coverage for the wave-3.5c
 * (#4085) durable event-dispatch pipeline: `enqueueRouteEvent` (ingress) +
 * `eventDispatchProcessor` (route-event / deliver-event processing, the
 * `event_delivery_receipts` state machine).
 *
 * The mocked unit suites (`services/eventDispatchQueue.test.ts`,
 * `jobs/eventDispatchWorker.test.ts`) stub BullMQ and drizzle wholesale, so
 * they can assert the SHAPE of what gets enqueued/written but cannot prove:
 *   1. A real BullMQ Worker actually drains a real-Redis route-event job into
 *      a real deliver-event job, and the deliver-event job actually reaches
 *      the registered subscriber's handler with the ORIGINAL event.
 *   2. The claim CAS in `claimReceipt` genuinely dedupes against a real
 *      Postgres row — the post-retention dedupe BullMQ's own
 *      retention/removeOnComplete cannot give on its own.
 *   3. Real BullMQ retry/backoff actually drives the receipt through
 *      delivering -> delivered (or -> failed) with `attempts` reflecting the
 *      real number of claims.
 *   4. `event_delivery_receipts` RLS (shape 1, direct org_id) actually
 *      rejects a cross-org forge under the real `breeze_app` role.
 *
 * Each case below is written as a POSITIVE assertion plus, where the brief
 * calls for it, a paired NEGATIVE CONTROL in the same file that flips the
 * one variable the positive case depends on and shows the opposite outcome
 * — that pairing is how "proven red first" is established without editing
 * shipped source: if the code under test regressed, the positive case's
 * assertion is exactly what the negative control shows CAN differ, so the
 * positive assertion is not vacuous.
 *
 * Run (standard rig):
 *   pnpm test-stack up --force   # or: docker compose -f docker-compose.test.yml up -d
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/eventDispatchQueue.integration.test.ts
 *
 * If the shared rig's migration ledger is contaminated by another worktree
 * (checksum mismatch on boot), fall back to private ephemeral containers
 * (sized tmpfs — same recipe as authEmailWorker.integration.test.ts):
 *   docker run -d --name breeze-pg-task12 -e POSTGRES_USER=breeze_test \
 *     -e POSTGRES_PASSWORD=breeze_test -e POSTGRES_DB=breeze_test -p 55434:5432 \
 *     --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:16-alpine
 *   docker run -d --name breeze-redis-task12 -p 56382:6379 redis:7-alpine
 *   cd apps/api && \
 *   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:55434/breeze_test \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:55434/breeze_test \
 *   REDIS_URL=redis://localhost:56382 \
 *   npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/eventDispatchQueue.integration.test.ts
 */
import './setup';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { eventDeliveryReceipts } from '../../db/schema';
import { closeRedis } from '../../services/redis';
import {
  getEventDispatchQueue,
  shutdownEventDispatchQueue,
} from '../../services/eventDispatchQueue';
import { createEventDispatchWorker } from '../../jobs/eventDispatchWorker';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { publishEvent } from '../../services/eventBus';
import type { BreezeEvent, EventType } from '../../services/eventBus';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const EVENT_TYPE: EventType = 'device.online';
// One of the five canonical EVENT_SUBSCRIBER_IDS (services/eventSubscriberIds.ts).
const SUB_ID = 'webhook-delivery';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  return { partner: partner!, org: org! };
}

function makeEvent(orgId: string, overrides: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: randomUUID(),
    type: EVENT_TYPE,
    orgId,
    source: 'integration-test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: new Date().toISOString() },
    ...overrides,
  };
}

async function readReceipt(eventId: string, subscriberId: string) {
  const [row] = await getTestDb()
    .select()
    .from(eventDeliveryReceipts)
    .where(
      and(
        eq(eventDeliveryReceipts.eventId, eventId),
        eq(eventDeliveryReceipts.subscriberId, subscriberId),
      ),
    );
  return row;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  opts: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${opts.label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Resolves when the given jobId's job TERMINALLY settles: 'completed', or
 * 'failed' with no retries left (`job.attemptsMade >= job.opts.attempts`).
 * A 'failed' event for an attempt that WILL still retry is deliberately
 * ignored — otherwise case 3's "throws twice then succeeds" would resolve on
 * the first synthetic failure instead of waiting for the eventual success.
 */
function waitForJobOutcome(
  worker: Worker,
  jobId: string,
  timeoutMs = 15_000,
): Promise<'completed' | 'failed'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`job ${jobId} did not terminally settle within ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      worker.off('completed', onCompleted);
      worker.off('failed', onFailed);
    }
    function onCompleted(job: Job): void {
      if (job.id !== jobId) return;
      cleanup();
      resolve('completed');
    }
    function onFailed(job: Job | undefined): void {
      if (!job || job.id !== jobId) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!exhausted) return; // will retry — not terminal yet
      cleanup();
      resolve('failed');
    }
    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);
  });
}

beforeEach(() => {
  _resetEventSubscriberRegistryForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetEventSubscriberRegistryForTests();
});

afterAll(async () => {
  await shutdownEventDispatchQueue();
  // Quit the shared BullMQ/ioredis singleton so vitest can exit; every
  // Worker/Queue in this file rides the same shared connection.
  await closeRedis();
});

describe('eventDispatchQueue + eventDispatchWorker — real Postgres + Redis (#4085)', () => {
  describe('case 1: enforce end-to-end', () => {
    it('handler runs via the QUEUE (not locally) exactly once, with the ORIGINAL event id; receipt reaches delivered', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', SUB_ID);

      const { org } = await seedOrg();
      const handlerCalls: BreezeEvent[] = [];
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async (event) => {
          handlerCalls.push(event);
        },
      });

      const eventId = await publishEvent(EVENT_TYPE, org.id, { probe: true }, 'integration-test');

      // Local delivery (invokeLocalHandlers) runs SYNCHRONOUSLY inside
      // publish() before it resolves. Zero calls here is the "did NOT run
      // locally" half of the exactly-one-of invariant.
      expect(handlerCalls).toHaveLength(0);

      const worker = createEventDispatchWorker();
      try {
        await waitForJobOutcome(worker, `event-deliver-${SUB_ID}-${eventId}`);
      } finally {
        await worker.close();
      }

      expect(handlerCalls).toHaveLength(1);
      expect(handlerCalls[0]!.id).toBe(eventId);

      const receipt = await readReceipt(eventId, SUB_ID);
      expect(receipt?.status).toBe('delivered');
      expect(receipt?.mode).toBe('enforce');
    });

    it('[sensitivity control] same mode, subscriber OMITTED from the csv: it runs LOCALLY instead and no receipt is ever planned', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', ''); // nobody routed to the queue

      const { org } = await seedOrg();
      const handlerCalls: BreezeEvent[] = [];
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async (event) => {
          handlerCalls.push(event);
        },
      });

      const eventId = await publishEvent(EVENT_TYPE, org.id, { probe: true }, 'integration-test');

      // Ran locally, synchronously. This is the control that PROVES the
      // assertions in the positive case above actually discriminate the
      // routing decision: if the enforce local/queue split were broken (e.g.
      // always-local regardless of the csv), THIS assertion — not the
      // positive case's — is what would catch it, because the positive
      // case's own "handlerCalls === 0 right after publish()" check would
      // then also fail there, but only because both paths collapsed into
      // one and only this control isolates which one.
      expect(handlerCalls).toHaveLength(1);
      expect(handlerCalls[0]!.id).toBe(eventId);

      const worker = createEventDispatchWorker();
      try {
        // Wait for the route-event job's OWN terminal outcome (not just "the
        // queue looks empty") — enqueueRouteEvent swallows every enqueue
        // failure by design (see its docstring), so a queue-count check alone
        // would pass just as vacuously if the job were never enqueued at all.
        const outcome = await waitForJobOutcome(worker, `event-route-${eventId}`);
        expect(outcome).toBe('completed');
      } finally {
        await worker.close();
      }

      expect(await readReceipt(eventId, SUB_ID)).toBeUndefined();
    });
  });

  describe('case 2: receipt idempotent skip', () => {
    it('a pre-existing delivered receipt short-circuits the handler on a manually-enqueued deliver-event job', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      const { org } = await seedOrg();
      const event = makeEvent(org.id);

      let calls = 0;
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async () => {
          calls += 1;
        },
      });

      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(eventDeliveryReceipts).values({
          eventId: event.id,
          subscriberId: SUB_ID,
          orgId: org.id,
          eventType: event.type,
          mode: 'enforce',
          status: 'delivered',
          deliveredAt: new Date(),
        }),
      );

      const jobId = `event-deliver-${SUB_ID}-${event.id}`;
      const worker = createEventDispatchWorker();
      try {
        await getEventDispatchQueue().add('deliver-event', { v: 1, subscriberId: SUB_ID, event }, { jobId });
        const outcome = await waitForJobOutcome(worker, jobId);
        expect(outcome).toBe('completed'); // processDeliverEvent returns normally on the skip path
      } finally {
        await worker.close();
      }

      // The dedupe BullMQ retention alone cannot provide: the handler was
      // NEVER invoked for an event/subscriber pair already marked delivered.
      expect(calls).toBe(0);
      const receipt = await readReceipt(event.id, SUB_ID);
      expect(receipt?.status).toBe('delivered');
      // attempts stayed at the pre-seeded 0 — claimReceipt's CAS never even
      // matched the row (status was already 'delivered'), so no claim
      // happened. Without this, a schema-parse failure that drops the job
      // before it ever reaches claimReceipt (see the sibling comment on
      // eventDispatchProcessor) would satisfy every assertion above too.
      expect(receipt?.attempts).toBe(0);
    });

    it('[sensitivity control] the SAME job shape with NO pre-existing receipt: the handler DOES fire', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      const { org } = await seedOrg();
      const event = makeEvent(org.id);

      let calls = 0;
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async () => {
          calls += 1;
        },
      });

      const jobId = `event-deliver-${SUB_ID}-${event.id}`;
      const worker = createEventDispatchWorker();
      try {
        await getEventDispatchQueue().add('deliver-event', { v: 1, subscriberId: SUB_ID, event }, { jobId });
        const outcome = await waitForJobOutcome(worker, jobId);
        expect(outcome).toBe('completed');
      } finally {
        await worker.close();
      }

      // Proves case 2's "calls === 0" assertion is discriminating: absent
      // the pre-existing receipt, the identical job DOES invoke the handler.
      expect(calls).toBe(1);
      const receipt = await readReceipt(event.id, SUB_ID);
      expect(receipt?.status).toBe('delivered');
    });
  });

  describe('case 3: failure -> retry -> receipt outcome', () => {
    it('a handler that throws twice then succeeds ends delivered, with attempts reflecting all three claims', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', SUB_ID);
      const { org } = await seedOrg();

      let calls = 0;
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async () => {
          calls += 1;
          if (calls < 3) throw new Error(`synthetic failure #${calls}`);
        },
        retry: { attempts: 3, backoffMs: 10 },
      });

      const eventId = await publishEvent(EVENT_TYPE, org.id, {}, 'integration-test');
      const jobId = `event-deliver-${SUB_ID}-${eventId}`;
      const worker = createEventDispatchWorker();
      try {
        const outcome = await waitForJobOutcome(worker, jobId, 20_000);
        expect(outcome).toBe('completed');
      } finally {
        await worker.close();
      }

      expect(calls).toBe(3);
      const receipt = await readReceipt(eventId, SUB_ID);
      expect(receipt?.status).toBe('delivered');
      expect(receipt?.attempts).toBe(3);
    });

    it('a handler that always throws exhausts retries and ends failed with last_error populated', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', SUB_ID);
      const { org } = await seedOrg();

      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async () => {
          throw new Error('synthetic always-fails');
        },
        retry: { attempts: 2, backoffMs: 10 },
      });

      const eventId = await publishEvent(EVENT_TYPE, org.id, {}, 'integration-test');
      const jobId = `event-deliver-${SUB_ID}-${eventId}`;
      const worker = createEventDispatchWorker();
      try {
        const outcome = await waitForJobOutcome(worker, jobId, 20_000);
        expect(outcome).toBe('failed');
      } finally {
        await worker.close();
      }

      const receipt = await readReceipt(eventId, SUB_ID);
      expect(receipt?.status).toBe('failed');
      expect(receipt?.attempts).toBe(2);
      expect(receipt?.lastError).toContain('synthetic always-fails');
    });
  });

  describe('case 4: shadow mode', () => {
    it('writes receipts (mode=shadow, status=planned), enqueues NO deliver jobs, and the local handler DID run', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const { org } = await seedOrg();

      let localCalls = 0;
      registerEventSubscriber({
        id: SUB_ID,
        eventTypes: '*',
        handler: async () => {
          localCalls += 1;
        },
      });

      const eventId = await publishEvent(EVENT_TYPE, org.id, {}, 'integration-test');

      // partitionSubscribersForEvent only splits local/queue in 'enforce' —
      // in shadow mode every matched subscriber is ALSO invoked locally
      // (the dark-launch dual path), and that already happened synchronously.
      expect(localCalls).toBe(1);

      const worker = createEventDispatchWorker();
      try {
        await waitFor(
          async () => (await readReceipt(eventId, SUB_ID))?.status === 'planned',
          { label: 'shadow receipt reaches planned' },
        );
        await waitFor(
          async () => {
            const counts = await getEventDispatchQueue().getJobCounts('waiting', 'active', 'delayed');
            return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
          },
          { label: 'route-event job drains with no follow-on deliver job' },
        );
      } finally {
        await worker.close();
      }

      const receipt = await readReceipt(eventId, SUB_ID);
      expect(receipt?.mode).toBe('shadow');
      expect(receipt?.status).toBe('planned');

      const allJobs = await getEventDispatchQueue().getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ]);
      expect(allJobs.filter((job) => job.name === 'deliver-event')).toHaveLength(0);
      expect(localCalls).toBe(1);
    });
  });

  describe('case 5: RLS forge — event_delivery_receipts is org-isolated', () => {
    it('org B reads zero rows of org A receipts and cannot forge an insert stamped with org A (42501); org A sees its own row', async () => {
      const { org: orgA } = await seedOrg();
      const { org: orgB } = await seedOrg();

      const eventId = randomUUID();
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(eventDeliveryReceipts).values({
          eventId,
          subscriberId: SUB_ID,
          orgId: orgA.id,
          eventType: EVENT_TYPE,
          mode: 'enforce',
          status: 'planned',
        }),
      );

      // Negative: org B's own context cannot see org A's row at all.
      const rowsForB = await withDbAccessContext(orgContext(orgB.id), () =>
        db.select().from(eventDeliveryReceipts).where(eq(eventDeliveryReceipts.eventId, eventId)),
      );
      expect(rowsForB).toHaveLength(0);

      // Negative: org B cannot forge an insert stamped with org A's id.
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(orgB.id), () =>
            db.insert(eventDeliveryReceipts).values({
              eventId: randomUUID(),
              subscriberId: SUB_ID,
              orgId: orgA.id,
              eventType: EVENT_TYPE,
              mode: 'enforce',
              status: 'planned',
            }),
          ),
        '42501',
      );

      // Positive control: org A's OWN context sees the row it created — the
      // zero-row result above is RLS filtering, not a broken fixture.
      const rowsForA = await withDbAccessContext(orgContext(orgA.id), () =>
        db.select().from(eventDeliveryReceipts).where(eq(eventDeliveryReceipts.eventId, eventId)),
      );
      expect(rowsForA).toHaveLength(1);
    });
  });
});
