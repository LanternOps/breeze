/**
 * #3205 W06 acceptance bar, real Postgres as breeze_app: the device panel's
 * answer is the contract page's answer, computed from a ONE-DEVICE snapshot,
 * and equals what the full-org snapshot would say for every device.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships, contracts, contractLines,
} from '../../db/schema';
import { contractLinesCoveringDevice, type DeviceCoverageActor } from '../../services/deviceCoverage';
import { snapshotContractDevices, groupMembersForBilling } from '../../services/contractQuantities';
import { coverageMatch, uncoveredByRole, type CoverageLine, type GroupMembers, type OrgDeviceSnapshot } from '../../services/contractCoverage';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };
const SYSTEM_ACTOR: DeviceCoverageActor = { accessibleOrgIds: null };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `CP ${sfx}`, slug: `cp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'CA', slug: `ca-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'CB', slug: `cb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    const [sA, sB] = await db.insert(sites).values([
      { orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` },
    ]).returning({ id: sites.id });
    const [sOther] = await db.insert(sites).values({ orgId: oB!.id, name: `O-${sfx}` }).returning({ id: sites.id });
    const dev = (
      agent: string,
      role: typeof devices.$inferInsert.deviceRole,
      siteId: string,
      extra: Partial<typeof devices.$inferInsert> = {},
    ): typeof devices.$inferInsert => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [srvA, srvB, wsA, unk, decom] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id), dev('ws-a', 'workstation', sA!.id),
      dev('unk-a', 'unknown', sA!.id), dev('decom-a', 'server', sA!.id, { status: 'decommissioned' }),
    ]).returning({ id: devices.id, siteId: devices.siteId });
    const [otherOrgDev] = await db.insert(devices)
      .values([{ ...dev('srv-o', 'server', sOther!.id), orgId: oB!.id, siteId: sOther!.id }])
      .returning({ id: devices.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId, name: 'Acme MSA', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-08-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      partnerId: p!.id, orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id, contractId: c!.id,
      srvA: srvA!, srvB: srvB!, wsA: wsA!, unk: unk!, decom: decom!, otherOrgDev: otherOrgDev!,
    };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

const addLine = (f: F, values: Partial<typeof contractLines.$inferInsert>, contractId = f.contractId) =>
  withSystemDbAccessContext(async () => {
    const [l] = await db.insert(contractLines).values({
      contractId, orgId: f.orgId, description: 'line', unitPrice: '10.00', taxable: false,
      lineType: 'per_device', ...values,
    } as typeof contractLines.$inferInsert).returning({ id: contractLines.id });
    return l!.id;
  });

const addGroup = (f: F, values: Partial<typeof deviceGroups.$inferInsert>) =>
  withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups)
      .values({ orgId: f.orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values })
      .returning();
    return g!;
  });

const addContract = (f: F, status: string) =>
  withSystemDbAccessContext(async () => {
    const [c] = await db.insert(contracts).values({
      partnerId: f.partnerId, orgId: f.orgId, name: `C-${status}`, status: status as never,
      intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return c!.id;
  });

const coverage = (deviceId: string, actor = SYSTEM_ACTOR) =>
  withSystemDbAccessContext(() => contractLinesCoveringDevice(deviceId, actor));

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('contractLinesCoveringDevice (real DB) #3205 W06', () => {
  runDb('HEADLINE: a device on a billed group AND a role line lists both, ordered by contract then sortOrder', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvA.id, orgId: f.orgId }));
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, description: 'VIP', sortOrder: 0 });
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never, description: 'Managed servers', sortOrder: 1 });

    const res = await coverage(f.srvA.id);
    expect(res.lines.map((l) => [l.matchedBy, l.description]))
      .toEqual([['group', 'VIP'], ['role', 'Managed servers']]);
    expect(res.lines[0]!.deviceGroup).toEqual({ id: g.id, name: g.name });
    expect(res).toMatchObject({ uncovered: false, notBillable: false, deviceRole: 'server' });
  });

  runDb('CROSS-CHECK with the contract page: covered here IFF absent from uncoveredByRole', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.wsA.id, orgId: f.orgId }));
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never, sortOrder: 0 });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, sortOrder: 1 });

    const lines = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, f.contractId)));
    const snapshot = await withSystemDbAccessContext(async (): Promise<OrgDeviceSnapshot> => ({
      devices: await snapshotContractDevices(f.orgId),
      groups: new Map<string, GroupMembers>([[g.id, await groupMembersForBilling(g)]]),
    }));
    const tally = uncoveredByRole(snapshot, lines as unknown as CoverageLine[]);

    for (const d of [f.srvA, f.srvB, f.wsA, f.unk]) {
      const res = await coverage(d.id);
      const inSnapshot = snapshot.devices.find((r) => r.id === d.id)!;
      const uncoveredHere = !lines.some((l) => coverageMatch(l as unknown as CoverageLine, inSnapshot, snapshot) !== null);
      expect({ id: d.id, uncovered: res.uncovered }).toEqual({ id: d.id, uncovered: uncoveredHere });
    }
    expect(tally.byRole.unknown).toBe(1);   // unk1 is billable but no role/group line reaches it
  });

  runDb('ONE-DEVICE vs FULL-ORG snapshot equivalence, including an off-site pinned member', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvB.id, orgId: f.orgId, isPinned: true }));  // off-site pin
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, sortOrder: 0 });
    await addLine(f, { lineType: 'per_device', siteId: f.siteB, description: 'Branch devices', sortOrder: 1 });

    const lines = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, f.contractId)));
    const full = await withSystemDbAccessContext(async (): Promise<OrgDeviceSnapshot> => ({
      devices: await snapshotContractDevices(f.orgId),
      groups: new Map<string, GroupMembers>([[g.id, await groupMembersForBilling(g)]]),
    }));

    for (const row of full.devices) {
      const expected = lines
        .filter((l) => coverageMatch(l as unknown as CoverageLine, row, full) !== null)
        .map((l) => l.id).sort();
      const actual = (await coverage(row.id)).lines.map((l) => l.lineId).sort();
      expect({ id: row.id, actual }).toEqual({ id: row.id, actual: expected });
    }
  });

  runDb('only ACTIVE contracts count: draft does not cover, activating the same contract does', async () => {
    const f = await seed();
    const draftId = await addContract(f, 'draft');
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never }, draftId);
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'active' }).where(eq(contracts.id, draftId)));
    expect((await coverage(f.srvA.id)).lines).toHaveLength(1);
  });

  runDb('a paused contract does not cover; an active contract with nextBillingAt NULL DOES', async () => {
    const f = await seed();
    const pausedId = await addContract(f, 'paused');
    await addLine(f, { lineType: 'per_device' }, pausedId);
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await withSystemDbAccessContext(() => db.update(contracts).set({ nextBillingAt: null }).where(eq(contracts.id, f.contractId)));
    await addLine(f, { lineType: 'per_device', description: 'All devices' });
    expect((await coverage(f.srvA.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'org' })]);
  });

  runDb('a per_device line at another site does not cover; at the device site it covers with matchedBy site', async () => {
    const f = await seed();
    await addLine(f, { lineType: 'per_device', siteId: f.siteB, description: 'Branch' });
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await addLine(f, { lineType: 'per_device', siteId: f.siteA, description: 'HQ' });
    expect((await coverage(f.srvA.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'site', siteId: f.siteA })]);
  });

  runDb('a group line whose group was deleted does not cover and does NOT throw', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${g.id}::uuid`));
    await expect(coverage(f.srvA.id)).resolves.toMatchObject({ uncovered: true, lines: [] });
  });

  runDb('a malformed dynamic filter rejects with GROUP_EVALUATION_FAILED — never uncovered: true', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: { broken: true } });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await expect(coverage(f.srvA.id)).rejects.toMatchObject({
      status: 500, code: 'GROUP_EVALUATION_FAILED', details: { groupId: g.id, reason: 'invalid_filter' },
    });
  });

  runDb('a decommissioned device in an org with a broken group is notBillable, with no throw', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: { broken: true } });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await expect(coverage(f.decom.id)).resolves.toMatchObject({
      notBillable: true, notBillableReason: 'decommissioned', lines: [], uncovered: false,
    });
  });

  runDb('a stale materialized dynamic membership is ignored: coverage follows the LIVE set', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvA.id, orgId: f.orgId }));   // materialized, not pinned
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    expect((await coverage(f.srvA.id)).lines).toHaveLength(1);
    await withSystemDbAccessContext(() => db.update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, f.srvA.id)));
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);            // stale row is NOT consulted
  });

  runDb('an unknown-role device is covered by an org-wide per_device line', async () => {
    const f = await seed();
    await addLine(f, { lineType: 'per_device', description: 'All devices' });
    expect((await coverage(f.unk.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'org' })]);
  });

  runDb('cross-org: a device in org B is DEVICE_NOT_FOUND for an actor restricted to org A', async () => {
    const f = await seed();
    await expect(coverage(f.otherOrgDev.id, { accessibleOrgIds: [f.orgId] }))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    await expect(coverage('99999999-9999-4999-8999-999999999999', { accessibleOrgIds: [f.orgId] }))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
  });
});
