/**
 * Real-Postgres integration coverage for the #2775 live-bootstrap-token
 * exemption in the nightly enrollment-key purge sweep
 * (enrollmentKeyCleanup.ts's `hasNoLiveUnexhaustedBootstrapToken`).
 *
 * The mocked unit suite (enrollmentKeyCleanup.test.ts) can only assert the
 * SHAPE of the generated SQL — it stubs `db.delete/select` entirely, so
 * `returningMock`'s resolved value is whatever the test tells it to be,
 * independent of the actual predicate. It cannot prove Postgres itself
 * EVALUATES the correlated NOT EXISTS subquery correctly per row, and the
 * failure mode if it doesn't is silent: an admin's 30-day/1-year bootstrap
 * token gets hard-deleted out from under them when its transient 60-minute
 * parent key ages past the purge cutoff (or, the opposite bug, an
 * exhausted/expired-token key never gets swept and the table grows
 * unbounded).
 *
 * This suite drives the REAL delete-worker processor (only BullMQ's
 * Queue/Worker classes are mocked — the same "capture the processor, invoke
 * it directly" pattern as quoteSendQueue.integration.test.ts) against real
 * rows in the test Postgres, covering all four required cases:
 *   (a) live, unexhausted token            -> key SURVIVES the sweep
 *   (b) token itself expired                -> key is DELETED
 *   (c) token fully consumed (>= max_usage) -> key is DELETED
 *   (d) no bootstrap tokens at all          -> key is DELETED (regression
 *       guard on the pre-existing behaviour)
 */
import '../__tests__/integration/setup';

import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Mock ONLY BullMQ's Queue/Worker classes and the redis connection helper —
// this test is about whether Postgres evaluates the DELETE...WHERE predicate
// correctly, not about BullMQ scheduling mechanics (already covered by the
// mocked unit suite). No BullMQ Worker/Queue is ever started or connects to
// Redis; the processor closure passed to `new Worker(...)` is captured here
// and invoked directly, exactly the payload a real job fire would deliver.
const capturedProcessor: { current: null | ((job: unknown) => Promise<unknown>) } = {
  current: null,
};

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn();
    close = vi.fn(async () => {});
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedProcessor.current = processor;
    }
    on = vi.fn();
    close = vi.fn(async () => {});
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({})),
  isBullMQAvailable: vi.fn(() => true),
  closeRedis: vi.fn(async () => {}),
}));

