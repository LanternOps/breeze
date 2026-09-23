import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createSite, setupTestEnvironment } from './db-utils';
import { clearPermissionCache } from '../../services/permissions';
import { deviceMonitorsRoutes } from '../../routes/devices/monitors';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  devices,
  monitorDefinitions,
  monitorDeviceState,
  monitorEpisodes,
  organizationUsers,
} from '../../db/schema';

// GET /devices/:id/monitors (#6371 W05c2 Task 10) runs under the REQUEST's
// RLS context (authMiddleware → withDbAccessContext), not a system escalation.
// This proof pins that an org token sees both its org-owned monitors and its
// partner's partner-wide monitors (via the SELECT-only partner branch), and
// never crosses the org or site axis.
describe('GET /devices/:id/monitors — real PostgreSQL under request RLS', () => {
  it('joins provenance, state and open episodes without crossing org or site boundaries', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const hidden = await createSite({ orgId: env.organization.id, name: 'Hidden site' });
    const testDb = getTestDb();

    const [visible, denied] = await testDb
      .insert(devices)
      .values(
        [env.site.id, hidden.id].map((siteId) => ({
          orgId: env.organization.id,
          siteId,
          agentId: `device-monitors-${randomUUID()}`,
          hostname: `device-monitors-${siteId.slice(0, 8)}`,
          osType: 'linux' as const,
          osVersion: 'test',
          architecture: 'x64',
          agentVersion: 'test',
        })),
      )
      .returning();
    if (!visible || !denied) throw new Error('device fixtures were not inserted');

    // Org-owned monitor on an org-owned policy assigned at the org.
    const [orgMonitor] = await testDb
      .insert(monitorDefinitions)
      .values({
        orgId: env.organization.id,
        name: 'CPU test',
        kind: 'cpu',
        condition: { operator: 'gt', value: 90 },
        severity: 'high',
      })
      .returning();
    const [orgPolicy] = await testDb
      .insert(configurationPolicies)
      .values({ orgId: env.organization.id, name: 'Org policy', status: 'active' })
      .returning();
    const [orgLink] = await testDb
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: orgPolicy!.id, featureType: 'monitors' })
      .returning();
    await testDb.insert(configPolicyMonitors).values({ featureLinkId: orgLink!.id, monitorId: orgMonitor!.id });
    await testDb.insert(configPolicyAssignments).values({
      configPolicyId: orgPolicy!.id,
      level: 'organization',
      targetId: env.organization.id,
    });

    // Partner-wide monitor on a partner-wide policy assigned at the partner:
    // readable by the org token only through the partner-wide SELECT branch.
    const [partnerMonitor] = await testDb
      .insert(monitorDefinitions)
      .values({
        partnerId: env.partner.id,
        name: 'Memory partner-wide',
        kind: 'memory',
        condition: { operator: 'gt', value: 95 },
        severity: 'medium',
      })
      .returning();
    const [partnerPolicy] = await testDb
      .insert(configurationPolicies)
      .values({ partnerId: env.partner.id, name: 'Partner policy', status: 'active' })
      .returning();
    const [partnerLink] = await testDb
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: partnerPolicy!.id, featureType: 'monitors' })
      .returning();
    await testDb
      .insert(configPolicyMonitors)
      // A disabled winning attachment must stay visible, as disabled.
      .values({ featureLinkId: partnerLink!.id, monitorId: partnerMonitor!.id, enabled: false });
    await testDb.insert(configPolicyAssignments).values({
      configPolicyId: partnerPolicy!.id,
      level: 'partner',
      targetId: env.partner.id,
    });

    const [episode] = await testDb
      .insert(monitorEpisodes)
      .values({ monitorId: orgMonitor!.id, deviceId: visible.id, orgId: env.organization.id })
      .returning();
    await testDb.insert(monitorDeviceState).values({
      monitorId: orgMonitor!.id,
      deviceId: visible.id,
      orgId: env.organization.id,
      currentEpisodeId: episode!.id,
      lastState: 'breach',
      responsesPaused: true,
      escalatedAt: new Date(),
    });

    // Restrict the caller to the visible site only.
    await testDb
      .update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);

    const app = new Hono().route('/devices', deviceMonitorsRoutes);
    const get = (id: string, token: string = env.token) =>
      app.request(`/devices/${id}/monitors`, { headers: { Authorization: `Bearer ${token}` } });

    const response = await get(visible.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const byId = new Map(body.data.map((row) => [row.monitorId, row]));
    expect(byId.size).toBe(2);
    expect(byId.get(orgMonitor!.id)).toEqual(
      expect.objectContaining({
        name: 'CPU test',
        kind: 'cpu',
        enabled: true,
        sourcePolicyId: orgPolicy!.id,
        sourcePolicyName: 'Org policy',
        lastState: 'breach',
        responsesPaused: true,
        openEpisode: expect.objectContaining({ id: episode!.id }),
      }),
    );
    expect(byId.get(partnerMonitor!.id)).toEqual(
      expect.objectContaining({
        name: 'Memory partner-wide',
        enabled: false,
        sourcePolicyId: partnerPolicy!.id,
        sourcePolicyName: 'Partner policy',
        lastState: 'unknown',
        openEpisode: null,
        responsesPaused: false,
      }),
    );

    // Site axis: same org, excluded site → 403.
    expect((await get(denied.id)).status).toBe(403);

    // Org axis: a foreign org's token never sees the device → 404.
    const foreign = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    expect((await get(visible.id, foreign.token)).status).toBe(404);

    expect((await get(randomUUID())).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(400);
    expect((await app.request(`/devices/${visible.id}/monitors`)).status).toBe(401);

    const noRead = await setupTestEnvironment({ scope: 'organization', rolePermissions: [] });
    expect((await get(visible.id, noRead.token)).status).toBe(403);
  });
});
