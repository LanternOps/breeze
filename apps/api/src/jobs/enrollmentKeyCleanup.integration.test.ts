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
 * Cases (e)-(h) pin the `deployment_invites` cascade lifetime (#2821). That
 * issue asked whether invites need the same exemption bootstrap tokens got.
 * They do NOT, and these tests are what makes that answer durable rather than
 * a one-time reading of the code — see the second describe block's comment
 * for the invariant, for what each case actually discriminates, and for the
 * one future change that would defeat the whole suite.
 */
import '../__tests__/integration/setup';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
 * Seed an `enrollment_keys` row plus a `deployment_invites` row cascading off
 * it — the same SHAPE the MCP tool `send_deployment_invites` creates
 * (mintChildEnrollmentKey -> insert invite referencing that key's id). Not
 * byte-identical to production: `key` here is a readable literal rather than a
 * `hashEnrollmentKey` digest, and `invitedByApiKeyId` is left null to avoid
 * dragging an `api_keys` fixture in. Neither column appears in the sweep's
 * predicate, so neither can affect the outcome.
 *
 * `createdAt` is settable on purpose. Leaving every fixture at `defaultNow()`
 * would mean no row in this file is ever OLD-BUT-LIVE, and an age-relative
 * purge arm (see the describe block) could then be added without any test
 * noticing. Backdating is what makes that mutation detectable.
 */
async function createInviteFixture(
  ids: { partnerId: string; orgId: string; siteId: string },
  unique: string,
  opts: { expiresAt: Date | null; createdAt?: Date },
): Promise<{ keyId: string; inviteId: string }> {
  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: ids.orgId,
        siteId: ids.siteId,
        name: `mcp-invite invitee-${unique}@example.com`,
        key: `sweep-inv-key-${unique}`,
        // 10 chars, alphanumeric only — `allocateShortCode`'s alphabet has no
        // '-', so strip the separator rather than ship a code production
        // could never mint.
        shortCode: unique.replace(/-/g, '').slice(-10),
        expiresAt: opts.expiresAt,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
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

/**
 * A sacrificial key that is unambiguously past the cutoff and has no children,
 * so the sweep MUST delete it. Seeded alongside a survive-case fixture and
 * asserted gone in the same run, it proves the DELETE actually matched rows —
 * without it, a survive-assertion would also pass if the sweep silently
 * matched NOTHING (wrong DB context, swallowed predicate error).
 *
 * Deliberately not an assertion on the processor's returned `deletedCount`:
 * the sweep is system-wide with no tenant filter, so that number also counts
 * unrelated rows and is not deterministic under a shared test database.
 */
async function createCanaryKey(
  ids: { orgId: string; siteId: string },
  unique: string,
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: ids.orgId,
        siteId: ids.siteId,
        name: 'canary — must be swept',
        key: `sweep-canary-${unique}`,
        expiresAt: EXPIRED_PAST_CUTOFF,
        maxUsage: 1,
      })
      .returning({ id: enrollmentKeys.id });
    return key!.id;
  });
}

// The default purge grace period is 7 days (DEFAULT_PURGE_AFTER_DAYS). Every
// scenario below creates a key that expired 10 days ago — comfortably past
// that cutoff, so the ONLY thing that can save it from the sweep is the
// live-bootstrap-token exemption.
const EXPIRED_PAST_CUTOFF = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

// Pin the grace period for the whole file rather than inheriting whatever the
// ambient environment has. `vitest.integration.config.ts` loads the repo-root
// `.env.test`, so an operator setting ENROLLMENT_KEY_PURGE_AFTER_DAYS=1 there
// would silently break case (f), whose expired-1-day-ago fixture is computed a
// few milliseconds before the worker's own cutoff. The mocked sibling suite
// (enrollmentKeyCleanup.test.ts) already save/restores this var; mirroring it
// here decouples all of (a)-(h) from the environment.
const PINNED_PURGE_AFTER_DAYS = '7';
let previousPurgeAfterDays: string | undefined;

beforeAll(() => {
  previousPurgeAfterDays = process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
  process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = PINNED_PURGE_AFTER_DAYS;
});

