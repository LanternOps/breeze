import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../services/llm/llmConfigResolver', async (original) => ({
  ...await original<object>(),
  resolveLlmConfigForOrg: vi.fn(async () => ({ source: 'platform', apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
}));
// The SDK transport must never run here: a real model call is a test bug.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('SDK transport must not run in this suite'); }, tool: () => ({}), createSdkMcpServer: () => ({}) }));

import { aiRoutes } from '../../routes/ai';
import { aiSessions, aiToolExecutions, auditLogs, organizationUsers } from '../../db/schema';
import { clearPermissionCache } from '../../services/permissions';
import { createAccessToken } from '../../services/jwt';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * M4-D2 for the AI admin analytics reads (real Postgres, real routes): a
 * site-B-restricted holder of ai_sessions:read_all must not learn anything —
 * session id, tool arguments (site/node ids), counts, per-tool stats or audit
 * rows — about a topology session pinned to site A. The site filter runs in
 * SQL before aggregation and LIMIT; unpinned sessions are unaffected.
 */
const PERMS = [
  { resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' },
  { resource: 'ai_sessions', action: 'use' }, { resource: 'ai_sessions', action: 'read_all' },
];

async function mfaToken(env: TestEnvironment) {
  return createAccessToken({ sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID() });
}

async function insertSessionWithExecution(env: TestEnvironment, siteId: string | null, toolName: string) {
  const db = getTestDb();
  const [session] = await db.insert(aiSessions).values({
    orgId: env.organization.id, userId: env.user.id, title: `s-${toolName}`, type: siteId ? 'topology' : 'general', topologySiteId: siteId,
  }).returning();
  await db.insert(aiToolExecutions).values({
    sessionId: session!.id, toolName, toolInput: { site_id: siteId, node_id: `node-of-${toolName}` }, status: 'completed',
  });
  await db.insert(auditLogs).values({
    orgId: env.organization.id, actorType: 'user', actorId: env.user.id, action: `ai.tool.${toolName}`,
    resourceType: 'ai_session', resourceId: session!.id, result: 'success', details: { sessionId: session!.id, toolInput: { site_id: siteId } },
  });
  return session!.id;
}

async function restrict(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb().update(organizationUsers).set({ siteIds })
    .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
  await clearPermissionCache(env.user.id);
}

describe('AI admin analytics topology site isolation (M4-D2, real DB)', () => {
  let env: TestEnvironment;
  let ids: { a: string; b: string; general: string };
  let token: string;
  const app = () => new Hono().route('/ai', aiRoutes);
  const get = async <T>(path: string): Promise<T> => {
    const res = await app().request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return await res.json() as T;
  };

  beforeEach(async () => {
    env = await setupTestEnvironment({ rolePermissions: PERMS });
    const siteB = await createSite({ orgId: env.organization.id });
    ids = {
      a: await insertSessionWithExecution(env, env.site.id, 'get_topology'),
      b: await insertSessionWithExecution(env, siteB.id, 'get_link_health'),
      general: await insertSessionWithExecution(env, null, 'query_devices'),
    };
    token = await mfaToken(env);
    await restrict(env, [siteB.id]);
  });

  it('tool-executions: a site-A topology session never appears in the list, counts or per-tool stats', async () => {
    type Body = { summary: { total: number; byTool: Array<{ toolName: string }> }; executions: Array<{ sessionId: string }> };
    const body = await get<Body>(`/ai/admin/tool-executions?orgId=${env.organization.id}`);
    expect(body.executions.map((e) => e.sessionId).sort()).toEqual([ids.b, ids.general].sort());
    expect(body.summary.total).toBe(2);
    expect(body.summary.byTool.map((t) => t.toolName).sort()).toEqual(['get_link_health', 'query_devices']);
  });

  it('security-events: an audit row about a site-A topology session is withheld', async () => {
    const body = await get<{ data: Array<{ resourceId: string }> }>(`/ai/admin/security-events?orgId=${env.organization.id}`);
    expect(body.data.map((e) => e.resourceId).sort()).toEqual([ids.b, ids.general].sort());
  });

  it('an unrestricted topology reader still sees every session', async () => {
    await restrict(env, null);
    const body = await get<{ executions: Array<{ sessionId: string }> }>(`/ai/admin/tool-executions?orgId=${env.organization.id}`);
    expect(body.executions).toHaveLength(3);
  });
});
