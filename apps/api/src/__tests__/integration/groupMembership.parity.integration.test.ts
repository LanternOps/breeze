/**
 * #3205 W06 mandatory anti-drift test. Two definitions of group membership now
 * exist — resolveEffectiveGroupMembers (whole group, billing + evaluator) and
 * groupIncludesDevice (one device, the device coverage panel). This file is the
 * reason they cannot drift: for EVERY group x EVERY billing-eligible device in
 * the fixture, groupIncludesDevice(group, device) ===
 * (matched ∪ pinned).has(device.id).
 *
 * The trailing site clause on groupIncludesDevice's filter branch is the one
 * place drift could hide: evaluateFilter narrows by allowedSiteIds inside its
 * SQL, deviceMatchesFilter (filterEngine.ts:668) takes no site argument.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships } from '../../db/schema';

const { deviceMatchesFilterSpy } = vi.hoisted(() => ({ deviceMatchesFilterSpy: vi.fn() }));
vi.mock('../../services/filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/filterEngine')>();
  deviceMatchesFilterSpy.mockImplementation(actual.deviceMatchesFilter);
  return { ...actual, deviceMatchesFilter: deviceMatchesFilterSpy };
});

import { groupIncludesDevice, resolveEffectiveGroupMembers } from '../../services/groupMembership';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `PP ${sfx}`, slug: `pp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'PA', slug: `pa-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'PB', slug: `pb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    // devices.site_id is NOT NULL — every device needs a site in its OWN org.
    const [sA, sB] = await db.insert(sites).values([
      { orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` },
    ]).returning({ id: sites.id });
    const [sOther] = await db.insert(sites).values({ orgId: oB!.id, name: `O-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, siteId: string) => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online' as const, deviceRole: role,
      osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
    });
    const [srvA, srvB, wsA, wsB, ephemeralDev] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id),
      dev('ws-a', 'workstation', sA!.id), dev('ws-b', 'workstation', sB!.id),
      { ...dev('srv-ephemeral', 'server', sA!.id), isEphemeral: true },
    ]).returning({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, isEphemeral: devices.isEphemeral });
    const [otherOrgDev] = await db.insert(devices)
      .values([{ ...dev('srv-other', 'server', sOther!.id), orgId: oB!.id, siteId: sOther!.id }])
      .returning({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, isEphemeral: devices.isEphemeral });
    return {
      orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id,
      local: [srvA!, srvB!, wsA!, wsB!],
      all: [srvA!, srvB!, wsA!, wsB!, otherOrgDev!, ephemeralDev!],
      srvA: srvA!, srvB: srvB!, wsA: wsA!, wsB: wsB!, otherOrgDev: otherOrgDev!, ephemeralDev: ephemeralDev!,
    };
  });
}

async function group(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups)
      .values({ orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values })
      .returning();
    return g!;
  });
}

const member = (groupId: string, deviceId: string, orgId: string, isPinned = false) =>
  withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({ groupId, deviceId, orgId, isPinned }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('groupIncludesDevice parity with resolveEffectiveGroupMembers (real DB) #3205 W06', () => {
  runDb('every group x every billing-eligible device has one-device/whole-group parity', async () => {
    const f = await seed();
    const gStatic = await group(f.orgId, { type: 'static' });
    await member(gStatic.id, f.wsA.id, f.orgId);
    await member(gStatic.id, f.srvB.id, f.orgId);
    await member(gStatic.id, f.ephemeralDev.id, f.orgId);

    const gDynamic = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(gDynamic.id, f.wsB.id, f.orgId, true);
    await member(gDynamic.id, f.srvA.id, f.orgId);

    const gNullFilter = await group(f.orgId, { type: 'dynamic', filterConditions: null });
    await member(gNullFilter.id, f.wsA.id, f.orgId, true);
    await member(gNullFilter.id, f.srvA.id, f.orgId);

    const gSiteBound = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    await member(gSiteBound.id, f.srvB.id, f.orgId, true);

    for (const g of [gStatic, gDynamic, gNullFilter, gSiteBound]) {
      const { matched, pinned } = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
      const union = new Set([...matched, ...pinned]);
      for (const d of f.local) {
        const actual = await withSystemDbAccessContext(() => groupIncludesDevice(g, d));
        expect({ group: g.id, device: d.id, actual }).toEqual({ group: g.id, device: d.id, actual: union.has(d.id) });
      }
    }

    const { matched } = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(gStatic));
    // Deliberate divergence: the whole-group resolver includes real membership
    // rows, while billing eligibility refuses ephemeral devices up front.
    expect(matched.has(f.ephemeralDev.id)).toBe(true);
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(gStatic, f.ephemeralDev))).toBe(false);
  });

  runDb('a malformed non-null filter throws for eligible devices and rejects ineligible devices first', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: { nope: true } });
    await member(g.id, f.wsA.id, f.orgId, true);
    await expect(withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g)))
      .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    for (const d of f.local) {
      await expect(withSystemDbAccessContext(() => groupIncludesDevice(g, d)))
        .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    }
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.otherOrgDev))).toBe(false);
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.ephemeralDev))).toBe(false);
  });

  runDb('a membership row forged with another org_id is invisible', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${f.otherOrgDev.id}::uuid, ${g.id}::uuid, ${f.orgB}::uuid)
    `));
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.otherOrgDev))).toBe(false);
  });

  runDb('a pinned device short-circuits: deviceMatchesFilter is never called', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(g.id, f.wsB.id, f.orgId, true);
    deviceMatchesFilterSpy.mockClear();
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.wsB))).toBe(true);
    expect(deviceMatchesFilterSpy).not.toHaveBeenCalled();
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvA))).toBe(true);
    expect(deviceMatchesFilterSpy).toHaveBeenCalledTimes(1);
  });

  runDb('a site-bound group does not match an off-site device through the filter branch', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvA))).toBe(true);
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvB))).toBe(false);
  });
});
