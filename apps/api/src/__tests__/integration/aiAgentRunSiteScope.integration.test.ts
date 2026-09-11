/** Real-PostgreSQL route proof for AI-agent run site visibility. */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { aiAgentRuns, aiAgents, devices, organizationUsers } from '../../db/schema';
import { aiAgentsRoutes } from '../../routes/aiAgents';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient, createSite, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makeApp() {
  const app = new Hono();
  app.route('/ai-agents', aiAgentsRoutes);
  return app;
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb().update(organizationUsers).set({ siteIds }).where(and(
    eq(organizationUsers.userId, env.user.id),
    eq(organizationUsers.orgId, env.organization.id),
  ));
  await clearPermissionCache(env.user.id);
}

async function seedDevice(orgId: string, siteId: string, label: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `run-scope-${label}-${randomUUID().slice(0, 8)}`,
    hostname: `run-scope-${label}`,
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
    status: 'online',
  }).returning();
  if (!device) throw new Error('device fixture insert failed');
  return device;
}

async function seedRun(args: {
  agentId: string;
  orgId: string;
  deviceId: string | null;
  label: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  queuedAt: Date;
}) {
  const [run] = await getTestDb().insert(aiAgentRuns).values({
    agentId: args.agentId,
    orgId: args.orgId,
    deviceId: args.deviceId,
    triggerKind: 'manual',
    dedupeKey: `site-scope:${args.label}:${randomUUID()}`,
    modeAtStart: 'shadow',
    policySnapshot: { schemaVersion: 1 } as never,
    status: args.status ?? 'completed',
    summary: `private-${args.label}`,
    outcome: {},
    queuedAt: args.queuedAt,
  }).returning();
  if (!run) throw new Error('run fixture insert failed');
  return run;
}

describe('AI-agent run routes honor the current device site (real PostgreSQL as breeze_app)', () => {
  runDb('filters before pagination/latest selection and denies hidden, null, deleted, and moved-out detail', async () => {
    const app = makeApp();
    const reader = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'ai_agents', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: reader.env.organization.id });
    const visibleDevice = await seedDevice(reader.env.organization.id, reader.env.site.id, 'visible');
    const hiddenDevice = await seedDevice(reader.env.organization.id, hiddenSite.id, 'hidden');
    const deletedDevice = await seedDevice(reader.env.organization.id, reader.env.site.id, 'deleted');

    const [agent] = await getTestDb().insert(aiAgents).values({
      orgId: reader.env.organization.id,
      partnerId: null,
      kind: 'triage',
      name: 'Site-scoped triage',
      createdBy: reader.env.user.id,
    }).returning();
    if (!agent) throw new Error('agent fixture insert failed');

    const visible = await seedRun({
      agentId: agent.id, orgId: reader.env.organization.id, deviceId: visibleDevice.id,
      label: 'visible', status: 'failed', queuedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const visibleOlder = await seedRun({
      agentId: agent.id, orgId: reader.env.organization.id, deviceId: visibleDevice.id,
      label: 'visible-older', queuedAt: new Date('2026-08-31T00:00:00Z'),
    });
    const hidden = await seedRun({
      agentId: agent.id, orgId: reader.env.organization.id, deviceId: hiddenDevice.id,
      label: 'hidden', queuedAt: new Date('2026-09-03T00:00:00Z'),
    });
    const deviceLess = await seedRun({
      agentId: agent.id, orgId: reader.env.organization.id, deviceId: null,
      label: 'device-less', queuedAt: new Date('2026-09-04T00:00:00Z'),
    });
    const deleted = await seedRun({
      agentId: agent.id, orgId: reader.env.organization.id, deviceId: deletedDevice.id,
      label: 'deleted', queuedAt: new Date('2026-09-05T00:00:00Z'),
    });
    await getTestDb().delete(devices).where(eq(devices.id, deletedDevice.id));

    // Unrestricted is the positive control and preserves every surviving run.
    const unrestricted = await reader.get('/ai-agents/runs?limit=10');
    expect(unrestricted.status).toBe(200);
    const unrestrictedIds = (await unrestricted.json() as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([
      visible.id, visibleOlder.id, hidden.id, deviceLess.id, deleted.id,
    ]));

    await restrictUserToSites(reader.env, [reader.env.site.id]);

    // Hidden/newer rows are removed in SQL before LIMIT, so the visible older
    // row still fills a one-row page and is the settings page's latest run.
    const page = await reader.get('/ai-agents/runs?limit=1');
    expect(page.status).toBe(200);
    const firstPage = await page.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(firstPage.data).toEqual([expect.objectContaining({ id: visible.id, summaryExcerpt: 'private-visible' })]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPageResponse = await reader.get(
      `/ai-agents/runs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(secondPageResponse.status).toBe(200);
    expect(await secondPageResponse.json()).toEqual({
      data: [expect.objectContaining({ id: visibleOlder.id, summaryExcerpt: 'private-visible-older' })],
      nextCursor: null,
    });

    const history = await reader.get(`/ai-agents/${agent.id}/runs?limit=10`);
    expect(history.status).toBe(200);
    expect((await history.json() as { data: Array<{ id: string }> }).data.map((r) => r.id))
      .toEqual([visible.id, visibleOlder.id]);

    const agents = await reader.get('/ai-agents');
    expect(agents.status).toBe(200);
    const agentDto = (await agents.json() as { data: Array<{ id: string; lastRunStatus: string | null }> })
      .data.find((row) => row.id === agent.id);
    expect(agentDto).toMatchObject({ id: agent.id, lastRunStatus: 'failed' });

    expect((await reader.get(`/ai-agents/runs/${visible.id}`)).status).toBe(200);
    for (const denied of [hidden.id, deviceLess.id, deleted.id]) {
      expect((await reader.get(`/ai-agents/runs/${denied}`)).status, denied).toBe(404);
    }

    // Current-device semantics: moving the formerly visible device outside
    // the allowlist immediately makes its historical run opaque.
    await getTestDb().update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, visibleDevice.id));
    expect((await reader.get(`/ai-agents/runs/${visible.id}`)).status).toBe(404);
    expect((await (await reader.get('/ai-agents/runs?limit=10')).json() as { data: unknown[] }).data).toEqual([]);

    await restrictUserToSites(reader.env, []);
    expect((await (await reader.get('/ai-agents/runs?limit=10')).json() as { data: unknown[] }).data).toEqual([]);
  });
});
