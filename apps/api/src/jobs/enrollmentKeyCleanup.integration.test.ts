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
 *
 * Cases (e)-(g) pin the `deployment_invites` cascade lifetime (#2821). That
 * issue asked whether invites need the same exemption bootstrap tokens got.
 * They do NOT, and these tests are what makes that answer durable rather than
 * a one-time reading of the code — see the describe block's own comment for
 * the invariant and for the two ways a future change could break it.
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
import {
  deploymentInvites,
  enrollmentKeys,
  installerBootstrapTokens,
  organizations,
  partners,
  sites,
} from '../db/schema';
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

async function inviteRowExists(id: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: deploymentInvites.id })
      .from(deploymentInvites)
      .where(eq(deploymentInvites.id, id));
    return !!row;
  });
}

/**
 * Seed an `enrollment_keys` row with the given expiry plus a
 * `deployment_invites` row cascading off it — the exact pair the MCP tool
 * `send_deployment_invites` creates (mintChildEnrollmentKey -> insert invite
 * referencing that key's id).
 */
async function createInviteFixture(
  ids: { partnerId: string; orgId: string; siteId: string },
  unique: string,
  expiresAt: Date,
): Promise<{ keyId: string; inviteId: string }> {
  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: ids.orgId,
        siteId: ids.siteId,
        name: `mcp-invite invitee-${unique}@example.com`,
        key: `sweep-inv-key-${unique}`,
        shortCode: unique.slice(-10),
        expiresAt,
        maxUsage: 1,
      })
      .returning({ id: enrollmentKeys.id });
    const [invite] = await db
      .insert(deploymentInvites)
      .values({
        partnerId: ids.partnerId,
        orgId: ids.orgId,
        enrollmentKeyId: key!.id,
        invitedEmail: `invitee-${unique}@example.com`,
        status: 'sent',
      })
      .returning({ id: deploymentInvites.id });
    return { keyId: key!.id, inviteId: invite!.id };
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

/**
 * #2821 asked whether `deployment_invites` — which also carries ON DELETE
 * CASCADE against `enrollment_keys` — needs the same exemption the
 * bootstrap-token case (a)-(d) above got for #2775.
 *
 * It does not, and the reason is structural rather than incidental. #2775 was
 * reachable because an `installer_bootstrap_tokens` row has its OWN
 * `expires_at`, decoupled from the transient 60-minute parent key it hangs
 * off: the child could still be live long after the parent aged past the
 * purge cutoff. `deployment_invites` has NO expiry column at all
 * (db/schema/deploymentInvites.ts) — an invite is redeemable exactly while
 * its one `enrollment_keys` row is, because both `peekShortCode` and
 * `redeemShortCode` (routes/enrollmentKeys.ts) gate on that same
 * `expires_at`. And the sweep's cutoff is EXPIRY-relative
 * (`expires_at < now() - purgeAfterDays`), never age-relative, with
 * `getPurgeAfterDays()` clamping to >= 1. So the purge can only ever reach a
 * key that stopped working at least a full grace period earlier, whatever
 * TTL the invite was minted with.
 *
 * The invariant these three cases pin: THE SWEEP NEVER DELETES AN ENROLLMENT
 * KEY A DEPLOYMENT INVITE COULD STILL REDEEM. Two plausible future changes
 * would break it and are exactly what (e)/(f) are here to catch — making the
 * purge age-relative (keying on `created_at`), or giving `deployment_invites`
 * its own independent `expires_at` the way bootstrap tokens have. (g) is the
 * control: it proves the CASCADE is genuinely wired, so (e)/(f) can't pass
 * vacuously because invites are somehow untouched by key deletion.
 */
describe('enrollment-key cleanup sweep — deployment_invites cascade lifetime (#2821, real Postgres)', () => {
  runDb('(e) a LIVE invite key survives the sweep even when its TTL far exceeds the purge window', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // 30-day TTL — deliberately much longer than both the MCP tool's
      // 7-day CHILD_KEY_TTL_SECONDS and the 7-day purge grace period. This
      // is the precise scenario #2821 hypothesised as a silent-death bug.
      // It is not one: the cutoff is expiry-relative, so a key that has not
      // expired is unreachable by the DELETE no matter how long it lives.
      const { keyId, inviteId } = await createInviteFixture(
        ids,
        unique,
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      );

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(true);
      expect(await inviteRowExists(inviteId)).toBe(true);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(f) an invite key that expired INSIDE the grace window survives with its invite row intact', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // Expired 1 day ago: already unredeemable, but not yet past the
      // 7-day grace period, so the row is still held for a later sweep.
      const { keyId, inviteId } = await createInviteFixture(
        ids,
        unique,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(true);
      expect(await inviteRowExists(inviteId)).toBe(true);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(g) an invite key expired BEYOND the grace window is purged and cascades its invite row away', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // Expired 10 days ago — 3 days past the cutoff, and 10 days after the
      // invite stopped being redeemable. Deleting it is correct, not the
      // silent death #2821 was worried about. Asserting the invite row goes
      // WITH it is what proves the ON DELETE CASCADE is real, which is what
      // makes (e) and (f) meaningful assertions rather than vacuous ones.
      const { keyId, inviteId } = await createInviteFixture(
        ids,
        unique,
        EXPIRED_PAST_CUTOFF,
      );
      expect(await inviteRowExists(inviteId)).toBe(true);

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(false);
      expect(await inviteRowExists(inviteId)).toBe(false);
    } finally {
      await cleanupFixture(ids);
    }
  });
});
