/** Real-PostgreSQL/Redis route proof for legacy alert correlation authorization. */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { alertCorrelations, alerts, devices, organizationUsers } from '../../db/schema';
import { alertTemplateRoutes } from '../../routes/alertTemplates';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient, createSite, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makeApp() {
  const app = new Hono();
  app.route('/alert-templates', alertTemplateRoutes);
  return app;
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

async function seedDevice(orgId: string, siteId: string, label: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `corr-${label}-${randomUUID().slice(0, 12)}`,
    hostname: `legacy-correlation-${label}`,
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
    status: 'online',
  }).returning();
  if (!device) throw new Error('device fixture insert failed');
  return device;
}

async function seedAlert(orgId: string, deviceId: string, label: string) {
  const [alert] = await getTestDb().insert(alerts).values({
    orgId,
    deviceId,
    severity: 'high',
    title: `private-${label}`,
    message: `private-message-${label}`,
  }).returning();
  if (!alert) throw new Error('alert fixture insert failed');
  return alert;
}

describe('legacy alert correlation permission and site scope (real PostgreSQL/Redis)', () => {
  runDb('denies missing permission and exposes only complete visible-site edges', async () => {
    const app = makeApp();
    const denied = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [],
    });

    for (const [method, path, body] of [
      ['GET', '/alert-templates/correlations', undefined],
      ['GET', '/alert-templates/correlations/groups', undefined],
      ['POST', '/alert-templates/correlations/analyze', { alertIds: [] }],
      ['GET', `/alert-templates/correlations/${randomUUID()}`, undefined],
    ] as const) {
      const response = method === 'POST' ? await denied.post(path, body) : await denied.get(path);
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    const reader = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'alerts', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: reader.env.organization.id });
    const visibleDevice = await seedDevice(reader.env.organization.id, reader.env.site.id, 'visible-a');
    const visibleDevice2 = await seedDevice(reader.env.organization.id, reader.env.site.id, 'visible-b');
    const hiddenDevice = await seedDevice(reader.env.organization.id, hiddenSite.id, 'hidden');
    const visibleAlert = await seedAlert(reader.env.organization.id, visibleDevice.id, 'visible-a');
    const visibleAlert2 = await seedAlert(reader.env.organization.id, visibleDevice2.id, 'visible-b');
    const hiddenAlert = await seedAlert(reader.env.organization.id, hiddenDevice.id, 'hidden');
    const [visibleEdge, hiddenEdge] = await getTestDb().insert(alertCorrelations).values([
      {
        parentAlertId: visibleAlert.id,
        childAlertId: visibleAlert2.id,
        correlationType: 'same-device',
        confidence: '0.90',
      },
      {
        parentAlertId: visibleAlert.id,
        childAlertId: hiddenAlert.id,
        correlationType: 'temporal',
        confidence: '0.99',
      },
    ]).returning();
    if (!visibleEdge || !hiddenEdge) throw new Error('correlation fixture insert failed');

    const foreign = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'alerts', action: 'read' }],
    });
    const foreignDeviceA = await seedDevice(foreign.env.organization.id, foreign.env.site.id, 'foreign-a');
    const foreignDeviceB = await seedDevice(foreign.env.organization.id, foreign.env.site.id, 'foreign-b');
    const foreignAlertA = await seedAlert(foreign.env.organization.id, foreignDeviceA.id, 'foreign-a');
    const foreignAlertB = await seedAlert(foreign.env.organization.id, foreignDeviceB.id, 'foreign-b');
    const [foreignEdge] = await getTestDb().insert(alertCorrelations).values({
      parentAlertId: foreignAlertA.id,
      childAlertId: foreignAlertB.id,
      correlationType: 'foreign-control',
      confidence: '1.00',
    }).returning();
    if (!foreignEdge) throw new Error('foreign correlation fixture insert failed');

    // Null siteIds is the unrestricted control and must preserve both edges.
    const unrestricted = await reader.get('/alert-templates/correlations');
    expect(unrestricted.status).toBe(200);
    const unrestrictedIds = (await unrestricted.json() as { data: Array<{ id: string }> }).data.map((row) => row.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([visibleEdge.id, hiddenEdge.id]));
    expect(unrestrictedIds).not.toContain(foreignEdge.id);
    expect((await reader.get(`/alert-templates/correlations/${foreignAlertA.id}`)).status).toBe(404);

    await restrictUserToSites(reader.env, [reader.env.site.id]);

    const list = await reader.get('/alert-templates/correlations');
    expect(list.status).toBe(200);
    expect((await list.json() as { data: Array<{ id: string }> }).data.map((row) => row.id))
      .toEqual([visibleEdge.id]);
    const hiddenFilteredList = await reader.get(`/alert-templates/correlations?alertId=${hiddenAlert.id}`);
    expect(hiddenFilteredList.status).toBe(200);
    expect((await hiddenFilteredList.json() as { data: unknown[] }).data).toEqual([]);

    const groups = await reader.get('/alert-templates/correlations/groups');
    expect(groups.status).toBe(200);
    const groupsBody = await groups.json() as { data: Array<{ alerts: Array<{ id: string }> }> };
    expect(groupsBody.data).toHaveLength(1);
    expect(groupsBody.data[0]?.alerts.map((row) => row.id).sort())
      .toEqual([visibleAlert.id, visibleAlert2.id].sort());
    expect(JSON.stringify(groupsBody)).not.toContain(hiddenAlert.id);
    expect(JSON.stringify(groupsBody)).not.toContain('private-hidden');

    expect((await reader.get(`/alert-templates/correlations/${hiddenAlert.id}`)).status).toBe(404);
    const detail = await reader.get(`/alert-templates/correlations/${visibleAlert.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      data: { correlations: Array<{ id: string }>; relatedAlerts: Array<{ id: string }> };
    };
    expect(detailBody.data.correlations.map((row) => row.id)).toEqual([visibleEdge.id]);
    expect(detailBody.data.relatedAlerts.map((row) => row.id)).toEqual([visibleAlert2.id]);

    const analyze = await reader.post('/alert-templates/correlations/analyze', {});
    expect(analyze.status).toBe(200);
    expect((await analyze.json() as { data: { links: Array<{ id: string }> } }).data.links.map((row) => row.id))
      .toEqual([visibleEdge.id]);
    const hiddenOnly = await reader.post('/alert-templates/correlations/analyze', { alertIds: [hiddenAlert.id] });
    expect(hiddenOnly.status).toBe(200);
    expect((await hiddenOnly.json() as { data: { requestedAlertIds: string[]; links: unknown[] } }).data)
      .toMatchObject({ requestedAlertIds: [], links: [] });

    // An explicit empty ceiling is restrictive, not equivalent to null/all.
    await restrictUserToSites(reader.env, []);
    expect((await reader.get('/alert-templates/correlations')).status).toBe(200);
    expect((await (await reader.get('/alert-templates/correlations')).json() as { data: unknown[] }).data).toEqual([]);
    expect((await reader.get('/alert-templates/correlations/groups')).status).toBe(200);
    expect((await (await reader.get('/alert-templates/correlations/groups')).json() as { data: unknown[] }).data).toEqual([]);
    expect((await reader.get(`/alert-templates/correlations/${visibleAlert.id}`)).status).toBe(404);
    const emptyAnalyze = await reader.post('/alert-templates/correlations/analyze', {});
    expect(emptyAnalyze.status).toBe(200);
    expect((await emptyAnalyze.json() as { data: { links: unknown[] } }).data.links).toEqual([]);
  });
});
