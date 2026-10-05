/**
 * Real-Postgres proof that installer bootstrap tokens are stored as a keyed
 * hash and redeemed by hash, while unhashed legacy rows stay redeemable until
 * their own expiry.
 *
 * Issuance runs as `breeze_app` under an org-scoped RLS context (the request
 * path of the authenticated installer routes); redemption runs through the
 * real public POST /installer/bootstrap route. The stored row is read back
 * through the privileged test client so the assertion is about what actually
 * landed on disk, not the service's return value.
 */
import './setup';

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { enrollmentKeys, installerBootstrapTokens } from '../../db/schema';
import { getAppDb, getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import {
  generateBootstrapToken,
  hashBootstrapToken,
} from '../../services/installerBootstrapToken';
import { issueBootstrapTokenForKey } from '../../services/installerBootstrapTokenIssuance';
import { installerRoutes } from '../../routes/installer';
import { hashLegacyInstallerBootstrapTokens } from '../../services/installerBootstrapTokenHashBackfill';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makeApp(): Hono {
  const app = new Hono();
  app.route('/installer', installerRoutes);
  return app;
}

function redeem(token: string) {
  return makeApp().request('/installer/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function seedParent(env: TestEnvironment): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [parent] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        name: `hashing parent ${Date.now()}`,
        key: `hashing-parent-${crypto.randomUUID()}`,
        maxUsage: 50,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdBy: env.user.id,
      })
      .returning({ id: enrollmentKeys.id });
    return parent!.id;
  });
}

async function storedRow(id: string) {
  const [row] = await getTestDb()
    .select()
    .from(installerBootstrapTokens)
    .where(eq(installerBootstrapTokens.id, id));
  return row!;
}

