/**
 * Real-Postgres + real-Redis proof that customer-portal logout ends the
 * presented session durably (Redis-backed session mode, as in production):
 *
 *   - the signed-out token stays refused even when the cache still holds it
 *     (failed delete, lagging replica, Redis restored from an older snapshot);
 *   - the same portal user's other session keeps working;
 *   - the durable record is invisible to, and cannot be forged from, any
 *     tenant-scoped request context under the unprivileged breeze_app role;
 *   - records follow their portal user out on deletion, and expired records
 *     are purged by later logouts.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // PORTAL_USE_REDIS is read at module load; select the production backend
  // before any portal module is imported.
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { portalSessionRevocations, portalUsers } from '../../db/schema';
import { authRoutes, portalAuthMiddleware } from '../../routes/portal/auth';
import { PORTAL_REDIS_KEYS, PORTAL_USE_REDIS } from '../../routes/portal/schemas';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

const PASSWORD = 'PortalLogoutPass123!';
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function portalApp() {
  const app = new Hono();
  app.route('/api/v1/portal', authRoutes);
  app.get('/api/v1/portal/probe', portalAuthMiddleware, (c) => c.json({ ok: true }));
  return app;
}

async function seedPortalUser() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const email = `portal-logout-${randomUUID()}@example.test`;
  const [user] = await getTestDb()
    .insert(portalUsers)
    .values({ orgId: org.id, email, status: 'active', passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: portalUsers.id, orgId: portalUsers.orgId });
  return { user: user!, email };
}

async function login(app: Hono, email: string): Promise<string> {
  const res = await app.request('/api/v1/portal/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { accessToken: string }).accessToken;
}

const probe = async (app: Hono, token: string) =>
  (await app.request('/api/v1/portal/probe', { headers: { Authorization: `Bearer ${token}` } })).status;

const logout = async (app: Hono, token: string) =>
  (await app.request('/api/v1/portal/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })).status;

describe('portal logout ends the presented session durably', () => {
  it('runs in Redis-backed session mode', () => {
    expect(PORTAL_USE_REDIS).toBe(true);
  });

  it('keeps a signed-out token refused when the cache still holds it, while the other session keeps working', async () => {
    const app = portalApp();
    const { user, email } = await seedPortalUser();
    const signedOut = await login(app, email);
    const other = await login(app, email);
    expect(await probe(app, signedOut)).toBe(200);
    expect(await probe(app, other)).toBe(200);

    const redis = getTestRedis();
    const cached = await redis.get(PORTAL_REDIS_KEYS.session(signedOut));
    expect(cached).not.toBeNull();

    expect(await logout(app, signedOut)).toBe(200);
    expect(await redis.get(PORTAL_REDIS_KEYS.session(signedOut))).toBeNull();

    // Put the session back in the cache, as a failed delete or a restore from
    // an earlier snapshot would. Postgres must still refuse it.
    await redis.set(PORTAL_REDIS_KEYS.session(signedOut), cached!, 'EX', 3600);
    expect(await probe(app, signedOut)).toBe(401);
    // The refusal also drops the resurrected cache entry.
    expect(await redis.get(PORTAL_REDIS_KEYS.session(signedOut))).toBeNull();

    expect(await probe(app, other)).toBe(200);

    const rows = await getTestDb().select().from(portalSessionRevocations)
      .where(eq(portalSessionRevocations.portalUserId, user.id));
    expect(rows.map((row) => row.tokenDigest)).toEqual([digest(signedOut)]);
    // Only the digest is stored, never the token.
    expect(JSON.stringify(rows)).not.toContain(signedOut);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it('keeps the records system-only for the unprivileged application role', async () => {
    const app = portalApp();
    const { user, email } = await seedPortalUser();
    const token = await login(app, email);
    expect(await logout(app, token)).toBe(200);

    const role = await db.execute(sql`select current_user as name`);
    expect((role as unknown as Array<{ name: string }>)[0]?.name).toBe('breeze_app');

    const tenantContext = {
      scope: 'organization' as const,
      orgId: user.orgId,
      accessibleOrgIds: [user.orgId],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: null,
    };
    const visible = await withDbAccessContext(tenantContext, () =>
      db.select().from(portalSessionRevocations));
    expect(visible).toEqual([]);

    let forged: unknown;
    try {
      await withDbAccessContext(tenantContext, () =>
        db.insert(portalSessionRevocations).values({
          tokenDigest: digest(randomUUID()),
          portalUserId: user.id,
          expiresAt: new Date(Date.now() + 60_000),
        }));
    } catch (error) {
      forged = error;
    }
    const code = (forged as { code?: string; cause?: { code?: string } } | undefined);
    expect(code?.code ?? code?.cause?.code).toBe('42501');
  });

  it('removes records with their portal user and purges expired records on a later logout', async () => {
    const app = portalApp();
    const { user, email } = await seedPortalUser();
    const stale = digest(`stale-${randomUUID()}`);
    await getTestDb().insert(portalSessionRevocations).values({
      tokenDigest: stale,
      portalUserId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const token = await login(app, email);
    expect(await logout(app, token)).toBe(200);
    const afterLogout = await getTestDb().select({ tokenDigest: portalSessionRevocations.tokenDigest })
      .from(portalSessionRevocations).where(eq(portalSessionRevocations.portalUserId, user.id));
    expect(afterLogout.map((row) => row.tokenDigest)).toEqual([digest(token)]);

    await getTestDb().delete(portalUsers).where(eq(portalUsers.id, user.id));
    const afterDelete = await getTestDb().select().from(portalSessionRevocations)
      .where(eq(portalSessionRevocations.portalUserId, user.id));
    expect(afterDelete).toEqual([]);
  });
});
