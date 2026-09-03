/**
 * resolveEffectiveGroupMembers (#3205 W02): the one read-only definition of
 * "who is in this group" shared by the evaluator and by contract billing.
 * Real DB: the filter engine compiles to SQL and RLS shapes what each context sees.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships } from '../../db/schema';
import { GroupEvaluationError, resolveEffectiveGroupMembers } from '../../services/groupMembership';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `RP ${sfx}`, slug: `rp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    const [sA, sB] = await db.insert(sites).values([{ orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }]).returning({ id: sites.id });
    const [sB2] = await db.insert(sites).values({ orgId: oB!.id, name: `Other-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, siteId: string, extra: Partial<typeof devices.$inferInsert> = {}): typeof devices.$inferInsert => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [srvA, srvB, wsA, ephemeralSrv] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id), dev('ws-a', 'workstation', sA!.id),
      dev('srv-eph', 'server', sA!.id, { isEphemeral: true }),
    ]).returning({ id: devices.id });
    const [otherOrgDev] = await db.insert(devices).values([{ ...dev('srv-other', 'server', sB2!.id), orgId: oB!.id }]).returning({ id: devices.id });
    return { orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id, srvA: srvA!.id, srvB: srvB!.id, wsA: wsA!.id, ephemeralSrv: ephemeralSrv!.id, otherOrgDev: otherOrgDev!.id };
  });
}

async function group(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups).values({ orgId, name: 'G', type: 'static', ...values }).returning();
    return g!;
  });
}

const member = (groupId: string, deviceId: string, orgId: string, isPinned = false) =>
  withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({ groupId, deviceId, orgId, isPinned }));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ids = (s: ReadonlySet<string>) => [...s].sort();

describe('resolveEffectiveGroupMembers (real DB) #3205 W02', () => {
  runDb('static: every membership row is matched, nothing pinned', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await member(g.id, f.wsA, f.orgId); await member(g.id, f.srvB, f.orgId);
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvB, f.wsA].sort());
    expect(r.pinned.size).toBe(0);
  });

  runDb('dynamic: live filter matches ∪ pinned; ephemeral excluded; a stale materialized row is NOT consulted', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(g.id, f.wsA, f.orgId, true);        // pinned workstation: kept
    await member(g.id, f.srvA, f.orgId);             // materialized server: also a live match
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE devices SET device_role = 'workstation' WHERE id = ${f.srvB}::uuid`));
    await member(g.id, f.srvB, f.orgId);             // stale row: srvB is no longer a server
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvA]);       // not srvB (stale), not ephemeral
    expect(ids(r.pinned)).toEqual([f.wsA]);
  });

  runDb('dynamic with NULL filter: pinned only', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: null });
    await member(g.id, f.wsA, f.orgId, true); await member(g.id, f.srvA, f.orgId);
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(r.matched.size).toBe(0);
    expect(ids(r.pinned)).toEqual([f.wsA]);
  });

  runDb('dynamic with malformed non-null filter throws GroupEvaluationError(invalid_filter)', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: { nope: true } });
    await expect(withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g)))
      .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    expect(new GroupEvaluationError(g.id, 'invalid_filter')).toBeInstanceOf(Error);
  });

  runDb('site-bound dynamic group: filter matches only inside the site', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvA]);
  });

  runDb('a membership row carrying another org_id is ignored', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await member(g.id, f.wsA, f.orgId);
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id) VALUES (${f.otherOrgDev}::uuid, ${g.id}::uuid, ${f.orgB}::uuid)
    `));
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.wsA]);
  });
});
