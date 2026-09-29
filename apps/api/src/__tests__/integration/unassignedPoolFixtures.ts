import { randomUUID } from 'node:crypto';
import { devices } from '../../db/schema';
import { createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import { declareParkedDeviceAdmission } from '../../services/unassignedPool/admission';

/** Seeds a holding org + its one site directly (privileged test role). */
export async function seedHoldingOrg(partnerId: string): Promise<{ orgId: string; siteId: string }> {
  const org = await createOrganization({
    partnerId,
    name: 'Unassigned devices',
    slug: `unassigned-pool-${partnerId}`,
    type: 'unassigned_pool',
  });
  const site = await createSite({ orgId: org.id, name: 'Unassigned devices' });
  return { orgId: org.id, siteId: site.id };
}

export async function insertDevice(orgId: string, siteId: string, suffix = randomUUID().slice(0, 8)) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `pool-${suffix}-${randomUUID()}`.slice(0, 64),
    hostname: `pool-${suffix}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'x64',
    agentVersion: 'test',
  }).returning({ id: devices.id, agentId: devices.agentId });
  return device!;
}

/** Column values for a device row in a holding org (used by the admission tests). */
export function parkedDeviceValues(orgId: string, siteId: string, suffix = randomUUID().slice(0, 8)) {
  return {
    orgId,
    siteId,
    agentId: `parked-${suffix}-${randomUUID()}`.slice(0, 64),
    hostname: `parked-${suffix}`,
    osType: 'linux' as const,
    osVersion: 'test',
    architecture: 'x64',
    agentVersion: 'test',
  };
}

/**
 * Seeds a parked device the only way the database allows: inside a transaction
 * that declared an enrollment admission (the devices_unassigned_pool_insert_guard
 * trigger refuses anything else).
 */
export async function seedParkedDevice(orgId: string, siteId: string, suffix = randomUUID().slice(0, 8)) {
  return getTestDb().transaction(async (tx: any) => {
    await declareParkedDeviceAdmission(tx);
    const [device] = await tx.insert(devices).values(parkedDeviceValues(orgId, siteId, suffix))
      .returning({ id: devices.id, agentId: devices.agentId });
    return device!;
  });
}
