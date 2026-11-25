/**
 * Integration test — #12418 W02: the `fleetFilter` selector of a flow's
 * `run_script_on_targets` step, against real Postgres as the unprivileged
 * `breeze_app` role.
 *
 * Proven: the set a fleet step resolves for a filter is exactly the set
 * `get_fleet_device_stats` counts for that filter in that org (same total,
 * same ids, for a group whose evaluated members match its rules; decommissioned, Quick Support, parked and other-org devices on
 * neither side); a device-reported field, or a dynamic group defined by one,
 * never resolves to a set; a set above the run's ceiling is refused with the
 * exact count and no ids; a filter that outruns the statement bound is a
 * refusal, never an empty set. Nothing is stubbed: the stats side goes through
 * `executeTool`, the flow side opens its own run-org context.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { FLEET_MAX_TARGETS, type FleetFilter } from '@breeze/shared';

import { db, withDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devicePatches, devices, patches, softwareInventory } from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { FLEET_FILTER_EMPTY_PROBLEM, FLEET_FILTER_TIMEOUT_PROBLEM, resolveFleetFilterOnce } from '../../services/flows/builtins/fleetTargets';
import { aiCeilingMessage, resolveFleetSelection, type RunScriptOnTargetsInput } from '../../services/flows/builtins/runScriptOnTargets';
import { flowDbAccessContext } from '../../services/flows/flowAuthContext';
import { validateBuiltinStep } from '../../services/flows/validateBuiltins';
import type { BuiltinContext } from '../../services/flows/builtins/types';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const AI_SESSION_ID = randomUUID();

function makeAuth(opts: { userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner' }): AuthContext {
  const { orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: scope === 'partner' ? 'all' : undefined,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; holding: string; s1: string; s2: string; sb: string;
  w1: string; w2: string; l1: string; d1: string; e1: string; b1: string; p1: string;
  staticGroup: string; dynamicGroup: string; wide: string; groupB: string;
  orgAuth: AuthContext; partnerAuth: AuthContext;
}

async function seedDevice(v: {
  orgId: string; siteId: string; name: string; osType?: 'windows' | 'macos' | 'linux';
  status?: 'online' | 'offline' | 'decommissioned'; isEphemeral?: boolean; parked?: boolean;
  extra?: Partial<typeof devices.$inferInsert>;
}): Promise<string> {
  // Only enrollment admission may create a device in a holding org.
  return getTestDb().transaction(async (tx) => {
    if (v.parked) await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [row] = await tx.insert(devices).values({
      orgId: v.orgId, siteId: v.siteId, agentId: `parity-${randomUUID()}`, hostname: `${v.name}-${randomUUID().slice(0, 6)}`,
      osType: v.osType ?? 'windows', osVersion: '10.0.22631', architecture: 'amd64', agentVersion: '1.0.0',
      status: v.status ?? 'online', isEphemeral: v.isEphemeral ?? false, ...v.extra,
    }).returning({ id: devices.id });
    return row!.id;
  });
}

async function seedFixture(): Promise<Fixture> {
  const db0 = getTestDb();
  const partner = await createPartner();
  const orgA = (await createOrganization({ partnerId: partner.id }))!;
  const orgB = (await createOrganization({ partnerId: partner.id }))!;
  const holding = (await createOrganization({ partnerId: partner.id, name: 'Holding', type: 'unassigned_pool' }))!;
  const s1 = (await createSite({ orgId: orgA.id, name: 'Site 1' }))!;
  const s2 = (await createSite({ orgId: orgA.id, name: 'Site 2' }))!;
  const sb = (await createSite({ orgId: orgB.id, name: 'Site B' }))!;
  const sh = (await createSite({ orgId: holding.id, name: 'Holding site' }))!;
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `parity-${randomUUID()}@example.com` });

  const now = new Date();
  const w1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'w1', extra: { lastSeenAt: now } });
  const w2 = await seedDevice({
    orgId: orgA.id, siteId: s2.id, name: 'w2', status: 'offline',
    extra: { pendingReboot: true, lastSeenAt: new Date(now.getTime() - 40 * 86_400_000) },
  });
  const l1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'l1', osType: 'linux', extra: { osVersion: '22.04' } });
  // Every excluded device would match `osType: windows`.
  const d1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'd1', status: 'decommissioned' });
  const e1 = await seedDevice({ orgId: orgA.id, siteId: s1.id, name: 'e1', isEphemeral: true });
  const b1 = await seedDevice({ orgId: orgB.id, siteId: sb.id, name: 'b1' });
  const p1 = await seedDevice({ orgId: holding.id, siteId: sh.id, name: 'p1', parked: true });

  for (const [orgId, deviceId] of [[orgA.id, w1], [orgB.id, b1]] as const) {
    await db0.insert(softwareInventory).values({ orgId, deviceId, name: '7-Zip', version: '22.01' });
  }
  const group = async (v: typeof deviceGroups.$inferInsert) => (await db0.insert(deviceGroups).values(v).returning({ id: deviceGroups.id }))[0]!.id;
  const staticGroup = await group({ orgId: orgA.id, name: 'Static' });
  const dynamicGroup = await group({
    orgId: orgA.id, name: 'Dynamic', type: 'dynamic', filterFieldsUsed: ['osType'],
    filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
  });
  const wide = await group({ orgId: null, partnerId: partner.id, name: 'Wide' });
  const groupB = await group({ orgId: orgB.id, name: 'Group B' });
  await db0.insert(deviceGroupMemberships).values([
    { groupId: staticGroup, deviceId: w1, orgId: orgA.id },
    { groupId: staticGroup, deviceId: d1, orgId: orgA.id },
    { groupId: dynamicGroup, deviceId: w1, orgId: orgA.id },
    { groupId: dynamicGroup, deviceId: w2, orgId: orgA.id },
    { groupId: wide, deviceId: w1, orgId: orgA.id },
    { groupId: wide, deviceId: b1, orgId: orgB.id },
    { groupId: groupB, deviceId: b1, orgId: orgB.id },
  ]);
  const [patch] = await db0.insert(patches).values({
    source: 'microsoft', externalId: `KB-${randomUUID()}`, vendor: 'Microsoft', title: 'Update',
    severity: 'critical', requiresReboot: false, releaseDate: '2026-01-01',
  }).returning({ id: patches.id });
  await db0.insert(devicePatches).values([
    { deviceId: w2, orgId: orgA.id, patchId: patch!.id, status: 'pending' },
    { deviceId: d1, orgId: orgA.id, patchId: patch!.id, status: 'pending' },
    { deviceId: b1, orgId: orgB.id, patchId: patch!.id, status: 'pending' },
  ]);

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, holding: holding.id, s1: s1.id, s2: s2.id, sb: sb.id,
    w1, w2, l1, d1, e1, b1, p1, staticGroup, dynamicGroup, wide, groupB,
    orgAuth: makeAuth({ ...base, orgIds: [orgA.id] }),
    // The holding org is in the accessible set on purpose: only the parked exclusion keeps p1 out.
    partnerAuth: makeAuth({ ...base, orgIds: [orgA.id, orgB.id, holding.id], scope: 'partner' }),
  };
}

/** What the model reads: exact total and the complete id list (a small fixture fits one page). */
async function stats(auth: AuthContext, filter: FleetFilter, orgId?: string): Promise<{ total: number; ids: string[] }> {
  const ctx = buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId!, userId: auth.user.id,
  });
  const raw = await withDbAccessContext(ctx, () => executeTool('get_fleet_device_stats', { filter, limit: 100, ...(orgId ? { orgId } : {}) }, auth));
  const body = JSON.parse(raw) as { total: number; devices: Array<{ id: string }>; hasMore: boolean; error?: string };
  expect(body.error).toBeUndefined();
  expect(body.hasMore).toBe(false);
  return { total: body.total, ids: body.devices.map((d) => d.id).sort() };
}