import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, installerBootstrapTokens, organizations, partners, sites } from '../db/schema';
import { createEnrollmentKeyCleanupWorker } from './enrollmentKeyCleanup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function createFixture(unique: string) {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({
        name: `Cleanup Partner ${unique}`,
        slug: `cleanup-partner-${unique}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
      })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        partnerId: partner!.id,
        name: `Cleanup Org ${unique}`,
        slug: `cleanup-org-${unique}`,
        type: 'customer',
        status: 'active',
      })
      .returning({ id: organizations.id });
    const [site] = await db
      .insert(sites)
      .values({ orgId: org!.id, name: `Cleanup Site ${unique}` })
      .returning({ id: sites.id });
    return { partnerId: partner!.id, orgId: org!.id, siteId: site!.id };
  });
}

async function cleanupFixture(ids: { partnerId: string; orgId: string; siteId: string }) {
  await withSystemDbAccessContext(async () => {
    // enrollment_keys may already be gone (the sweep deleted it) — deleting
    // by org_id is safe either way, and cascades any surviving bootstrap
    // token row via ON DELETE CASCADE.
    await db.delete(enrollmentKeys).where(eq(enrollmentKeys.orgId, ids.orgId));
    await db.delete(sites).where(eq(sites.id, ids.siteId));
    await db.delete(organizations).where(eq(organizations.id, ids.orgId));
    await db.delete(partners).where(eq(partners.id, ids.partnerId));
  });
}

async function runSweep() {
  createEnrollmentKeyCleanupWorker();
  expect(capturedProcessor.current).toBeTypeOf('function');
  return capturedProcessor.current!({ name: 'enrollment-key-cleanup', id: 'test' });
}

async function keyRowExists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ id: enrollmentKeys.id }).from(enrollmentKeys).where(eq(enrollmentKeys.id, id));
    return !!row;
  });
}

async function tokenRowExists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: installerBootstrapTokens.id })
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.id, id));
    return !!row;
  });
}

// The default purge grace period is 7 days (DEFAULT_PURGE_AFTER_DAYS). Every
// scenario below creates a key that expired 10 days ago — comfortably past
// that cutoff, so the ONLY thing that can save it from the sweep is the
// live-bootstrap-token exemption.
const EXPIRED_PAST_CUTOFF = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

describe('enrollment-key cleanup sweep — live bootstrap token exemption (#2775, real Postgres)', () => {
  runDb('(a) an expired key holding a live, unexhausted bootstrap token SURVIVES the sweep', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      const { keyId, tokenId } = await withSystemDbAccessContext(async () => {
        const [key] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: ids.orgId,
            siteId: ids.siteId,
            name: 'transient parent',
            key: `sweep-a-key-${unique}`,
            expiresAt: EXPIRED_PAST_CUTOFF,
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });
        const [token] = await db
          .insert(installerBootstrapTokens)
          .values({
            token: `sweep-a-token-${unique}`,
            orgId: ids.orgId,
            parentEnrollmentKeyId: key!.id,
            siteId: ids.siteId,
            maxUsage: 25,
            consumedCount: 0,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // live: 1 day out
          })
          .returning({ id: installerBootstrapTokens.id });
        return { keyId: key!.id, tokenId: token!.id };
      });

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(true);
      expect(await tokenRowExists(tokenId)).toBe(true);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(b) an expired key whose token has itself expired is DELETED — liveness is a strict now() boundary', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      const { keyId } = await withSystemDbAccessContext(async () => {
        const [key] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: ids.orgId,
            siteId: ids.siteId,
            name: 'transient parent',
            key: `sweep-b-key-${unique}`,
            expiresAt: EXPIRED_PAST_CUTOFF,
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });
        await db.insert(installerBootstrapTokens).values({
          token: `sweep-b-token-${unique}`,
          orgId: ids.orgId,
          parentEnrollmentKeyId: key!.id,
          siteId: ids.siteId,
          maxUsage: 25,
          consumedCount: 0,
          // expires_at must be strictly after created_at (DB CHECK
          // installer_bootstrap_tokens_expires_after_created) — backdate
          // both so the token is unambiguously expired-in-the-past.
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          expiresAt: new Date(Date.now() - 10 * 60 * 1000),
        });
        return { keyId: key!.id };
      });

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(false);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(c) an expired key whose token is fully consumed (consumed_count >= max_usage) is DELETED', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      const { keyId } = await withSystemDbAccessContext(async () => {
        const [key] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: ids.orgId,
            siteId: ids.siteId,
            name: 'transient parent',
            key: `sweep-c-key-${unique}`,
            expiresAt: EXPIRED_PAST_CUTOFF,
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });
        await db.insert(installerBootstrapTokens).values({
          token: `sweep-c-token-${unique}`,
          orgId: ids.orgId,
          parentEnrollmentKeyId: key!.id,
          siteId: ids.siteId,
          maxUsage: 5,
          consumedCount: 5, // fully exhausted — still "live" by expiry, but not unexhausted
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        return { keyId: key!.id };
      });

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(false);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(d) an expired key with no bootstrap tokens at all is DELETED — pre-existing behaviour is unchanged', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      const { keyId } = await withSystemDbAccessContext(async () => {
        const [key] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: ids.orgId,
            siteId: ids.siteId,
            name: 'no tokens ever issued',
            key: `sweep-d-key-${unique}`,
            expiresAt: EXPIRED_PAST_CUTOFF,
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });
        return { keyId: key!.id };
      });

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(false);
    } finally {
      await cleanupFixture(ids);
    }
  });
});
