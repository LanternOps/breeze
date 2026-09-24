import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../__tests__/integration/setup';
import { createTopologyTenant, orgContext } from '../../__tests__/integration/topology-fixtures';
import { db, withDbAccessContext } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';

export async function bmcFixture() {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const [device] = await getTestDb().insert(devices).values({
    ...scope, agentId: randomUUID(), hostname: 'BMC fixture host',
    osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    deviceRole: 'server', deviceRoleSource: 'auto',
  }).returning();
  const [asset] = await getTestDb().insert(discoveredAssets).values({
    ...scope, ipAddress: '192.0.2.10', macAddress: '02:00:00:00:00:10',
    approvalStatus: 'pending', assetType: 'unknown',
  }).returning();
  if (!device || !asset) throw new Error('BMC fixture insertion failed');
  return { ...tenant, scope, device, asset,
    scoped: <T>(work: () => Promise<T>) => withDbAccessContext(orgContext(tenant.orgId), work),
    input: { deviceId: device.id, orgId: tenant.orgId, siteId: tenant.siteId,
      mac: asset.macAddress!, ip: asset.ipAddress }, db,
  };
}