describe('flow fleetFilter resolves the set the stats tool counts (#12418 W02, real Postgres)', () => {
  let f: Fixture;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    f = await seedFixture();
  });
  const runA = () => ({ orgId: f.orgA, partnerId: f.partnerId });

  runDb('controls: every excluded device is readable in its own flow context and is a windows device', async () => {
    // Without these the exclusion assertions below could pass vacuously.
    const inOrg = (orgId: string, ids: string[]) => withDbAccessContext(flowDbAccessContext(orgId, f.partnerId), () =>
      db.select({ id: devices.id, osType: devices.osType }).from(devices).where(inArray(devices.id, ids)));
    expect((await inOrg(f.orgA, [f.d1, f.e1])).map((r) => r.osType)).toEqual(['windows', 'windows']);
    expect(await inOrg(f.holding, [f.p1])).toEqual([{ id: f.p1, osType: 'windows' }]);
    // RLS alone already hides the other org from the run org.
    expect(await inOrg(f.orgA, [f.b1])).toEqual([]);
  });

  runDb('the stats total equals the fleet step\'s resolved set for the same filter in the same org', async () => {
    const filter: FleetFilter = { osType: 'windows' };
    const counted = await stats(f.orgAuth, filter, f.orgA);
    const resolved = await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS);
    expect(resolved).toEqual({ count: 2, deviceIds: [f.w1, f.w2].sort(), problems: [] });
    expect(counted).toEqual({ total: resolved.count, ids: resolved.deviceIds });
    for (const id of [f.d1, f.e1, f.b1, f.p1]) expect(resolved.deviceIds).not.toContain(id);
  });

  runDb('the two agree for every field that may select targets', async () => {
    const cases: Array<[FleetFilter, string[]]> = [
      [{ status: 'online' }, [f.w1, f.l1]],
      [{ osVersionContains: '22631' }, [f.w1, f.w2]],
      [{ siteId: f.s1 }, [f.w1, f.l1]],
      [{ siteId: f.sb }, []],
      [{ groupId: f.staticGroup }, [f.w1]],
      [{ groupId: f.dynamicGroup }, [f.w1, f.w2]],
      [{ pendingPatches: true }, [f.w2]],
      [{ pendingPatches: false }, [f.w1, f.l1]],
      [{ criticalAlerts: false }, [f.w1, f.w2, f.l1]],
      [{ rebootRequired: true }, [f.w2]],
      [{ lastSeenDaysOver: 30 }, [f.w2]],
      [{ osType: 'windows', pendingPatches: true, siteId: f.s2 }, [f.w2]],
    ];
    for (const [filter, expected] of cases) {
      const label = JSON.stringify(filter);
      const resolved = await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS);
      expect(resolved, label).toEqual({ count: expected.length, deviceIds: [...expected].sort(), problems: [] });
      expect(await stats(f.orgAuth, filter, f.orgA), label).toEqual({ total: resolved.count, ids: resolved.deviceIds });
    }
  });

  runDb('an empty filter counts every device and selects none', async () => {
    expect((await stats(f.orgAuth, {}, f.orgA)).total).toBe(3);
    expect(await resolveFleetFilterOnce(runA(), {}, FLEET_MAX_TARGETS)).toEqual({ count: 0, deviceIds: [], problems: [FLEET_FILTER_EMPTY_PROBLEM] });
  });

  runDb('a partner-wide count is wider than any one run org\'s set (a flow never crosses orgs)', async () => {
    const filter: FleetFilter = { osType: 'windows' };
    expect(await stats(f.partnerAuth, filter)).toEqual({ total: 3, ids: [f.w1, f.w2, f.b1].sort() });
    expect((await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS)).count).toBe(2);
    expect((await resolveFleetFilterOnce({ orgId: f.orgB, partnerId: f.partnerId }, filter, FLEET_MAX_TARGETS)).deviceIds).toEqual([f.b1]);
  });

  runDb('a run in a holding org resolves no parked device', async () => {
    expect(await resolveFleetFilterOnce({ orgId: f.holding, partnerId: f.partnerId }, { osType: 'windows' }, FLEET_MAX_TARGETS))
      .toEqual({ count: 0, deviceIds: [], problems: [] });
  });

  runDb('an execution-refused field resolves to a problem, not a set', async () => {
    // The read side counts the same filter, so the refusal is the gate and not an empty match.
    expect((await stats(f.orgAuth, { softwareInstalled: '7-Zip' }, f.orgA)).ids).toEqual([f.w1]);
    const resolved = await resolveFleetFilterOnce(runA(), { softwareInstalled: '7-Zip' }, FLEET_MAX_TARGETS);
    expect(resolved).toMatchObject({ count: 0, deviceIds: [] });
    expect(resolved.problems).toHaveLength(1);
    for (const filter of [{ hostnameContains: 'w' }, { agentVersion: '1.0.0' }, { softwareMissing: 'zzz' }, { softwareVersionBelow: { name: '7-Zip', version: '23' } }] as FleetFilter[]) {
      expect((await stats(f.orgAuth, filter, f.orgA)).total, JSON.stringify(filter)).toBeGreaterThan(0);
      expect((await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS)).problems, JSON.stringify(filter)).toHaveLength(1);
    }
  });

  runDb('a dynamic group whose rules change to a device-reported field is refused at resolve, with its members unchanged', async () => {
    const filter: FleetFilter = { groupId: f.dynamicGroup };
    expect((await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS)).count).toBe(2);
    await getTestDb().update(deviceGroups).set({
      filterFieldsUsed: ['hostname'],
      filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'w' }] },
    }).where(eq(deviceGroups.id, f.dynamicGroup));
    expect((await stats(f.orgAuth, filter, f.orgA)).total).toBe(2); // still counted
    const resolved = await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS);
    expect(resolved).toMatchObject({ count: 0, deviceIds: [] });
    expect(resolved.problems).toEqual([expect.stringContaining('a device reports about itself')]);
  });

  runDb('a group is judged by its live rules as well as its stored field list', async () => {
    const filter: FleetFilter = { groupId: f.dynamicGroup };
    for (const filterFieldsUsed of [[], ['osType']]) {
      await getTestDb().update(deviceGroups).set({
        filterFieldsUsed, filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'w' }] },
      }).where(eq(deviceGroups.id, f.dynamicGroup));
      expect((await stats(f.orgAuth, filter, f.orgA)).total).toBe(2);
      expect(await resolveFleetFilterOnce(runA(), filter, FLEET_MAX_TARGETS)).toEqual({ count: 0, deviceIds: [], problems: [expect.stringContaining('a device reports about itself')] });
    }
  });

  runDb('a group whose rules name another group is judged by that group too', async () => {
    const [outer] = await getTestDb().insert(deviceGroups).values({
      orgId: f.orgA, name: 'Outer', type: 'dynamic', filterFieldsUsed: ['groupId'],
      filterConditions: { operator: 'AND', conditions: [{ field: 'groupId', operator: 'equals', value: f.dynamicGroup }] },
    }).returning({ id: deviceGroups.id });
    await getTestDb().insert(deviceGroupMemberships).values({ groupId: outer!.id, deviceId: f.w1, orgId: f.orgA });
    // Resolved from the named group's rules (windows), not from what this group's own rows say.
    expect((await resolveFleetFilterOnce(runA(), { groupId: outer!.id }, FLEET_MAX_TARGETS)).deviceIds).toEqual([f.w1, f.w2].sort());
    await getTestDb().update(deviceGroups).set({
      filterConditions: { operator: 'AND', conditions: [{ field: 'tags', operator: 'contains', value: 'x' }] },
    }).where(eq(deviceGroups.id, f.dynamicGroup));
    expect(await resolveFleetFilterOnce(runA(), { groupId: outer!.id }, FLEET_MAX_TARGETS)).toMatchObject({ count: 0, deviceIds: [], problems: [expect.any(String)] });
  });

  runDb('save reads the group in the owner org, on its live rules', async () => {
    const issuesAt = async (groupId: string) => (await validateBuiltinStep(
      { id: 's1', tool: 'run_script_on_targets', input: { scriptId: randomUUID(), fleetFilter: { groupId } }, approval: 'default', onFailure: 'stop', timeoutSec: 60 } as never,
      0, { owner: { orgId: f.orgA, partnerId: f.partnerId }, catalog: new Map() },
    )).filter((i) => i.pointer === '/steps/0/input/fleetFilter/groupId').map((i) => i.code);
    expect(await issuesAt(f.dynamicGroup)).toEqual([]);
    expect(await issuesAt(f.staticGroup)).toEqual([]);
    for (const groupId of [f.groupB, f.wide]) expect(await issuesAt(groupId)).toEqual(['reference_not_owned']);
    // A group the owner holds whose rules name another org's group: that group's rules are not the owner's to check.
    const [outer] = await getTestDb().insert(deviceGroups).values({
      orgId: f.orgA, name: 'Names B', type: 'dynamic', filterFieldsUsed: ['groupId'],
      filterConditions: { operator: 'AND', conditions: [{ field: 'groupId', operator: 'equals', value: f.groupB }] },
    }).returning({ id: deviceGroups.id });
    expect(await issuesAt(outer!.id)).toEqual(['input_invalid']);
    expect((await resolveFleetFilterOnce(runA(), { groupId: outer!.id }, FLEET_MAX_TARGETS)).problems).toHaveLength(1);
    await getTestDb().update(deviceGroups).set({
      filterConditions: { operator: 'OR', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }, { field: 'hostname', operator: 'contains', value: 'w' }] },
    }).where(eq(deviceGroups.id, f.dynamicGroup));
    expect(await issuesAt(f.dynamicGroup)).toEqual(['input_invalid']);
  });

  runDb('a group the run org does not hold is refused: a partner-wide group and another org\'s group', async () => {
    // The membership test alone would match w1 through the partner-wide group.
    expect((await stats(f.orgAuth, { groupId: f.wide }, f.orgA)).ids).toEqual([f.w1]);
    for (const groupId of [f.wide, f.groupB, randomUUID()]) {
      const resolved = await resolveFleetFilterOnce(runA(), { groupId }, FLEET_MAX_TARGETS);
      expect(resolved).toMatchObject({ count: 0, deviceIds: [] });
      expect(resolved.problems).toEqual(['The device group this filter names is not available to this flow run.']);
    }
  });

  runDb('above the ceiling the exact count is named and no device id leaves the resolver', async () => {
    for (let i = 0; i < 9; i++) await seedDevice({ orgId: f.orgA, siteId: f.s1, name: `x${i}` });
    const ctx = { run: { id: randomUUID(), orgId: f.orgA }, auth: { partnerId: f.partnerId } } as unknown as BuiltinContext;
    const input = { scriptId: randomUUID(), whenOffline: 'queue', fleetFilter: { osType: 'windows' } } as RunScriptOnTargetsInput;
    expect(await resolveFleetFilterOnce(runA(), { osType: 'windows' }, 10)).toEqual({ count: 11, deviceIds: [], problems: [] });
    expect(await resolveFleetSelection(input, ctx, undefined, { maxTargets: 10 })).toEqual({ kind: 'outcome', outcome: {
      kind: 'failed', code: 'targets_over_cap', policy: true, message: aiCeilingMessage(11),
      output: { resolvedCount: 11, ceiling: 10, selectorKind: 'fleetFilter' },
    } });
    // One fewer fits exactly; the ordinary 500 bound is unchanged.
    await getTestDb().update(devices).set({ status: 'decommissioned' }).where(eq(devices.id, f.w2));
    expect(await resolveFleetSelection(input, ctx, undefined, { maxTargets: 10 })).toMatchObject({ kind: 'set', requested: expect.objectContaining({ length: 10 }) });
    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, f.w2));
    expect(await resolveFleetSelection(input, ctx)).toMatchObject({ kind: 'set', requested: expect.objectContaining({ length: 11 }) });
  });

  runDb('a filter that outruns the statement bound is targets_unresolvable with a fixed message, never an empty set', async () => {
    // `pendingPatches` may select targets, so the query really runs; another
    // connection holds device_patches, and a lock wait counts toward the bound.
    // The lock is released after 4 s, so an unbounded statement fails the test
    // instead of hanging it.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE device_patches IN ACCESS EXCLUSIVE MODE`);
      locked();
      await Promise.race([released, new Promise((r) => setTimeout(r, 4_000))]);
    });
    await Promise.race([isLocked, holder]);
    const ctx = { run: { id: randomUUID(), orgId: f.orgA }, auth: { partnerId: f.partnerId } } as unknown as BuiltinContext;
    const input = { scriptId: randomUUID(), whenOffline: 'queue', fleetFilter: { pendingPatches: true } } as RunScriptOnTargetsInput;
    let out: unknown;
    const started = Date.now();
    try {
      out = await resolveFleetSelection(input, ctx);
    } finally {
      release();
      await holder;
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(out).toEqual({ kind: 'outcome', outcome: { kind: 'failed', code: 'targets_unresolvable', policy: true, message: FLEET_FILTER_TIMEOUT_PROBLEM } });
    expect(FLEET_FILTER_TIMEOUT_PROBLEM).not.toMatch(/select|device_patches|57014|statement_timeout/i);
    // Lock released: the same step resolves its set, so nothing persisted.
    expect(await resolveFleetSelection(input, ctx)).toEqual({ kind: 'set', requested: [f.w2], found: [f.w2], warnings: [] });
  });
});
