import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

vi.mock('../../services/llm/llmConfigResolver', async (original) => ({
  ...await original<object>(),
  resolveLlmConfigForOrg: vi.fn(async () => ({ source: 'platform', apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
}));

import { aiMessages, aiSessions, aiToolExecutions, auditLogs, organizations, sites } from '../../db/schema';
import { orgRoutes } from '../../routes/orgs';
import { createAccessToken } from '../../services/jwt';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * Topology M4-D2 follow-up (#6000): `ai_sessions.topology_site_id` pins an
 * investigation to its site with a no-action FK, so deleting a site that has
 * topology sessions used to abort with 23503 → HTTP 500. The site's topology
 * sessions (and their messages / tool executions) are deleted in the SAME
 * site-delete transaction and audited with counts; general sessions and other
 * sites' investigations are untouched.
 */
const GRANTS = [
  { resource: 'sites', action: 'read' }, { resource: 'sites', action: 'write' },
  { resource: 'organizations', action: 'read' }, { resource: 'organizations', action: 'write' },
];

async function seedSession(orgId: string, userId: string, siteId: string | null) {
  const db = getTestDb();
  const [session] = await db.insert(aiSessions).values({
    orgId, userId, ...(siteId ? { type: 'topology', topologySiteId: siteId } : {}),
  }).returning({ id: aiSessions.id });
  const [message] = await db.insert(aiMessages).values({ sessionId: session!.id, role: 'user', content: 'why is the uplink down?' })
    .returning({ id: aiMessages.id });
  await db.insert(aiToolExecutions).values({ sessionId: session!.id, messageId: message!.id, toolName: 'get_topology', toolInput: {}, status: 'completed' });
  return session!.id;
}

describe('DELETE /orgs/sites/:id with topology investigations (real DB)', () => {
  it('deletes the site with its topology sessions in one transaction, audits the counts, and leaves everything else alone', async () => {
    const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
    const db = getTestDb();
    await db.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, ai: true } } }).where(eq(organizations.id, env.organization.id));
    const doomed = await createSite({ orgId: env.organization.id });
    const kept = await createSite({ orgId: env.organization.id });
    const doomedSessions = [await seedSession(env.organization.id, env.user.id, doomed.id), await seedSession(env.organization.id, env.user.id, doomed.id)];
    const keptTopology = await seedSession(env.organization.id, env.user.id, kept.id);
    const general = await seedSession(env.organization.id, env.user.id, null);

    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
      scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono().route('/orgs', orgRoutes);
    const res = await app.request(`/orgs/sites/${doomed.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await db.select().from(sites).where(eq(sites.id, doomed.id))).toHaveLength(0);
    expect(await db.select().from(aiSessions).where(inArray(aiSessions.id, doomedSessions))).toHaveLength(0);
    expect(await db.select().from(aiMessages).where(inArray(aiMessages.sessionId, doomedSessions))).toHaveLength(0);
    expect(await db.select().from(aiToolExecutions).where(inArray(aiToolExecutions.sessionId, doomedSessions))).toHaveLength(0);
    expect(await db.select({ id: aiSessions.id }).from(aiSessions).where(inArray(aiSessions.id, [keptTopology, general]))).toHaveLength(2);
    expect(await db.select().from(aiMessages).where(inArray(aiMessages.sessionId, [keptTopology, general]))).toHaveLength(2);

    await vi.waitFor(async () => {
      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.orgId, env.organization.id), eq(auditLogs.action, 'site.delete'), eq(auditLogs.resourceId, doomed.id)));
      expect(audit?.details).toMatchObject({ topologyInvestigationsDeleted: { investigations: 2, messages: 2, toolExecutions: 2, actionPlans: 0, screenshots: 0 } });
    });
  });
});
