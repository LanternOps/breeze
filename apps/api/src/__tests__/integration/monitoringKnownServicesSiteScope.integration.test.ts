import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { monitoringRoutes } from '../../routes/monitoring';
import { clearPermissionCache } from '../../services/permissions';
import {
  devices,
  deviceChangeLog,
  organizationUsers,
  serviceProcessCheckResults,
} from '../../db/schema';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/monitoring', monitoringRoutes);
  return app;
}

function request(app: Hono, token: string, orgId?: string): Promise<Response> {
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return Promise.resolve(app.request(`/monitoring/known-services${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

describe('GET /monitoring/known-services — real PostgreSQL site scope', () => {
  let app: Hono;

  beforeEach(() => { app = buildApp(); });

  it('filters both sources before aggregation and follows each device current site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden Site' });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });

    const [visibleDevice, hiddenDevice] = await getTestDb().insert(devices).values([
      {
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `known-visible-${randomUUID()}`,
        hostname: 'known-visible',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x64',
        agentVersion: 'test',
      },
      {
        orgId: env.organization.id,
        siteId: hiddenSite.id,
        agentId: `known-hidden-${randomUUID()}`,
        hostname: 'known-hidden',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x64',
        agentVersion: 'test',
      },
    ]).returning({ id: devices.id });
    if (!visibleDevice || !hiddenDevice) throw new Error('device fixtures were not inserted');

    await getTestDb().insert(deviceChangeLog).values([
      {
        deviceId: visibleDevice.id,
        orgId: env.organization.id,
        fingerprint: 'a'.repeat(64),
        timestamp: new Date(),
        changeType: 'service',
        changeAction: 'added',
        subject: 'visible-change-service',
      },
      {
        deviceId: hiddenDevice.id,
        orgId: env.organization.id,
        fingerprint: 'b'.repeat(64),
        timestamp: new Date(),
        changeType: 'service',
        changeAction: 'added',
        subject: 'hidden-change-service',
      },
    ]);
    await getTestDb().insert(serviceProcessCheckResults).values([
      {
        orgId: env.organization.id,
        deviceId: visibleDevice.id,
        watchType: 'process',
        name: 'visible-check-process',
        status: 'running',
      },
      {
        orgId: env.organization.id,
        deviceId: hiddenDevice.id,
        watchType: 'process',
        name: 'hidden-check-process',
        status: 'running',
      },
    ]);

    await getTestDb().update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);

    let response = await request(app, env.token);
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((row: { name: string }) => row.name).sort()).toEqual([
      'visible-change-service',
      'visible-check-process',
    ]);

    // Current-device authority is deliberate: moving the device into the
    // allowed site makes both of its historical name sources visible.
    await getTestDb().update(devices)
      .set({ siteId: env.site.id })
      .where(eq(devices.id, hiddenDevice.id));
    response = await request(app, env.token);
    expect((await response.json()).data.map((row: { name: string }) => row.name).sort()).toEqual([
      'hidden-change-service',
      'hidden-check-process',
      'visible-change-service',
      'visible-check-process',
    ]);

    await getTestDb().update(devices)
      .set({ siteId: hiddenSite.id })
      .where(eq(devices.id, hiddenDevice.id));
    await getTestDb().update(organizationUsers)
      .set({ siteIds: [] })
      .where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);
    response = await request(app, env.token);
    expect(await response.json()).toEqual({ data: [] });

    await getTestDb().update(organizationUsers)
      .set({ siteIds: null })
      .where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);
    response = await request(app, env.token);
    expect((await response.json()).data.map((row: { name: string }) => row.name).sort()).toEqual([
      'hidden-change-service',
      'hidden-check-process',
      'visible-change-service',
      'visible-check-process',
    ]);

    response = await request(app, env.token, foreignOrg.id);
    expect(response.status).toBe(403);
  });
});
