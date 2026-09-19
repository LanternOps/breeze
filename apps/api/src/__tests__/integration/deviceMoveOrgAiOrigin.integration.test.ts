/**
 * Integration test: the moveOrg ROUTE's own AI-origin detach mirror (#5789).
 *
 * 2026-10-16-182100-ai-origin-attribution.sql ships TWO convergent copies of
 * the same statement: a Postgres trigger (`breeze_cascade_device_org_id()`,
 * fired by any direct `devices.org_id` UPDATE, proven live by
 * `aiOriginAttribution.integration.test.ts`'s "detaches AI origin pointers on
 * device move" case) and a route-local mirror inside
 * `routes/devices/moveOrg.ts` (in case the trigger is ever dropped, and so the
 * detach is visible where the move is read). Before this file, the route
 * mirror was pinned only by `moveOrg.coverage.test.ts`'s static source scan —
 * nothing drove it against a real database through the real route.
 *
 * Mirrors `deviceMoveOrgAlertChildren.integration.test.ts`'s harness: mount
 * `moveOrgRoutes`, POST through it, read back with the admin pool.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { aiSessions, devices, scriptExecutions, scripts } from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed() {
  const adminDb = getTestDb() as any;
  const unique = uid();

  const env = await setupTestEnvironment({ scope: 'partner' });
  const { partner, organization: orgA, site: siteA, user, role } = env;

  const orgB = await createOrganization({ partnerId: partner.id });
  const siteB = await createSite({ orgId: orgB.id });

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `move-ai-origin-agent-${unique}`,
    hostname: `move-ai-origin-host-${unique}`,
    osType: 'linux',
    osVersion: '22.04',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning();

  const [script] = await adminDb.insert(scripts).values({
    orgId: orgA.id,
    name: `Move AI Origin Script ${unique}`,
    language: 'bash',
    content: 'echo hello',
    osTypes: ['linux'],
    runAs: 'system',
    timeoutSeconds: 60,
    createdBy: user.id,
  }).returning();

  const [session] = await adminDb.insert(aiSessions).values({
    orgId: orgA.id,
    userId: user.id,
    deviceId: device.id,
    type: 'general',
  }).returning();

  // ai_agent_run_id is a bare uuid (no FK — see the column's own doc comment
  // in db/schema/scripts.ts), so a fixture run id needs no ai_agent_runs row.
  const agentRunId = randomUUID();

  const [execution] = await adminDb.insert(scriptExecutions).values({
    scriptId: script.id,
    deviceId: device.id,
    orgId: orgA.id,
    triggeredBy: user.id,
    status: 'completed',
    aiInitiatorKind: 'ai_agent',
    aiSessionId: session.id,
    aiAgentRunId: agentRunId,
  }).returning();

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  // Move-org step-up (spec 2026-09-18 W01): the route requires a fresh grant; mint one for exactly this request.
  const move = async () =>
    app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, device.id, { orgId: orgB.id, siteId: siteB.id })),
    });

  return { adminDb, orgA, orgB, device, execution, session, agentRunId, move };
}

describe('POST /devices/:id/move-org — AI origin detach (#5789)', () => {
  it('retains ai_initiator_kind but nulls both cross-tenant AI origin pointers, through the real route', async () => {
    const f = await seed();

    const res = await f.move();
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const [after] = await f.adminDb
      .select({
        orgId: scriptExecutions.orgId,
        kind: scriptExecutions.aiInitiatorKind,
        sessionId: scriptExecutions.aiSessionId,
        runId: scriptExecutions.aiAgentRunId,
      })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, f.execution.id));

    expect(after).toMatchObject({
      // The row itself followed the device (denormalized org_id, generic
      // CORE_DEVICE_ORG_DENORMALIZED_TABLES loop).
      orgId: f.orgB.id,
      // The fact that an AI did the work survives the move…
      kind: 'ai_agent',
      // …but the pointers into the SOURCE org's ai_sessions / ai_agent_runs
      // do not, or /devices/:id/scripts would serve a foreign id to orgB.
      sessionId: null,
      runId: null,
    });
  });
});
