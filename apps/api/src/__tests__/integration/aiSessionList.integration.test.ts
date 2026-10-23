import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { authMiddleware } from '../../middleware/auth';
import { listSessions, searchSessions } from '../../services/aiAgent';
import { aiMessages, aiSessions } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #9427 W1 T5 against real Postgres (forced RLS, as breeze_app through the
 * real auth middleware): the conversation list and search return only the
 * caller's own CHAT sessions (`general`, `topology`) across every org the
 * caller can reach — never a script-builder or MCP session, never another
 * user's, never one in an org outside the caller's reach — and each row
 * carries its own `orgId`, `type` and `deviceId`.
 */
const NEEDLE = 'quasar-needle';

function app() {
  return new Hono().use('*', authMiddleware)
    .get('/list', async (c) => c.json(await listSessions(c.get('auth'), { limit: 50 })))
    .get('/search', async (c) => c.json(await searchSessions(c.get('auth'), c.req.query('q')!, { limit: 50 })));
}

async function get<T>(env: TestEnvironment, path: string): Promise<T> {
  const res = await app().request(path, { headers: { Authorization: `Bearer ${env.token}` } });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

async function insertSession(values: { orgId: string; userId: string; type: string; title: string; minutesAgo: number; topologySiteId?: string }) {
  const [row] = await getTestDb().insert(aiSessions).values({
    orgId: values.orgId,
    userId: values.userId,
    type: values.type,
    topologySiteId: values.topologySiteId ?? null,
    title: `${values.title} ${NEEDLE}`,
    model: 'claude-sonnet-5-5',
    lastActivityAt: new Date(Date.now() - values.minutesAgo * 60_000),
  }).returning({ id: aiSessions.id });
  await getTestDb().insert(aiMessages).values({ sessionId: row!.id, role: 'user', content: `please check ${NEEDLE} now` });
  return row!.id;
}

type Row = { id: string; orgId: string; type: string; deviceId: string | null; status?: string };

describe('AI session list/search — chat types only, with org/type/device (#9427, real DB)', () => {
  let env: TestEnvironment;
  let orgB: { id: string };
  let ids: Record<'generalA' | 'topologyB' | 'scriptBuilder' | 'mcp' | 'otherUser' | 'foreignOrg', string>;

  beforeEach(async () => {
    // A partner-scope technician with access to every org of the partner.
    env = await setupTestEnvironment({ scope: 'partner' });
    orgB = await createOrganization({ partnerId: env.partner.id });
    // A topology session is pinned to a site (ai_sessions check constraint).
    const siteB = await createSite({ orgId: orgB.id });
    const colleague = await createUser({ partnerId: env.partner.id, orgId: null });
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id });

    ids = {
      generalA: await insertSession({ orgId: env.organization.id, userId: env.user.id, type: 'general', title: 'general in A', minutesAgo: 1 }),
      topologyB: await insertSession({ orgId: orgB.id, userId: env.user.id, type: 'topology', title: 'topology in B', minutesAgo: 2, topologySiteId: siteB.id }),
      scriptBuilder: await insertSession({ orgId: env.organization.id, userId: env.user.id, type: 'script_builder', title: 'script builder', minutesAgo: 3 }),
      mcp: await insertSession({ orgId: orgB.id, userId: env.user.id, type: 'mcp', title: 'mcp', minutesAgo: 4 }),
      otherUser: await insertSession({ orgId: env.organization.id, userId: colleague.id, type: 'general', title: 'colleague', minutesAgo: 5 }),
      foreignOrg: await insertSession({ orgId: foreignOrg.id, userId: env.user.id, type: 'general', title: 'foreign org', minutesAgo: 6 }),
    };
  });

  it('list returns exactly the two chat sessions, across both accessible orgs, with their org/type/device', async () => {
    const rows = await get<Row[]>(env, '/list');
    expect(rows.map((r) => r.id)).toEqual([ids.generalA, ids.topologyB]);
    expect(rows[0]).toMatchObject({ orgId: env.organization.id, type: 'general', deviceId: null });
    expect(rows[1]).toMatchObject({ orgId: orgB.id, type: 'topology', deviceId: null });
  });

  it('search (title and message content) returns the same two, with status/type/org/device', async () => {
    const rows = await get<Row[]>(env, `/search?q=${NEEDLE}`);
    expect(rows.map((r) => r.id).sort()).toEqual([ids.generalA, ids.topologyB].sort());
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.deviceId).toBeNull();
    }
    expect(rows.find((r) => r.id === ids.topologyB)).toMatchObject({ orgId: orgB.id, type: 'topology' });

    // Message-content matches only (the title does not contain this text).
    const content = await get<Row[]>(env, '/search?q=please%20check');
    expect(content.map((r) => r.id).sort()).toEqual([ids.generalA, ids.topologyB].sort());
  });
});
