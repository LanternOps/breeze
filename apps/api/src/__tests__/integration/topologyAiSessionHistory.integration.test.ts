import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

vi.mock('../../services/llm/llmConfigResolver', async (original) => ({
  ...await original<object>(),
  resolveLlmConfigForOrg: vi.fn(async () => ({ source: 'platform', apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
}));

import { authMiddleware } from '../../middleware/auth';
import { getSession, getSessionMessages, listSessions, searchSessions } from '../../services/aiAgent';
import { getSessionHistory } from '../../services/aiCostTracker';
import { clearPermissionCache } from '../../services/permissions';
import { resolveTopologySessionVisibility } from '../../services/topology/aiSessionAccess';
import { aiMessages, aiSessions, organizationUsers } from '../../db/schema';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * M4-D2 against real Postgres: a pinned topology session is visible — in a
 * list page, a search, a detail/message read or the admin history — only to a
 * caller who can currently read its site. The site filter runs in SQL before
 * LIMIT/OFFSET, so an inaccessible session never takes a page slot, and a
 * revoked site turns replay/history reads into "not found".
 */
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }, { resource: 'ai_sessions', action: 'use' }];

function app() {
  return new Hono().use('*', authMiddleware)
    .get('/list', async (c) => c.json(await listSessions(c.get('auth'), { page: Number(c.req.query('page') ?? 1), limit: Number(c.req.query('limit') ?? 20) })))
    .get('/search', async (c) => c.json(await searchSessions(c.get('auth'), c.req.query('q')!, { limit: 20 })))
    .get('/session/:id', async (c) => c.json({ session: await getSession(c.req.param('id'), c.get('auth')) }))
    .get('/messages/:id', async (c) => c.json(await getSessionMessages(c.req.param('id'), c.get('auth'))))
    .get('/admin', async (c) => c.json(await getSessionHistory(c.get('auth').orgId!, { limit: 50 }, await resolveTopologySessionVisibility(c.get('auth')))));
}
const get = async <T>(env: TestEnvironment, path: string): Promise<T> => {
  const res = await app().request(path, { headers: { Authorization: `Bearer ${env.token}` } });
  expect(res.status).toBe(200);
  return await res.json() as T;
};

async function insertSession(env: TestEnvironment, title: string, siteId: string | null, minutesAgo: number) {
  const [row] = await getTestDb().insert(aiSessions).values({
    orgId: env.organization.id, userId: env.user.id, title, type: siteId ? 'topology' : 'general', topologySiteId: siteId,
    lastActivityAt: new Date(Date.now() - minutesAgo * 60_000),
  }).returning();
  await getTestDb().insert(aiMessages).values({ sessionId: row!.id, role: 'assistant', content: `answer for ${title}` });
  return row!.id;
}

async function restrict(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb().update(organizationUsers).set({ siteIds })
    .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
  await clearPermissionCache(env.user.id);
}

describe('topology session history site isolation (M4-D2, real DB)', () => {
  let env: TestEnvironment;
  let siteB: { id: string };
  let ids: { a: string; b: string; general: string };

  beforeEach(async () => {
    env = await setupTestEnvironment({ rolePermissions: [...READ, { resource: 'ai_sessions', action: 'read_all' }] });
    siteB = await createSite({ orgId: env.organization.id });
    // Most recent first: A (site A) is the NEWEST, so a post-limit filter would leak an empty/short page.
    ids = {
      a: await insertSession(env, 'topology site-a secret', env.site.id, 1),
      b: await insertSession(env, 'topology site-b', siteB.id, 2),
      general: await insertSession(env, 'general chat topology', null, 3),
    };
  });

  it('shows every session to an unrestricted topology reader', async () => {
    expect((await get<Array<{ id: string }>>(env, '/list')).map((s) => s.id)).toEqual([ids.a, ids.b, ids.general]);
  });

  it('filters BEFORE pagination: a site-B user\'s first page is B, not an empty slot where A was', async () => {
    await restrict(env, [siteB.id]);
    expect((await get<Array<{ id: string }>>(env, '/list?limit=1&page=1')).map((s) => s.id)).toEqual([ids.b]);
    expect((await get<Array<{ id: string }>>(env, '/list?limit=1&page=2')).map((s) => s.id)).toEqual([ids.general]);
    expect((await get<Array<{ id: string }>>(env, '/list')).map((s) => s.id)).toEqual([ids.b, ids.general]);
  });

  it('search, detail, messages and admin history never reveal a session pinned to an unreadable site', async () => {
    await restrict(env, [siteB.id]);
    const titles = (await get<Array<{ id: string }>>(env, '/search?q=topology')).map((s) => s.id);
    expect(titles).toEqual(expect.arrayContaining([ids.b, ids.general]));
    expect(titles).not.toContain(ids.a);
    expect((await get<Array<{ id: string }>>(env, '/search?q=site-a%20secret'))).toEqual([]);
    expect((await get<Array<{ id: string }>>(env, '/search?q=answer%20for%20topology%20site-a'))).toEqual([]);
    expect((await get<{ session: unknown }>(env, `/session/${ids.a}`)).session).toBeNull();
    expect(await get<unknown>(env, `/messages/${ids.a}`)).toBeNull();
    expect((await get<{ session: { id: string } }>(env, `/session/${ids.b}`)).session.id).toBe(ids.b);
    const admin = (await get<Array<{ id: string }>>(env, '/admin')).map((s) => s.id);
    expect(admin).toEqual(expect.arrayContaining([ids.b, ids.general]));
    expect(admin).not.toContain(ids.a);
  });

  it('losing topology:read hides every pinned session, but never a general one', async () => {
    await getTestDb().execute(sql`DELETE FROM role_permissions WHERE role_id = ${env.role.id}::uuid
      AND permission_id IN (SELECT id FROM permissions WHERE resource = 'topology')`);
    await clearPermissionCache(env.user.id);
    expect((await get<Array<{ id: string }>>(env, '/list')).map((s) => s.id)).toEqual([ids.general]);
    expect((await get<{ session: unknown }>(env, `/session/${ids.b}`)).session).toBeNull();
  });
});
