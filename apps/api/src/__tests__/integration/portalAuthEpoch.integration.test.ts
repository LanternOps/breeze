import './setup';
import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { clientAiAuthMiddleware } from '../../middleware/clientAiAuth';
import { portalAuthMiddleware } from '../../routes/portal/auth';
import { portalSessions } from '../../routes/portal/helpers';
import { CLIENT_AI_REDIS_KEYS } from '../../routes/clientAi/schemas';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

async function seedPortalUser() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [user] = await getTestDb()
    .insert(portalUsers)
    .values({ orgId: org.id, email: `${randomUUID()}@epoch.test`, status: 'active' })
    .returning({ id: portalUsers.id, orgId: portalUsers.orgId, authEpoch: portalUsers.authEpoch });
  return user!;
}

async function advanceEpoch(userId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .update(portalUsers)
      .set({ authEpoch: sql`${portalUsers.authEpoch} + 1` })
      .where(eq(portalUsers.id, userId))
      .returning({ authEpoch: portalUsers.authEpoch })
  );
  return row!.authEpoch;
}

describe('portal auth epoch — real PostgreSQL as breeze_app', () => {
  it('admits the current generation and rejects the same portal token after an epoch advance', async () => {
    const user = await seedPortalUser();
    const token = `portal-${randomUUID()}`;
    portalSessions.set(token, {
      token,
      portalUserId: user.id,
      orgId: user.orgId,
      authEpoch: user.authEpoch,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = new Hono();
    app.use('*', portalAuthMiddleware);
    app.get('/protected', (c) => c.json({ id: c.get('portalAuth').user.id }));

    expect((await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    await advanceEpoch(user.id);
    expect((await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(portalSessions.has(token)).toBe(false);
  });

  it('rejects and removes a stale client-AI Redis session before opening its org context', async () => {
    const user = await seedPortalUser();
    const token = `client-ai-${randomUUID()}`;
    const redis = getTestRedis();
    await redis.set(
      CLIENT_AI_REDIS_KEYS.session(token),
      JSON.stringify({ portalUserId: user.id, orgId: user.orgId, authEpoch: user.authEpoch, createdAt: new Date().toISOString() })
    );
    await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
    await advanceEpoch(user.id);
    const app = new Hono();
    app.use('*', clientAiAuthMiddleware);
    app.get('/protected', () => new Response('downstream'));

    const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });

    expect(res.status).toBe(401);
    expect(await redis.get(CLIENT_AI_REDIS_KEYS.session(token))).toBeNull();
    expect(await redis.sismember(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token)).toBe(0);
  });

  it('fails closed when a session claims the wrong organization', async () => {
    const user = await seedPortalUser();
    const other = await createOrganization({ partnerId: (await createPartner()).id });
    const token = `portal-cross-org-${randomUUID()}`;
    portalSessions.set(token, {
      token,
      portalUserId: user.id,
      orgId: other.id,
      authEpoch: user.authEpoch,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = new Hono();
    app.use('*', portalAuthMiddleware);
    app.get('/protected', () => new Response('downstream'));

    expect((await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});
