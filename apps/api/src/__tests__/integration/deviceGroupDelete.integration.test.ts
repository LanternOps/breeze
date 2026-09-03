import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships, groupMembershipLog, contracts, contractLines } from '../../db/schema';
import { deleteDeviceGroup, DeviceGroupDeleteError } from '../../services/deviceGroupDelete';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `DP ${sfx}`, slug: `dp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'DO', slug: `do-${sfx}` }).returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `DS ${sfx}` }).returning({ id: sites.id });
    const [d] = await db.insert(devices).values({ orgId: o!.id, siteId: s!.id, agentId: `d-${sfx}`, hostname: 'd', status: 'online', osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1' }).returning({ id: devices.id });
    const [g] = await db.insert(deviceGroups).values({ orgId: o!.id, name: 'VIP', type: 'static' }).returning();
    await db.insert(deviceGroupMemberships).values({ groupId: g!.id, deviceId: d!.id, orgId: o!.id });
    await db.insert(groupMembershipLog).values({ groupId: g!.id, deviceId: d!.id, orgId: o!.id, action: 'added', reason: 'manual' });
    return { partnerId: p!.id, orgId: o!.id, deviceId: d!.id, group: g! };
  });
}

async function contractWithGroupLine(f: Awaited<ReturnType<typeof seed>>, status: string) {
  return withSystemDbAccessContext(async () => {
    const [c] = await db.insert(contracts).values({ partnerId: f.partnerId, orgId: f.orgId, name: `C-${status}`, status: status as never, intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD' }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: f.orgId, lineType: 'per_device_group', description: 'g', unitPrice: '1.00', taxable: false, deviceGroupId: f.group.id, deviceGroupName: f.group.name });
    return c!.id;
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('deleteDeviceGroup (real DB) #3205 W02', () => {
  runDb.each(['draft', 'active', 'paused'])('refuses while a %s contract bills the group', async (status) => {
    const f = await seed();
    const contractId = await contractWithGroupLine(f, status);
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))).rejects.toMatchObject({
      name: 'DeviceGroupDeleteError', code: 'BILLED_BY_CONTRACTS', contractCount: 1,
      contracts: [{ id: contractId, name: `C-${status}`, status }],
    });
    const still = await withSystemDbAccessContext(() => db.select().from(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    expect(still).toHaveLength(1);
  });

  runDb.each(['cancelled', 'expired'])('deletes when only a %s contract references it; the line keeps its stamped name', async (status) => {
    const f = await seed();
    const contractId = await contractWithGroupLine(f, status);
    const res = await withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId));
    expect(res).toEqual({ group: { id: f.group.id, name: 'VIP', orgId: f.orgId }, affectedDeviceIds: [f.deviceId] });
    const [line] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, contractId)));
    expect(line).toMatchObject({ deviceGroupId: null, deviceGroupName: 'VIP' });
    const logs = await withSystemDbAccessContext(() => db.select().from(groupMembershipLog).where(eq(groupMembershipLog.groupId, f.group.id)));
    expect(logs).toHaveLength(0);
  });

  runDb('refuses a group with children, and NOT_FOUND for a group in another org', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.insert(deviceGroups).values({ orgId: f.orgId, name: 'child', type: 'static', parentId: f.group.id }));
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))).rejects.toMatchObject({ code: 'HAS_CHILDREN' });
    const other = await seed();
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, other.orgId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(new DeviceGroupDeleteError('NOT_FOUND', 'x')).toBeInstanceOf(Error);
  });
});
