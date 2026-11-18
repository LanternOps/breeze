/**
 * #9517: the agent's elevation-unable report through the real agent router,
 * agentAuthMiddleware (token hash lookup, path agent check, self-managed DB
 * context), the route's own org-scoped context as breeze_app, and the commit.
 * The unit test mocks the service and the agent context; the service
 * integration tests call recordElevationDeviceUnable directly. This one sends
 * the HTTP request an agent sends.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/pamElevationUnableRoute.integration.test.ts
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { devices } from '../../db/schema';
import { elevationAudit, elevationRequests } from '../../db/schema/elevations';
import { agentRoutes } from '../../routes/agents';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

function buildAgentApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/agents', agentRoutes);
  return app;
}

type Agent = { orgId: string; siteId: string; partnerId: string; deviceId: string; agentId: string; token: string };

async function seedAgent(tag: string, org?: { orgId: string; siteId: string; partnerId: string }): Promise<Agent> {
  const scope = org ?? await (async () => {
    const partner = await createPartner({ status: 'active' });
    const o = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: o.id });
    return { orgId: o.id, siteId: site.id, partnerId: partner.id };
  })();
  const suffix = randomUUID().slice(0, 8);
  const agentId = `agent-9517-route-${tag}-${suffix}`;
  const token = `brz_9517_${tag}_${suffix}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: scope.orgId,
      siteId: scope.siteId,
      agentId,
      hostname: `rds-9517-${tag}-${suffix}`,
      osType: 'windows',
      osVersion: '10.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      agentTokenHash: createHash('sha256').update(token).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  return { ...scope, deviceId: device!.id, agentId, token };
}

async function seedPendingUac(a: Agent): Promise<string> {
  const [row] = await getTestDb()
    .insert(elevationRequests)
    .values({
      orgId: a.orgId,
      siteId: a.siteId,
      partnerId: a.partnerId,
      deviceId: a.deviceId,
      deviceEpoch: currentOwnershipEpochSql(a.deviceId),
      flowType: 'uac_intercept',
      subjectUsername: 'RDS\\enduser',
      reason: 'UAC consent UI observed for C:\\Temp\\setup.exe',
      targetExecutablePath: 'C:\\Temp\\setup.exe',
      status: 'pending',
    })
    .returning({ id: elevationRequests.id });
  return row!.id;
}

function report(a: Agent, elevationRequestId: string, opts: { pathAgentId?: string; token?: string } = {}) {
  return buildAgentApp().request(`/api/v1/agents/${opts.pathAgentId ?? a.agentId}/pam/elevation-unable`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token ?? a.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      elevationRequestId,
      reason: 'session_unavailable',
      detail: 'session 3 cannot host a SYSTEM helper (not active or connected)',
    }),
  });
}

async function readRequest(id: string) {
  const [row] = await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.id, id));
  return row!;
}

describe('POST /agents/:id/pam/elevation-unable through agent auth (#9517)', () => {
  let agent: Agent;

  beforeEach(async () => {
    agent = await seedAgent('a');
  });

  it('closes the reporting device\'s pending request and audits it', async () => {
    const id = await seedPendingUac(agent);

    const res = await report(agent, id);

    expect(res.status).toBe(200);
    const row = await readRequest(id);
    expect(row.status).toBe('expired');
    expect(row.deviceUnableReason).toBe('session_unavailable');
    expect(row.deviceUnableDetail).toBe('session 3 cannot host a SYSTEM helper (not active or connected)');
    expect(row.deviceUnableAt).not.toBeNull();
    const audit = await getTestDb()
      .select({ eventType: elevationAudit.eventType })
      .from(elevationAudit)
      .where(eq(elevationAudit.elevationRequestId, id))
      .orderBy(asc(elevationAudit.createdAt));
    expect(audit.map((a) => a.eventType)).toEqual(['device_unable', 'expired']);
  });

  it('rejects a bad agent token before touching the request', async () => {
    const id = await seedPendingUac(agent);

    const res = await report(agent, id, { token: `${agent.token}-wrong` });

    expect(res.status).toBe(401);
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('rejects a path that names a different agent', async () => {
    const other = await seedAgent('b', agent);
    const id = await seedPendingUac(agent);

    const res = await report(agent, id, { pathAgentId: other.agentId });

    expect([401, 403]).toContain(res.status);
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('does not let another device in the same org close the request', async () => {
    const other = await seedAgent('c', agent);
    const id = await seedPendingUac(agent);

    const res = await report(other, id);

    expect(res.status).toBe(404);
    const row = await readRequest(id);
    expect(row.status).toBe('pending');
    expect(row.deviceUnableAt).toBeNull();
    // Positive control: the same route closes it for the owning device.
    expect((await report(agent, id)).status).toBe(200);
    expect((await readRequest(id)).status).toBe('expired');
  });

  it('does not let a device in another org close the request', async () => {
    const stranger = await seedAgent('d');
    const id = await seedPendingUac(agent);

    const res = await report(stranger, id);

    expect(res.status).toBe(404);
    expect((await readRequest(id)).status).toBe('pending');
    expect((await report(agent, id)).status).toBe(200);
  });
});
