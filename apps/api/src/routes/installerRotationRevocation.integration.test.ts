/**
 * Rotating an enrollment key is a revocation barrier for bootstrap authority
 * derived from the superseded credential.
 *
 * This is real-Postgres route coverage because mocked Drizzle chains cannot
 * prove the rotation/redeem ordering or that the stale token is rejected
 * before a child enrollment key is persisted. The parent expiry and usage
 * budget are intentionally not part of this invariant: bootstrap tokens have
 * their own lifetime and capacity.
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema';
import { setupTestEnvironment, type TestEnvironment } from '../__tests__/integration/db-utils';
import { generateBootstrapToken } from '../services/installerBootstrapToken';
import { issueBootstrapTokenForKey } from '../services/installerBootstrapTokenIssuance';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import { enrollmentKeyRoutes } from './enrollmentKeys';
import { installerRoutes } from './installer';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type TrackedOperation = Promise<PromiseSettledResult<unknown>>;

function trackOperation<T>(operation: T | PromiseLike<T>, pending: TrackedOperation[]): Promise<T> {
  const promise = Promise.resolve(operation);
  pending.push(Promise.allSettled([promise]).then(([result]) => result!));
  return promise;
}

async function waitForHolderReady(ready: Promise<void>, holder: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      holder.then(() => { throw new Error('holder completed before readiness'); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('holder did not become ready within 8000ms')), 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishConcurrentFixture(
  release: () => void,
  pending: TrackedOperation[],
  cleanup: Array<() => PromiseLike<unknown>>,
  primaryFailure: boolean,
): Promise<void> {
  release();
  const outcomes = await Promise.all(pending);
  const cleanupFailures: unknown[] = [];
  for (const action of cleanup) {
    try {
      await action();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (!primaryFailure) {
    const rejected = outcomes.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    if (cleanupFailures.length) throw cleanupFailures[0];
  }
}

async function waitForQueryBlockedBy(
  observer: ReturnType<typeof postgres>,
  blockerPid: number,
  queryFragment: string,
): Promise<{ pid: number; query: string }> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number; query: string }[]>`
      SELECT pid, query
      FROM pg_stat_activity
      WHERE state = 'active'
        AND ${blockerPid}::int4 = ANY (pg_blocking_pids(pid))
        AND query ILIKE ${`%${queryFragment}%`}
      ORDER BY query_start
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`did not observe ${queryFragment} blocked by backend ${blockerPid}`);
}

async function mfaSatisfiedToken(env: TestEnvironment): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/enrollment-keys', enrollmentKeyRoutes);
  app.route('/installer', installerRoutes);
  return app;
}

describe('enrollment-key rotation revokes derived bootstrap authority', () => {
  runDb('rejects an unconsumed pre-rotation token without minting another child key', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const authToken = await mfaSatisfiedToken(env);
    const unique = `${Date.now()}-${randomUUID()}`;
    const bootstrapToken = generateBootstrapToken();
    let currentIssuedId: string | null = null;

    const seeded = await withSystemDbAccessContext(async () => {
      const [parent] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `rotation parent ${unique}`,
          key: randomUUID(),
          maxUsage: 25,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdBy: env.user.id,
        })
        .returning({ id: enrollmentKeys.id });

      const [token] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: bootstrapToken,
          orgId: env.organization.id,
          parentEnrollmentKeyId: parent!.id,
          siteId: env.site.id,
          maxUsage: 3,
          consumedCount: 2,
          createdBy: env.user.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          installerPlatform: 'macos',
          usageKind: 'capacity',
        })
        .returning({ id: installerBootstrapTokens.id });

      const [unusedChild] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `rotation unused child ${unique}`,
          key: randomUUID(),
          maxUsage: 1,
          usageCount: 0,
          bootstrapTokenId: token!.id,
        })
        .returning({ id: enrollmentKeys.id });
      const [usedChild] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `rotation used child ${unique}`,
          key: randomUUID(),
          maxUsage: 1,
          usageCount: 1,
          bootstrapTokenId: token!.id,
        })
        .returning({ id: enrollmentKeys.id });

      return {
        parentId: parent!.id,
        tokenId: token!.id,
        unusedChildId: unusedChild!.id,
        usedChildId: usedChild!.id,
      };
    });

    try {
      const rotate = await makeApp().request(`/enrollment-keys/${seeded.parentId}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(rotate.status).toBe(200);

      const redeem = await makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken }),
      });

      expect(redeem.status).toBe(404);
      expect(await redeem.json()).toEqual({
        error: 'token invalid, expired, or already used',
      });

      const state = await withSystemDbAccessContext(async () => {
        const [token] = await db
          .select({ consumedCount: installerBootstrapTokens.consumedCount })
          .from(installerBootstrapTokens)
          .where(eq(installerBootstrapTokens.id, seeded.tokenId));
        const children = await db
          .select({ id: enrollmentKeys.id })
          .from(enrollmentKeys)
          .where(eq(enrollmentKeys.bootstrapTokenId, seeded.tokenId));
        const [parent] = await db
          .select({ generation: enrollmentKeys.credentialGeneration })
          .from(enrollmentKeys)
          .where(eq(enrollmentKeys.id, seeded.parentId));
        return { token, children, parent };
      });
      expect(state.token?.consumedCount).toBe(2);
      expect(state.parent?.generation).toBe(2);
      expect(state.children).toEqual([{ id: seeded.usedChildId }]);

      // Positive control: a token issued after the rotation snapshots epoch 2
      // and remains redeemable. This prevents a repair that simply disables
      // every token under a rotated parent.
      const issued = await withSystemDbAccessContext(() =>
        issueBootstrapTokenForKey({
          parentEnrollmentKeyId: seeded.parentId,
          createdByUserId: env.user.id,
          usageKind: 'capacity',
          maxUsage: 1,
          ttlMinutes: 60,
          installerPlatform: 'macos',
        }),
      );
      currentIssuedId = issued.id;
      const currentRedeem = await makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: issued.token }),
      });
      expect(currentRedeem.status).toBe(200);

      const [issuedRow] = await withSystemDbAccessContext(() =>
        db
          .select({ generation: installerBootstrapTokens.parentCredentialGeneration })
          .from(installerBootstrapTokens)
          .where(eq(installerBootstrapTokens.id, issued.id)),
      );
      expect(issuedRow?.generation).toBe(2);
    } finally {
      await withSystemDbAccessContext(async () => {
        if (currentIssuedId) {
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.bootstrapTokenId, currentIssuedId));
        }
        await db.delete(enrollmentKeys).where(eq(enrollmentKeys.bootstrapTokenId, seeded.tokenId));
        await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, seeded.parentId));
      });
    }
  });

  runDb('cannot rotate or revoke another tenant\'s parent credential epoch', async () => {
    const caller = await setupTestEnvironment({ scope: 'organization' });
    const target = await setupTestEnvironment({ scope: 'organization' });
    const authToken = await mfaSatisfiedToken(caller);
    const bootstrapToken = generateBootstrapToken();

    const seeded = await withSystemDbAccessContext(async () => {
      const [parent] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: target.organization.id,
          siteId: target.site.id,
          name: `foreign rotation parent ${randomUUID()}`,
          key: randomUUID(),
          maxUsage: 1,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdBy: target.user.id,
        })
        .returning({ id: enrollmentKeys.id });
      const [token] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: bootstrapToken,
          orgId: target.organization.id,
          parentEnrollmentKeyId: parent!.id,
          siteId: target.site.id,
          maxUsage: 1,
          createdBy: target.user.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          installerPlatform: 'macos',
          usageKind: 'capacity',
        })
        .returning({ id: installerBootstrapTokens.id });
      return { parentId: parent!.id, tokenId: token!.id };
    });

    try {
      const denied = await makeApp().request(`/enrollment-keys/${seeded.parentId}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      // RLS hides the target row before app-layer access checks can reveal it.
      expect(denied.status).toBe(404);

      const [parent] = await withSystemDbAccessContext(() =>
        db
          .select({ generation: enrollmentKeys.credentialGeneration })
          .from(enrollmentKeys)
          .where(eq(enrollmentKeys.id, seeded.parentId)),
      );
      expect(parent?.generation).toBe(1);

      // Positive control: the denied request did not silently revoke the
      // target tenant's bearer. The bootstrap endpoint is intentionally public
      // because possession of this synthetic token is its authorization.
      const redeem = await makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      expect(redeem.status).toBe(200);
    } finally {
      await withSystemDbAccessContext(async () => {
        await db.delete(enrollmentKeys).where(eq(enrollmentKeys.bootstrapTokenId, seeded.tokenId));
        await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, seeded.parentId));
      });
    }
  });

  runDb('serializes an in-flight redemption ahead of rotation, then revokes its unused child', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const authToken = await mfaSatisfiedToken(env);
    const bootstrapToken = generateBootstrapToken();
    const unique = randomUUID();
    const advisoryKey = Math.floor(Math.random() * 1_000_000_000) + 1;
    const functionName = `block_bootstrap_child_${unique.replaceAll('-', '')}`;
    const triggerName = `block_bootstrap_child_${unique.replaceAll('-', '')}`;
    const releaseHolder = deferred();
    let holderTransaction: Promise<unknown> | null = null;
    const pending: TrackedOperation[] = [];
    const holderReady = deferred();
    let primaryFailure = false;

    const seeded = await withSystemDbAccessContext(async () => {
      const [parent] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `concurrent rotation parent ${unique}`,
          key: randomUUID(),
          maxUsage: 2,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdBy: env.user.id,
        })
        .returning({ id: enrollmentKeys.id });
      const [token] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: bootstrapToken,
          orgId: env.organization.id,
          parentEnrollmentKeyId: parent!.id,
          siteId: env.site.id,
          maxUsage: 2,
          createdBy: env.user.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          installerPlatform: 'macos',
          usageKind: 'capacity',
        })
        .returning({ id: installerBootstrapTokens.id });
      return { parentId: parent!.id, tokenId: token!.id };
    });

    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The trigger parks only this fixture's child INSERT on an advisory lock.
      // At that point redemption already holds FOR SHARE on the parent, which
      // lets pg_blocking_pids prove the subsequent rotation queues behind it.
      await admin.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON enrollment_keys
        FOR EACH ROW
        WHEN (NEW.bootstrap_token_id = '${seeded.tokenId}'::uuid)
        EXECUTE FUNCTION ${functionName}();
      `);

      let holderPid = 0;
      holderTransaction = trackOperation(holder.begin(async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        holderPid = pidRow!.pid;
        await tx`SELECT pg_advisory_xact_lock(${advisoryKey})`;
        holderReady.resolve();
        await releaseHolder.promise;
      }), pending);
      await waitForHolderReady(holderReady.promise, holderTransaction);

      const redeemPromise = trackOperation(makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken }),
      }), pending);
      const blockedRedeem = await waitForQueryBlockedBy(
        admin,
        holderPid,
        'insert into "enrollment_keys"',
      );

      const rotatePromise = trackOperation(makeApp().request(`/enrollment-keys/${seeded.parentId}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }), pending);
      const blockedRotation = await waitForQueryBlockedBy(
        admin,
        blockedRedeem.pid,
        'update "enrollment_keys"',
      );
      expect(blockedRotation.query.toLowerCase()).toContain('update "enrollment_keys"');

      releaseHolder.resolve();
      await holderTransaction;
      const [redeem, rotate] = await Promise.all([redeemPromise, rotatePromise]);
      expect(redeem.status).toBe(200);
      expect(rotate.status).toBe(200);

      const children = await withSystemDbAccessContext(() =>
        db
          .select({ id: enrollmentKeys.id })
          .from(enrollmentKeys)
          .where(eq(enrollmentKeys.bootstrapTokenId, seeded.tokenId)),
      );
      expect(children).toEqual([]);

      const replay = await makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      expect(replay.status).toBe(404);
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      await finishConcurrentFixture(releaseHolder.resolve, pending, [
        () => admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON enrollment_keys`),
        () => admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`),
        () => holder.end({ timeout: 1 }),
        () => admin.end({ timeout: 1 }),
        () => withSystemDbAccessContext(async () => {
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.bootstrapTokenId, seeded.tokenId));
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, seeded.parentId));
        }),
      ], primaryFailure);
    }
  }, 20_000);

  runDb('serializes in-flight token issuance ahead of rotation and invalidates the issued epoch', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const authToken = await mfaSatisfiedToken(env);
    const unique = randomUUID();
    const advisoryKey = Math.floor(Math.random() * 1_000_000_000) + 1;
    const functionName = `block_bootstrap_issue_${unique.replaceAll('-', '')}`;
    const triggerName = `block_bootstrap_issue_${unique.replaceAll('-', '')}`;
    const releaseHolder = deferred();
    let holderTransaction: Promise<unknown> | null = null;
    const pending: TrackedOperation[] = [];
    const holderReady = deferred();
    let primaryFailure = false;

    const [parent] = await withSystemDbAccessContext(() =>
      db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `concurrent issuance parent ${unique}`,
          key: randomUUID(),
          maxUsage: 2,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdBy: env.user.id,
        })
        .returning({ id: enrollmentKeys.id }),
    );

    let issuedId: string | null = null;
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON installer_bootstrap_tokens
        FOR EACH ROW
        WHEN (NEW.parent_enrollment_key_id = '${parent!.id}'::uuid)
        EXECUTE FUNCTION ${functionName}();
      `);

      let holderPid = 0;
      holderTransaction = trackOperation(holder.begin(async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        holderPid = pidRow!.pid;
        await tx`SELECT pg_advisory_xact_lock(${advisoryKey})`;
        holderReady.resolve();
        await releaseHolder.promise;
      }), pending);
      await waitForHolderReady(holderReady.promise, holderTransaction);

      const issuePromise = trackOperation(withSystemDbAccessContext(() =>
        issueBootstrapTokenForKey({
          parentEnrollmentKeyId: parent!.id,
          createdByUserId: env.user.id,
          usageKind: 'capacity',
          maxUsage: 1,
          ttlMinutes: 60,
          installerPlatform: 'macos',
        }),
      ).then((issued) => {
        issuedId = issued.id;
        return issued;
      }), pending);
      const blockedIssue = await waitForQueryBlockedBy(
        admin,
        holderPid,
        'insert into "installer_bootstrap_tokens"',
      );

      const rotatePromise = trackOperation(makeApp().request(`/enrollment-keys/${parent!.id}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }), pending);
      await waitForQueryBlockedBy(admin, blockedIssue.pid, 'update "enrollment_keys"');

      releaseHolder.resolve();
      await holderTransaction;
      const [issued, rotate] = await Promise.all([issuePromise, rotatePromise]);
      issuedId = issued.id;
      expect(rotate.status).toBe(200);

      const redeem = await makeApp().request('/installer/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: issued.token }),
      });
      expect(redeem.status).toBe(404);
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      await finishConcurrentFixture(releaseHolder.resolve, pending, [
        () => admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON installer_bootstrap_tokens`),
        () => admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`),
        () => holder.end({ timeout: 1 }),
        () => admin.end({ timeout: 1 }),
        () => withSystemDbAccessContext(async () => {
          if (issuedId) {
            await db.delete(enrollmentKeys).where(eq(enrollmentKeys.bootstrapTokenId, issuedId));
          }
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, parent!.id));
        }),
      ], primaryFailure);
    }
  }, 20_000);

  runDb('preserves a derived child whose enrollment claim wins the race with rotation', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const authToken = await mfaSatisfiedToken(env);
    const bootstrapToken = generateBootstrapToken();
    const releaseHolder = deferred();
    let holderTransaction: Promise<unknown> | null = null;
    const pending: TrackedOperation[] = [];
    const holderReady = deferred();
    let primaryFailure = false;

    const seeded = await withSystemDbAccessContext(async () => {
      const [parent] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: `child claim parent ${randomUUID()}`,
          key: randomUUID(),
          maxUsage: 1,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdBy: env.user.id,
        })
        .returning({ id: enrollmentKeys.id });
      const [token] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: bootstrapToken,
          orgId: env.organization.id,
          parentEnrollmentKeyId: parent!.id,
          siteId: env.site.id,
          maxUsage: 1,
          consumedCount: 1,
          createdBy: env.user.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          installerPlatform: 'macos',
          usageKind: 'capacity',
        })
        .returning({ id: installerBootstrapTokens.id });
      const [child] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: env.organization.id,
          siteId: env.site.id,
          name: 'derived child claiming enrollment',
          key: randomUUID(),
          maxUsage: 1,
          usageCount: 0,
          bootstrapTokenId: token!.id,
        })
        .returning({ id: enrollmentKeys.id });
      return { parentId: parent!.id, tokenId: token!.id, childId: child!.id };
    });

    let holderPid = 0;
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      holderTransaction = trackOperation(holder.begin(async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        holderPid = pidRow!.pid;
        // This is the database boundary used by enrollment: atomically claim
        // the still-unused single-use child. Keep it uncommitted so rotation's
        // delete must wait and re-evaluate usage_count after the claim commits.
        await tx`
          UPDATE enrollment_keys
          SET usage_count = usage_count + 1
          WHERE id = ${seeded.childId} AND usage_count < max_usage
        `;
        holderReady.resolve();
        await releaseHolder.promise;
      }), pending);
      await waitForHolderReady(holderReady.promise, holderTransaction);

      const rotatePromise = trackOperation(makeApp().request(`/enrollment-keys/${seeded.parentId}/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }), pending);
      await waitForQueryBlockedBy(observer, holderPid, 'delete from "enrollment_keys"');

      releaseHolder.resolve();
      await holderTransaction;
      const rotate = await rotatePromise;
      expect(rotate.status).toBe(200);

      const [child] = await withSystemDbAccessContext(() =>
        db
          .select({ usageCount: enrollmentKeys.usageCount })
          .from(enrollmentKeys)
          .where(eq(enrollmentKeys.id, seeded.childId)),
      );
      expect(child?.usageCount).toBe(1);
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      await finishConcurrentFixture(releaseHolder.resolve, pending, [
        () => holder.end({ timeout: 1 }),
        () => observer.end({ timeout: 1 }),
        () => withSystemDbAccessContext(async () => {
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, seeded.childId));
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, seeded.parentId));
        }),
      ], primaryFailure);
    }
  }, 20_000);
});
