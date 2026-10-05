/**
 * The Helper token may only reach Helper-created sessions on its own device.
 *
 * A technician's device-bound AI session (`POST /ai/sessions` with a
 * deviceId) carries the technician's userId and the SAME deviceId as the
 * Helper's own sessions. The Helper token lives in agent.yaml, which any
 * local user on the device can read, so matching on deviceId alone let that
 * user list the technician's session, read its transcript (tool output
 * included), post into it, and close or flag it. An AI-agent run's session
 * (agent_id set, user_id NULL) is the same shape. Every helper session route,
 * and the screenshot route's sessionId, now admits only sessions the Helper
 * created: no principal of any kind and context_snapshot.source = 'helper'.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { inArray, sql } from 'drizzle-orm';
import { aiAgents, aiMessages, aiSessions, devices } from '../../db/schema';
import { helperRoutes } from '../../routes/helper';
import { invalidateAgentTenantCache } from '../../services/tenantStatus';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

// Fail, never skip, when there is no database: a skipped run is not evidence.
const runDb = it;
if (!process.env.DATABASE_URL) throw new Error('helperSessionOwnerScope needs DATABASE_URL (pnpm test-stack up)');
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const app = new Hono();
app.route('/helper', helperRoutes);

const seededSessionIds: string[] = [];
const seededAgentIds: string[] = [];
afterAll(async () => {
  if (seededSessionIds.length === 0) return;
  const adminDb = getTestDb() as any;
  await adminDb.execute(sql`DELETE FROM ai_screenshots WHERE session_id IN (${sql.join(seededSessionIds.map((id) => sql`${id}`), sql`, `)})`).catch(() => undefined);
  await adminDb.delete(aiMessages).where(inArray(aiMessages.sessionId, seededSessionIds));
  await adminDb.delete(aiSessions).where(inArray(aiSessions.id, seededSessionIds));
  if (seededAgentIds.length > 0) await adminDb.delete(aiAgents).where(inArray(aiAgents.id, seededAgentIds));
});

async function seed() {
  const partner = await createPartner();
  // Helper enabled: helperAuth refuses a device whose Helper is disabled.
  const org = await createOrganization({ partnerId: partner.id, settings: { helper: { enabled: true } } });
  const site = await createSite({ orgId: org.id });
  const tech = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@example.com` });
  const token = `brz_helper_${randomUUID().replace(/-/g, '')}`;
  const adminDb = getTestDb() as any;
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `helper-scope-${randomUUID()}`,
      agentTokenHash: digest(`${token}-agent`),
      helperTokenHash: digest(token),
      hostname: `helper-scope-${randomUUID()}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  await invalidateAgentTenantCache([org.id]);

  const [techSession] = await adminDb
    .insert(aiSessions)
    .values({ orgId: org.id, userId: tech.id, deviceId: device.id, title: 'technician session', status: 'active', model: 'claude-sonnet-5-5' })
    .returning({ id: aiSessions.id });
  const [helperSession] = await adminDb
    .insert(aiSessions)
    .values({ orgId: org.id, userId: null, deviceId: device.id, title: 'helper session', status: 'active', model: 'claude-sonnet-5-5', contextSnapshot: { source: 'helper' } })
    .returning({ id: aiSessions.id });
  const [agent] = await adminDb
    .insert(aiAgents)
    .values({ kind: 'triage', name: `helper-scope-${randomUUID()}`, orgId: org.id, partnerId: null, createdBy: tech.id })
    .returning({ id: aiAgents.id });
  const [agentSession] = await adminDb
    .insert(aiSessions)
    .values({ orgId: org.id, userId: null, agentId: agent.id, type: 'agent', deviceId: device.id, title: 'agent run', status: 'active', model: 'claude-sonnet-5-5' })
    .returning({ id: aiSessions.id });
  // No principal, but not created by the Helper (e.g. an MCP session).
  const [otherSession] = await adminDb
    .insert(aiSessions)
    .values({ orgId: org.id, userId: null, deviceId: device.id, title: 'no-principal, not helper', status: 'active', model: 'claude-sonnet-5-5' })
    .returning({ id: aiSessions.id });
  seededSessionIds.push(techSession.id, helperSession.id, agentSession.id, otherSession.id);
  seededAgentIds.push(agent.id);
  await adminDb.insert(aiMessages).values([
    { sessionId: techSession.id, role: 'assistant', content: 'technician-only transcript' },
    { sessionId: helperSession.id, role: 'assistant', content: 'helper transcript' },
  ]);

  return {
    token,
    techSessionId: techSession.id as string,
    helperSessionId: helperSession.id as string,
    foreignSessionIds: [techSession.id, agentSession.id, otherSession.id] as string[],
  };
}

const statusOf = async (id: string) => {
  const [row] = await (getTestDb() as any)
    .select({ status: aiSessions.status, flaggedAt: aiSessions.flaggedAt })
    .from(aiSessions)
    .where(sql`id = ${id}`);
  return row as { status: string; flaggedAt: Date | null };
};

describe('helper session routes are scoped to Helper-created sessions (real PostgreSQL)', () => {
  runDb('a technician session bound to the same device is invisible and untouchable', async () => {
    const { token, techSessionId, helperSessionId } = await seed();
    const auth = { Authorization: `Bearer ${token}` };
    const json = { ...auth, 'Content-Type': 'application/json' };

    const list = await app.request('/helper/chat/sessions', { headers: auth });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(listed).toContain(helperSessionId);
    expect(listed).not.toContain(techSessionId);

    const read = await app.request(`/helper/chat/sessions/${techSessionId}/messages`, { headers: auth });
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('technician-only transcript');

    const post = await app.request(`/helper/chat/sessions/${techSessionId}/messages`, {
      method: 'POST', headers: json, body: JSON.stringify({ content: 'injected' }),
    });
    expect(post.status).toBe(404);

    const flag = await app.request(`/helper/chat/sessions/${techSessionId}/flag`, {
      method: 'POST', headers: json, body: JSON.stringify({ reason: 'x' }),
    });
    expect(flag.status).toBe(404);

    const close = await app.request(`/helper/chat/sessions/${techSessionId}`, { method: 'DELETE', headers: auth });
    expect(close.status).toBe(404);

    const after = await statusOf(techSessionId);
    expect(after.status).toBe('active');
    expect(after.flaggedAt).toBeNull();
    const [{ count }] = await (getTestDb() as any).execute(
      sql`SELECT count(*)::int AS count FROM ai_messages WHERE session_id = ${techSessionId}`,
    );
    expect(count).toBe(1);
  });

  runDb('an AI-agent run session and a no-principal non-Helper session on the device are equally out of reach', async () => {
    const { token, foreignSessionIds } = await seed();
    const auth = { Authorization: `Bearer ${token}` };
    const json = { ...auth, 'Content-Type': 'application/json' };
    const listed = ((await (await app.request('/helper/chat/sessions', { headers: auth })).json()) as Array<{ id: string }>).map((s) => s.id);
    for (const id of foreignSessionIds) {
      expect(listed).not.toContain(id);
      expect((await app.request(`/helper/chat/sessions/${id}/messages`, { headers: auth })).status).toBe(404);
      expect((await app.request(`/helper/chat/sessions/${id}/flag`, { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
      // Refused at the ownership check, not later as an unknown tool call.
      const toolResult = await app.request(`/helper/chat/sessions/${id}/tool-results`, {
        method: 'POST', headers: json, body: JSON.stringify({ toolUseId: 'tu-1', output: 'not-owner' }),
      });
      expect(toolResult.status).toBe(404);
      expect(await toolResult.json()).toEqual({ error: 'Session not found' });
      expect((await app.request(`/helper/chat/sessions/${id}`, { method: 'DELETE', headers: auth })).status).toBe(404);
      expect((await statusOf(id)).status).toBe('active');
    }
  });

  runDb('a screenshot cannot be attached to a session the Helper did not create', async () => {
    const { token, foreignSessionIds } = await seed();
    const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const sessionId of foreignSessionIds) {
      const res = await app.request('/helper/screenshots', {
        method: 'POST', headers: json,
        body: JSON.stringify({ imageBase64: Buffer.from('x').toString('base64'), width: 1, height: 1, sessionId }),
      });
      expect(res.status).toBe(404);
    }
  });

  runDb("the Helper's own session on the device still works", async () => {
    const { token, helperSessionId } = await seed();
    const auth = { Authorization: `Bearer ${token}` };

    const read = await app.request(`/helper/chat/sessions/${helperSessionId}/messages`, { headers: auth });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('helper transcript');

    const flag = await app.request(`/helper/chat/sessions/${helperSessionId}/flag`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
    });
    expect(flag.status).toBe(200);

    const shot = await app.request('/helper/screenshots', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: Buffer.from('x').toString('base64'), width: 1, height: 1, sessionId: helperSessionId }),
    });
    expect(shot.status).toBe(200);
    const [{ count: shots }] = await (getTestDb() as any).execute(
      sql`SELECT count(*)::int AS count FROM ai_screenshots WHERE session_id = ${helperSessionId}`,
    );
    expect(shots).toBe(1);

    const close = await app.request(`/helper/chat/sessions/${helperSessionId}`, { method: 'DELETE', headers: auth });
    expect(close.status).toBe(200);
    expect((await statusOf(helperSessionId)).status).toBe('closed');
  });
});