describe('installer bootstrap tokens are stored hashed (real Postgres)', () => {
  runDb('issue as breeze_app stores only the keyed hash; redeem by the raw token; usage is counted', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const parentId = await seedParent(env);

    const issued = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: env.organization.id,
        accessibleOrgIds: [env.organization.id],
        userId: env.user.id,
      } as Parameters<typeof withDbAccessContext>[0],
      () =>
        issueBootstrapTokenForKey({
          parentEnrollmentKeyId: parentId,
          createdByUserId: env.user.id,
          usageKind: 'capacity',
          maxUsage: 2,
          installerPlatform: 'windows',
        }),
    );

    const row = await storedRow(issued.id);
    expect(row.token).toBeNull();
    expect(row.tokenHash).toBe(hashBootstrapToken(issued.token));
    expect(row.tokenHash).not.toContain(issued.token);

    const first = await redeem(issued.token);
    expect(first.status).toBe(200);
    expect((await first.json()).enrollmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect((await storedRow(issued.id)).consumedCount).toBe(1);

    const second = await redeem(issued.token);
    expect(second.status).toBe(200);
    expect((await storedRow(issued.id)).consumedCount).toBe(2);

    // Budget of 2 is spent: the third device is refused and nothing is counted.
    const third = await redeem(issued.token);
    expect(third.status).toBe(404);
    expect((await storedRow(issued.id)).consumedCount).toBe(2);
  });

  runDb('a wrong token is refused without touching any row', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const parentId = await seedParent(env);
    const issued = await withSystemDbAccessContext(() =>
      issueBootstrapTokenForKey({
        parentEnrollmentKeyId: parentId,
        createdByUserId: env.user.id,
        usageKind: 'capacity',
        maxUsage: 1,
      }),
    );

    let wrong = generateBootstrapToken();
    while (wrong === issued.token) wrong = generateBootstrapToken();

    const res = await redeem(wrong);
    expect(res.status).toBe(404);
    expect((await storedRow(issued.id)).consumedCount).toBe(0);
  });

  runDb('a legacy plaintext row (token_hash NULL) stays redeemable until it expires', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const parentId = await seedParent(env);
    const liveRaw = generateBootstrapToken();
    const expiredRaw = generateBootstrapToken();

    const [live, expired] = await withSystemDbAccessContext(async () => {
      const base = {
        orgId: env.organization.id,
        parentEnrollmentKeyId: parentId,
        siteId: env.site.id,
        maxUsage: 1,
        createdBy: env.user.id,
        installerPlatform: 'macos',
        usageKind: 'capacity',
      } as const;
      const [l] = await db
        .insert(installerBootstrapTokens)
        .values({ ...base, token: liveRaw, expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
        .returning({ id: installerBootstrapTokens.id });
      const [e] = await db
        .insert(installerBootstrapTokens)
        .values({
          ...base,
          token: expiredRaw,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 60 * 1000),
        })
        .returning({ id: installerBootstrapTokens.id });
      return [l!.id, e!.id];
    });

    const liveRes = await redeem(liveRaw);
    expect(liveRes.status).toBe(200);
    expect((await storedRow(live)).consumedCount).toBe(1);

    const expiredRes = await redeem(expiredRaw);
    expect(expiredRes.status).toBe(404);
    expect((await storedRow(expired)).consumedCount).toBe(0);
  });

  runDb('a hashed row is never matched by its plaintext column, and a row must carry token or hash', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const parentId = await seedParent(env);
    const raw = generateBootstrapToken();
    const decoy = generateBootstrapToken();

    // A row whose hash is for `raw` but whose (should-be-NULL) plaintext column
    // holds `decoy`: presenting `decoy` must not redeem it — the plaintext
    // fallback is confined to rows with no hash.
    const id = await withSystemDbAccessContext(async () => {
      const [r] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: decoy,
          tokenHash: hashBootstrapToken(raw),
          orgId: env.organization.id,
          parentEnrollmentKeyId: parentId,
          siteId: env.site.id,
          maxUsage: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          usageKind: 'capacity',
        })
        .returning({ id: installerBootstrapTokens.id });
      return r!.id;
    });

    expect((await redeem(decoy)).status).toBe(404);
    expect((await storedRow(id)).consumedCount).toBe(0);

    // Neither verifier present → CHECK violation, as breeze_app.
    const failure = await getAppDb()
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
        await tx.insert(installerBootstrapTokens).values({
          orgId: env.organization.id,
          parentEnrollmentKeyId: parentId,
          maxUsage: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          usageKind: 'capacity',
        });
      })
      .then(() => null, (err: unknown) => err as { code?: string; cause?: { code?: string } });
    expect(failure).not.toBeNull();
    expect(failure!.code ?? failure!.cause?.code).toBe('23514');
  });

  runDb('the boot step hashes legacy rows in place: plaintext gone, still redeemable by the raw token', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const parentId = await seedParent(env);
    const liveRaw = generateBootstrapToken();
    const expiredRaw = generateBootstrapToken();

    const [live, expired] = await withSystemDbAccessContext(async () => {
      const base = {
        orgId: env.organization.id,
        parentEnrollmentKeyId: parentId,
        siteId: env.site.id,
        maxUsage: 1,
        installerPlatform: 'windows',
        usageKind: 'per_download',
      } as const;
      const [l] = await db
        .insert(installerBootstrapTokens)
        .values({ ...base, token: liveRaw, expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
        .returning({ id: installerBootstrapTokens.id });
      const [e] = await db
        .insert(installerBootstrapTokens)
        .values({
          ...base,
          token: expiredRaw,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 60 * 1000),
        })
        .returning({ id: installerBootstrapTokens.id });
      return [l!.id, e!.id];
    });

    const stats = await hashLegacyInstallerBootstrapTokens();
    expect(stats.failed).toBe(0);
    expect(stats.hashed).toBeGreaterThanOrEqual(2);

    for (const [id, raw] of [[live, liveRaw], [expired, expiredRaw]] as const) {
      const row = await storedRow(id);
      expect(row.token).toBeNull();
      expect(row.tokenHash).toBe(hashBootstrapToken(raw));
    }

    // Idempotent: a second boot finds nothing left to do and changes nothing.
    const again = await hashLegacyInstallerBootstrapTokens();
    expect(again).toEqual({ scanned: 0, hashed: 0, contended: 0, failed: 0 });
    expect((await storedRow(live)).tokenHash).toBe(hashBootstrapToken(liveRaw));

    // The live installer still works, now through the hash path...
    expect((await redeem(liveRaw)).status).toBe(200);
    expect((await storedRow(live)).consumedCount).toBe(1);
    // ...and the expired one is still refused by its expiry.
    expect((await redeem(expiredRaw)).status).toBe(404);
    expect((await storedRow(expired)).consumedCount).toBe(0);
  });
});
