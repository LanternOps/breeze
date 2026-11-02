/**
 * PR #7117 re-review: a SITE-OWNED topology alert (M3-D6, alerts.topology_site_id
 * NOT NULL) keeps its org when its origin device moves org — the ownership
 * guard (migrations/2026-11-06-210400-topology-alert-ownership.sql) pins
 * org_id to the site — but it keeps `device_id` → the moved device, whose FK
 * is NO ACTION. So after a move-org the device's NEW org holds a device that a
 * row in ANOTHER org still references:
 *
 *   - permanent delete of the device (as the new org's user) must detach its
 *     provenance and preserve alert history, recording the count in the audit;
 *   - GDPR erasure of the new org deletes alerts by org_id only, so without a
 *     pre-clear the `devices` delete aborts on the FK and the erasure fails.
 *
 * Real Postgres, breeze_app, real move-org route (step-up grant), real
 * permanent-delete route, real cascadeDeleteOrg.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  alertCorrelations,
  alertNotifications,
  alerts,
  auditLogs,
  devices,
  notificationChannels,
  organizations,
  psaConnections,
  psaTicketMappings,
  sites,
} from '../../db/schema';
import {
  assignUserToOrganization,
  createOrganization,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { coreRoutes } from '../../routes/devices/core';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

async function seedOrigin(moveOrigin = true) {
  const seed = getTestDb() as any;
  const { partner, organization: orgA, site: siteA, user, role } = await setupTestEnvironment({ scope: 'partner' });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteB = await createSite({ orgId: orgB.id });

  const [device] = await seed.insert(devices).values({
    orgId: orgA.id, siteId: siteA.id, agentId: `topo-origin-${randomUUID()}`, hostname: 'topology-collector',
    osType: 'linux', osVersion: '22.04', architecture: 'amd64', agentVersion: '1', status: 'offline',
  }).returning();
  const base = { orgId: orgA.id, deviceId: device.id, severity: 'high' as const, status: 'active' as const };
  const [owned, plain] = await seed.insert(alerts).values([
    { ...base, ownerKind: 'topology_site', title: 'gateway unreachable', topologySiteId: siteA.id, topologySourceKey: `topology:${'a'.repeat(64)}` },
    { ...base, ownerKind: 'device', title: 'device-bound alert' },
  ]).returning();
  const [channel] = await seed.insert(notificationChannels).values({
    orgId: orgA.id, name: 'mail', type: 'email', config: { recipients: ['ops@example.test'] },
  }).returning();
  await seed.insert(alertNotifications).values({ alertId: owned.id, channelId: channel.id, status: 'sent' });
  // A correlation parented by ANOTHER org-A alert that is not device-bound to D.
  const [other] = await seed.insert(alerts).values({
    orgId: orgA.id, deviceId: (await seed.insert(devices).values({
      orgId: orgA.id, siteId: siteA.id, agentId: `topo-peer-${randomUUID()}`, hostname: 'peer',
      osType: 'linux', osVersion: '22.04', architecture: 'amd64', agentVersion: '1', status: 'offline',
    }).returning())[0].id, ownerKind: 'device', severity: 'low', status: 'active', title: 'peer alert',
  }).returning();
  await seed.insert(alertCorrelations).values({ parentAlertId: other.id, childAlertId: owned.id, correlationType: 'topology' });

  const [connection] = await seed.insert(psaConnections).values({
    partnerId: partner.id, provider: 'connectwise', name: 'test-psa', credentials: {},
  }).returning();
  const [ownedMapping, plainMapping, deviceMapping] = await seed.insert(psaTicketMappings).values([
    { connectionId: connection.id, alertId: owned.id, deviceId: device.id, externalTicketId: 'site-ticket' },
    { connectionId: connection.id, alertId: plain.id, deviceId: device.id, externalTicketId: 'device-ticket' },
    { connectionId: connection.id, deviceId: device.id, externalTicketId: 'standalone-ticket' },
  ]).returning();

  if (moveOrigin) {
    // Real move-org path (partner-scope user, step-up grant).
    const partnerToken = await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: 'it-session',
    });
    const moveApp = new Hono().route('/devices', moveOrgRoutes);
    const moveRes = await moveApp.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${partnerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(partnerToken, device.id, { orgId: orgB.id, siteId: siteB.id })),
    });
    expect(moveRes.status, await moveRes.clone().text()).toBe(200);

    const [movedDevice] = await seed.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, device.id));
    expect(movedDevice.orgId).toBe(orgB.id);
    const [ownedAfterMove] = await seed.select({ orgId: alerts.orgId, deviceId: alerts.deviceId }).from(alerts).where(eq(alerts.id, owned.id));
    // The precondition the finding describes: the owned alert stays in org A
    // while still pointing at the device now in org B.
    expect(ownedAfterMove).toEqual({ orgId: orgA.id, deviceId: device.id });
    const [plainAfterMove] = await seed.select({ orgId: alerts.orgId }).from(alerts).where(eq(alerts.id, plain.id));
    expect(plainAfterMove.orgId).toBe(orgB.id);
  }

  return { seed, partner, orgA, siteA, orgB, siteB, deviceId: device.id, ownedId: owned.id, plainId: plain.id, otherAlertId: other.id, ownedMappingId: ownedMapping.id, plainMappingId: plainMapping.id, deviceMappingId: deviceMapping.id };
}

async function orgUserToken(partnerId: string, orgId: string) {
  const user = await createUser({ partnerId, orgId });
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  await assignUserToOrganization(user.id, orgId, role.id);
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId, partnerId,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function waitForAudit(deviceId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await getTestDb().select().from(auditLogs)
      .where(and(eq(auditLogs.action, 'device.permanent_delete'), eq(auditLogs.resourceId, deviceId)));
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

describe('site-owned topology alerts of a deleted origin device', () => {
  it.each([false, true])('preserves topology_site alerts when the origin device is deleted (moved: %s)', async (moveOrigin) => {
    const f = await seedOrigin(moveOrigin);
    const deviceOrgId = moveOrigin ? f.orgB.id : f.orgA.id;
    await f.seed.update(devices).set({ status: 'decommissioned', decommissionedAt: new Date() }).where(eq(devices.id, f.deviceId));
    const token = await orgUserToken(f.partner.id, deviceOrgId);

    const app = new Hono().route('/devices', coreRoutes);
    const res = await app.request(`/devices/${f.deviceId}/permanent`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await f.seed.select().from(devices).where(eq(devices.id, f.deviceId))).toHaveLength(0);
    const [preserved] = await f.seed.select().from(alerts).where(eq(alerts.id, f.ownedId));
    expect(preserved).toMatchObject({ ownerKind: 'topology_site', orgId: f.orgA.id, topologySiteId: f.siteA.id, deviceId: null });
    expect(await f.seed.select().from(alertNotifications).where(eq(alertNotifications.alertId, f.ownedId))).toHaveLength(1);
    expect(await f.seed.select().from(alertCorrelations).where(eq(alertCorrelations.childAlertId, f.ownedId))).toHaveLength(1);
    const [mapping] = await f.seed.select().from(psaTicketMappings).where(eq(psaTicketMappings.id, f.ownedMappingId));
    expect(mapping).toMatchObject({ alertId: f.ownedId, deviceId: null, externalTicketId: 'site-ticket' });
    // Device-owned alerts and mappings still go with the device.
    expect(await f.seed.select().from(alerts).where(eq(alerts.id, f.plainId))).toHaveLength(0);
    expect(await f.seed.select().from(psaTicketMappings).where(eq(psaTicketMappings.id, f.plainMappingId))).toHaveLength(0);
    expect(await f.seed.select().from(psaTicketMappings).where(eq(psaTicketMappings.id, f.deviceMappingId))).toHaveLength(0);
    // Org A's own site and unrelated alert are untouched.
    expect(await f.seed.select().from(sites).where(eq(sites.id, f.siteA.id))).toHaveLength(1);
    expect(await f.seed.select().from(alerts).where(eq(alerts.id, f.otherAlertId))).toHaveLength(1);

    const audits = await waitForAudit(f.deviceId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ orgId: deviceOrgId, details: expect.objectContaining({ detachedTopologyAlerts: 1 }) });
  });

  it('GDPR erasure of the new org completes and removes the moved device and its site-owned alert', async () => {
    const f = await seedOrigin();

    const stats = await cascadeDeleteOrg(f.orgB.id, '00000000-0000-0000-0000-0000000000aa');

    expect(await f.seed.select().from(organizations).where(eq(organizations.id, f.orgB.id))).toHaveLength(0);
    expect(await f.seed.select().from(devices).where(eq(devices.id, f.deviceId))).toHaveLength(0);
    expect(await f.seed.select().from(alerts).where(eq(alerts.id, f.ownedId))).toHaveLength(0);
    expect(await f.seed.select().from(alertNotifications).where(eq(alertNotifications.alertId, f.ownedId))).toHaveLength(0);
    expect(stats.foreignTopologyAlertsDeleted).toBe(1);
    // Org A survives with its site and its unrelated alert.
    expect(await f.seed.select().from(organizations).where(eq(organizations.id, f.orgA.id))).toHaveLength(1);
    expect(await f.seed.select().from(sites).where(eq(sites.id, f.siteA.id))).toHaveLength(1);
    expect(await f.seed.select().from(alerts).where(eq(alerts.id, f.otherAlertId))).toHaveLength(1);
  });
});
