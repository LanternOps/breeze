/**
 * #3205 W02 acceptance bar: billing a device group counts the LIVE membership,
 * never the materialized table, and the estimate (request context) agrees with
 * generation (system context). Real Postgres as breeze_app.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships,
  contracts, contractLines, contractBillingPeriods, invoices,
} from '../../db/schema';
import { evaluateGroupMembership } from '../../services/groupMembership';
import {
  computeContractEstimate, generateDueInvoice, listContracts, addContractLineToContract,
  getContract, type ContractActorT,
} from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `BP ${sfx}`, slug: `bp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'BO', slug: `bo-${sfx}` }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [sA] = await db.insert(sites).values({ orgId, name: `A-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, extra: Record<string, unknown> = {}) => ({
      orgId, siteId: sA!.id, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online' as const, deviceRole: role,
      osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [s1, s2, w1, decom, eph] = await db.insert(devices).values([
      dev('s1', 'server'), dev('s2', 'server'), dev('w1', 'workstation'),
      dev('decom', 'server', { status: 'decommissioned' }), dev('eph', 'server', { isEphemeral: true }),
    ]).returning({ id: devices.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId, name: 'Group contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    const actor: ContractActorT = { userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [orgId] };
    return { orgId, partnerId: p!.id, siteA: sA!.id, s1: s1!.id, s2: s2!.id, w1: w1!.id, decom: decom!.id, eph: eph!.id, contractId: c!.id, actor };
  });
}

async function addGroup(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups).values({ orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values }).returning();
    return g!;
  });
}

async function addGroupLine(f: Awaited<ReturnType<typeof seed>>, groupId: string, groupName: string) {
  return withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device_group', description: 'Group', unitPrice: '10.00',
    taxable: false, deviceGroupId: groupId, deviceGroupName: groupName,
  }).returning({ id: contractLines.id }));
}

const runDb = it.runIf(!!process.env.DATABASE_URL);
const requestCtx = (f: Awaited<ReturnType<typeof seed>>) => ({
  scope: 'partner' as const,
  partnerId: f.partnerId,
  orgId: null,
  userId: null,
  accessibleOrgIds: [f.orgId],
  accessiblePartnerIds: [f.partnerId],
  currentPartnerId: f.partnerId,
});

describe('per_device_group billing (real DB) #3205 W02', () => {
  runDb('HEADLINE: a stale materialized dynamic membership is never billed; estimate and generation agree', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => evaluateGroupMembership(g.id));
    // s2 stops being a server WITHOUT any group re-evaluation (the #4630 gap).
    await withSystemDbAccessContext(() => db.update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, f.s2)));
    const rows = await withSystemDbAccessContext(() => db.select().from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, g.id)));
    // Group materialization is broader than billing and can include ephemeral
    // devices; the regression condition is that stale s2 is still present.
    expect(rows.map((r) => r.deviceId)).toEqual(expect.arrayContaining([f.s1, f.s2]));
    await addGroupLine(f, g.id, g.name);

    const est = await withDbAccessContext(requestCtx(f), () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ lineType: 'per_device_group', quantity: 1, live: true });

    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    expect(gen.generated).toBe(true);
    const [inv] = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT quantity FROM invoice_lines WHERE invoice_id = ${gen.invoiceId}::uuid
    `)) as Array<{ quantity: string }>;
    expect(Number(inv!.quantity)).toBe(1);
  });

  runDb('static group ∩ billable: decommissioned and ephemeral members do not count', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values([
      { groupId: g.id, deviceId: f.s1, orgId: f.orgId }, { groupId: g.id, deviceId: f.decom, orgId: f.orgId }, { groupId: g.id, deviceId: f.eph, orgId: f.orgId },
    ]));
    await addGroupLine(f, g.id, g.name);
    const est = await withDbAccessContext(requestCtx(f), () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]!.quantity).toBe(1);
    expect(est.uncoveredDevices).toEqual({ total: 2, byRole: { server: 1, workstation: 1 } });
  });

  runDb('a pinned member outside the filter counts; a member outside a site-bound group\'s site does not', async () => {
    const f = await seed();
    const [sB] = await withSystemDbAccessContext(() => db.insert(sites).values({ orgId: f.orgId, name: 'B' }).returning({ id: sites.id }));
    await withSystemDbAccessContext(() => db.update(devices).set({ siteId: sB!.id }).where(eq(devices.id, f.s2)));
    const g = await addGroup(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values([
      { groupId: g.id, deviceId: f.w1, orgId: f.orgId, isPinned: true },
      { groupId: g.id, deviceId: f.s2, orgId: f.orgId, isPinned: true },
    ]));
    await addGroupLine(f, g.id, g.name);
    const est = await withDbAccessContext(requestCtx(f), () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]!.quantity).toBe(2);
  });

  runDb('a malformed filter fails generation loudly and rolls everything back; the list degrades per contract', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'dynamic', filterConditions: { broken: true } });
    await addGroupLine(f, g.id, g.name);
    await expect(withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z')))))
      .rejects.toMatchObject({ code: 'GROUP_EVALUATION_FAILED', status: 500, details: { groupId: g.id, reason: 'invalid_filter' } });
    const invs = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(invs).toHaveLength(0);
    const periods = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(periods).toHaveLength(0);
    const [c] = await withSystemDbAccessContext(() => db.select().from(contracts).where(eq(contracts.id, f.contractId)));
    expect(c!.nextBillingAt).toBe('2026-07-01');
    await expect(withDbAccessContext(requestCtx(f), () => computeContractEstimate(f.contractId, f.actor))).rejects.toBeInstanceOf(ContractServiceError);
    const list = await withDbAccessContext(requestCtx(f), () => listContracts({ orgId: f.orgId }, f.actor));
    expect(list[0]).toMatchObject({ id: f.contractId, estimatedPeriodValue: null, estimateError: 'GROUP_EVALUATION_FAILED' });
  });

  runDb('a deleted group: estimate shows unresolved, generation refuses with GROUP_DELETED', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static' });
    await addGroupLine(f, g.id, g.name);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${g.id}::uuid`));
    const est = await withDbAccessContext(requestCtx(f), () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ quantity: 0, unresolved: 'group_deleted' });
    await expect(withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z')))))
      .rejects.toMatchObject({ code: 'GROUP_DELETED', status: 409 });
  });

  runDb('writer stamps the group name and rejects a group from another org', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static', name: 'VIP' });
    const other = await seed();
    const foreign = await addGroup(other.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'draft' }).where(eq(contracts.id, f.contractId)));
    const line = await withDbAccessContext(requestCtx(f), () => addContractLineToContract(f.contractId,
      { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false, deviceGroupId: g.id }, f.actor));
    expect(line).toMatchObject({ deviceGroupId: g.id, deviceGroupName: 'VIP', siteId: null });
    const detail = await withDbAccessContext(requestCtx(f), () => getContract(f.contractId, f.actor));
    expect(detail.lines[0]).toMatchObject({ deviceGroup: { id: g.id, name: 'VIP', type: 'static' } });
    await expect(withDbAccessContext(requestCtx(f), () => addContractLineToContract(f.contractId,
      { lineType: 'per_device_group', description: 'X', unitPrice: '5.00', taxable: false, deviceGroupId: foreign.id }, f.actor)))
      .rejects.toMatchObject({ code: 'GROUP_NOT_IN_ORG', status: 400 });
  });
});