afterAll(() => {
  if (previousPurgeAfterDays === undefined) {
    delete process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
  } else {
    process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = previousPurgeAfterDays;
  }
});

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
 * The invariant: THE SWEEP NEVER DELETES AN ENROLLMENT KEY A DEPLOYMENT
 * INVITE COULD STILL REDEEM.
 *
 * What each case actually discriminates (verified by mutating
 * enrollmentKeyCleanup.ts and watching these go red — not assumed):
 *   (e) the only redeemable-key case in the file. Its key is LIVE but
 *       BACKDATED 30 days, which is what catches an age-relative purge:
 *       both `lt(createdAt, cutoff)` replacing the expiry guard AND an
 *       additive `or(lt(expiresAt, cutoff), lt(createdAt, cutoff))` arm.
 *       An additive arm is the realistic regression — the sweep's docblock
 *       advertises that long-TTL keys are never reclaimed, so an ops-pressure
 *       "cap it by age" patch lands exactly there. Also fails if the
 *       expiry-window guard is dropped entirely.
 *   (f) NOT an invariant case: a key that expired 1 day ago is already
 *       unredeemable. It is a grace-window retention guard — the only
 *       inside-the-window case in the file — and fails if the grace period
 *       is removed (`cutoff = now()`), which is exactly what the on-demand
 *       purge route does.
 *   (g) the cascade control: proves the ON DELETE CASCADE is genuinely
 *       wired, so (e)/(f) aren't passing merely because invites are
 *       untouched by key deletion.
 *   (h) the strongest form of the invariant — a NULL-expiry key is
 *       redeemable FOREVER (`peekShortCode` permits it), so it must never be
 *       swept. Fails if the `isNotNull` guard is dropped.
 *
 * Each survive-case also seeds a canary key that MUST die in the same sweep,
 * so "the row survived" can never be satisfied by a sweep that matched
 * nothing at all.
 *
 * !! LIMIT OF THIS SUITE !! If `deployment_invites` ever gains its own
 * independent `expires_at` — the decoupling that made #2775 real — NONE of
 * these cases will catch the resulting bug, and (g) would actively bless it
 * by asserting the invite is cascaded away. Whoever adds that column must add
 * a case pinning invite-expiry > key-expiry at the same time.
 */
describe('enrollment-key cleanup sweep — deployment_invites cascade lifetime (#2821, real Postgres)', () => {
  runDb('(e) an OLD but still-redeemable invite key survives — long TTL and age are both irrelevant to an expiry-relative cutoff', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // The realistic shape of #2821's fear: an invite SENT 30 DAYS AGO that
      // is still redeemable for another 30. Backdating `created_at` is
      // load-bearing — with it left at now(), an additive age-relative purge
      // arm would sail past this test while hard-deleting exactly this row in
      // production.
      const { keyId, inviteId } = await createInviteFixture(ids, unique, {
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const canaryId = await createCanaryKey(ids, `${unique}-canary`);

      await runSweep();

      expect(await keyRowExists(canaryId)).toBe(false); // the sweep really ran
      expect(await keyRowExists(keyId)).toBe(true);
      expect(await inviteRowExists(inviteId)).toBe(true);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(f) an invite key that expired INSIDE the grace window is retained (already unredeemable, but not yet purgeable)', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // Expired 1 day ago: already unredeemable, but not yet past the
      // 7-day grace period, so the row is still held for a later sweep.
      const { keyId, inviteId } = await createInviteFixture(ids, unique, {
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const canaryId = await createCanaryKey(ids, `${unique}-canary`);

      await runSweep();

      expect(await keyRowExists(canaryId)).toBe(false); // the sweep really ran
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
      const { keyId, inviteId } = await createInviteFixture(ids, unique, {
        expiresAt: EXPIRED_PAST_CUTOFF,
      });
      expect(await inviteRowExists(inviteId)).toBe(true);

      await runSweep();

      expect(await keyRowExists(keyId)).toBe(false);
      expect(await inviteRowExists(inviteId)).toBe(false);
    } finally {
      await cleanupFixture(ids);
    }
  });

  runDb('(h) an invite key with NULL expiry is never swept — it is redeemable forever', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await createFixture(unique);
    try {
      // `peekShortCode` only rejects on `expiresAt && expiresAt < now`, so a
      // NULL-expiry key stays redeemable indefinitely — the strongest form of
      // the invariant. Not reachable today (mintChildEnrollmentKey always sets
      // an expiry), which is precisely why it is worth pinning: nothing else
      // would notice if the `isNotNull` guard were dropped and every
      // never-expiring invite link vanished at once.
      const { keyId, inviteId } = await createInviteFixture(ids, unique, {
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        expiresAt: null,
      });
      const canaryId = await createCanaryKey(ids, `${unique}-canary`);

      await runSweep();

      expect(await keyRowExists(canaryId)).toBe(false); // the sweep really ran
      expect(await keyRowExists(keyId)).toBe(true);
      expect(await inviteRowExists(inviteId)).toBe(true);
    } finally {
      await cleanupFixture(ids);
    }
  });
});
