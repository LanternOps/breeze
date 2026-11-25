/**
 * Integration test — #12418 W02: a device group named by `fleetFilter.groupId`
 * is resolved from the group's definition, against real Postgres as the
 * unprivileged `breeze_app` role. Who is in a group: the device ids a fleet
 * step resolves; nothing about the group's rows is asserted.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { FLEET_MAX_TARGETS } from '@breeze/shared';

/** Runs between the read of the group rows and the device statement. */
const hook = vi.hoisted(() => ({ afterLoad: undefined as undefined | ((executor: unknown) => Promise<void>) }));
vi.mock('../../services/flows/fleetFilterGroupGate', async (orig) => {
  const real = await orig<typeof import('../../services/flows/fleetFilterGroupGate')>();
  return {
    ...real,
    loadGatedGroups: async (...args: Parameters<typeof real.loadGatedGroups>) => {
      const rows = await real.loadGatedGroups(...args);
      await hook.afterLoad?.(args[0]);
      return rows;
    },
  };
});

import { deviceGroupMemberships, deviceGroups, devices, groupMembershipLog } from '../../db/schema';
import { resolveFleetSelection, type RunScriptOnTargetsInput } from '../../services/flows/builtins/runScriptOnTargets';
import type { BuiltinContext } from '../../services/flows/builtins/types';
import { validateBuiltinStep } from '../../services/flows/validateBuiltins';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const rule = (field: string, operator: string, value: unknown) => ({ field, operator, value });
const all = (...conditions: unknown[]) => ({ operator: 'AND', conditions });
const any = (...conditions: unknown[]) => ({ operator: 'OR', conditions });

describe('a group named by a fleetFilter resolves from its definition (#12418 W02, real Postgres)', () => {
  let partnerId: string; let orgId: string; let s1: string; let s2: string;
  let win1: string; let win2: string; let linux1: string;

  beforeEach(async () => {
    hook.afterLoad = undefined;
    if (!process.env.DATABASE_URL) return;
    partnerId = (await createPartner()).id;
    orgId = (await createOrganization({ partnerId }))!.id;
    s1 = (await createSite({ orgId, name: 'Site 1' }))!.id;
    s2 = (await createSite({ orgId, name: 'Site 2' }))!.id;
    win1 = await device({ siteId: s1 });
    win2 = await device({ siteId: s2 });
    linux1 = await device({ siteId: s1, osType: 'linux', lastSeenIp: '192.0.2.7' });
  });

  async function device(over: Partial<typeof devices.$inferInsert>): Promise<string> {
    const [row] = await getTestDb().insert(devices).values({
      orgId, siteId: s1, agentId: `groups-${randomUUID()}`, hostname: `h-${randomUUID().slice(0, 6)}`,
      osType: 'windows', osVersion: '10.0.22631', architecture: 'amd64', agentVersion: '1.0.0', status: 'online', ...over,
    }).returning({ id: devices.id });
    return row!.id;
  }
  async function group(over: Partial<typeof deviceGroups.$inferInsert>): Promise<string> {
    const [row] = await getTestDb().insert(deviceGroups).values({ orgId, name: `g-${randomUUID().slice(0, 8)}`, type: 'dynamic', ...over }).returning({ id: deviceGroups.id });
    return row!.id;
  }
  const member = (groupId: string, deviceId: string, over: Partial<typeof deviceGroupMemberships.$inferInsert> = {}) =>
    getTestDb().insert(deviceGroupMemberships).values({ groupId, deviceId, orgId, ...over });

  const resolve = (groupId: string) => resolveFleetSelection(
    { scriptId: randomUUID(), whenOffline: 'queue', fleetFilter: { groupId } } as RunScriptOnTargetsInput,
    { run: { id: randomUUID(), orgId }, auth: { partnerId } } as unknown as BuiltinContext,
    undefined, { maxTargets: FLEET_MAX_TARGETS },
  );
  const set = (...ids: string[]) => ({ kind: 'set', requested: [...ids].sort(), found: [...ids].sort(), warnings: [] });
  const refused = { kind: 'outcome', outcome: { kind: 'failed', code: 'targets_unresolvable', policy: true, message: expect.stringContaining('cannot be checked') } };
  const saveIssues = async (groupId: string) => (await validateBuiltinStep(
    { id: 's1', tool: 'run_script_on_targets', input: { scriptId: randomUUID(), fleetFilter: { groupId } }, approval: 'default', onFailure: 'stop', timeoutSec: 60 } as never,
    0, { owner: { orgId, partnerId }, catalog: new Map() },
  )).filter((i) => i.pointer === '/steps/0/input/fleetFilter/groupId').map((i) => i.code);

  runDb('a dynamic group selects the devices its rules match', async () => {
    const g = await group({ filterConditions: all(rule('osType', 'equals', 'windows')) });
    await member(g, linux1, { addedBy: 'dynamic_rule' });
    expect(await resolve(g)).toEqual(set(win1, win2));
    expect(await saveIssues(g)).toEqual([]);
  });

  runDb('a dynamic group with no rules selects its pinned devices only', async () => {
    const g = await group({ filterConditions: null });
    await member(g, win1, { addedBy: 'dynamic_rule' });
    expect(await resolve(g)).toEqual(set());
    await member(g, win2, { isPinned: true });
    expect(await resolve(g)).toEqual(set(win2));
  });

  runDb('a group that names another group selects by that group\'s rules', async () => {
    const inner = await group({ filterConditions: all(rule('siteId', 'equals', s2)) });
    const outer = await group({ filterConditions: all(rule('groupId', 'equals', inner)) });
    await member(inner, win1, { addedBy: 'dynamic_rule' });
    await member(outer, win1, { addedBy: 'dynamic_rule' });
    expect(await resolve(outer)).toEqual(set(win2));
    const top = await group({ filterConditions: any(rule('groupId', 'in', [outer]), rule('osType', 'equals', 'linux')) });
    expect(await resolve(top)).toEqual(set(win2, linux1));
  });

  runDb('a group that leaves another group out selects every device that group\'s rules do not match', async () => {
    // No address is recorded on the windows devices: the rule says nothing about them, so they are not members.
    const inner = await group({ filterConditions: all(rule('lastSeenIp', 'equals', '192.0.2.7')) });
    for (const reference of [rule('groupId', 'notEquals', inner), rule('groupId', 'notIn', [inner])]) {
      const outer = await group({ filterConditions: all(reference) });
      expect(await resolve(outer), reference.operator).toEqual(set(win1, win2));
    }
  });

  runDb('rules stay inside the group\'s site at every level, pinned devices are kept', async () => {
    const inner = await group({ siteId: s1, filterConditions: any(rule('osType', 'equals', 'windows'), rule('osType', 'equals', 'linux')) });
    expect(await resolve(inner)).toEqual(set(win1, linux1));
    const outer = await group({ filterConditions: all(rule('groupId', 'equals', inner), rule('osType', 'equals', 'windows')) });
    expect(await resolve(outer)).toEqual(set(win1));
    await member(inner, win2, { isPinned: true });
    expect(await resolve(inner)).toEqual(set(win1, win2, linux1));
    expect(await resolve(outer)).toEqual(set(win1, win2));
  });

  runDb('a pin counts for its own group and device only', async () => {
    const g = await group({ filterConditions: null });
    const other = await group({ filterConditions: null });
    await member(other, win1, { isPinned: true });
    expect(await resolve(g)).toEqual(set());
    expect(await resolve(other)).toEqual(set(win1));
  });

  runDb('a static group selects the devices added to it by hand', async () => {
    const g = await group({ type: 'static' });
    await member(g, win1);
    expect(await resolve(g)).toEqual(set(win1));
    expect(await saveIssues(g)).toEqual([]);
  });

  runDb('a static group with any other member is refused, at save, at resolve and where another group leaves it out', async () => {
    const g = await group({ type: 'static' });
    await member(g, win1);
    await member(g, win2, { addedBy: 'dynamic_rule' });
    const outer = await group({ filterConditions: all(rule('groupId', 'notEquals', g)) });
    for (const id of [g, outer]) {
      expect(await resolve(id)).toEqual(refused);
      expect(await saveIssues(id)).toEqual(['input_invalid']);
    }
  });

  runDb('a static group with a member whose pin was withdrawn is refused until the device is added again', async () => {
    const g = await group({ type: 'static' });
    await member(g, win1);
    const log = () => getTestDb().insert(groupMembershipLog).values({ groupId: g, deviceId: win1, orgId, action: 'added', reason: 'pinned' });
    await log();
    expect(await resolve(g)).toEqual(refused);
    await getTestDb().delete(deviceGroupMemberships).where(and(eq(deviceGroupMemberships.groupId, g), eq(deviceGroupMemberships.deviceId, win1)));
    await member(g, win1);
    expect(await resolve(g)).toEqual(set(win1));
    // Still pinned: an admin's current choice.
    await log();
    await getTestDb().update(deviceGroupMemberships).set({ isPinned: true }).where(eq(deviceGroupMemberships.groupId, g));
    expect(await resolve(g)).toEqual(set(win1));
  });

  runDb('rules that return to their own group, and rules Postgres cannot evaluate, are refused', async () => {
    const a = await group({ filterConditions: null });
    const b = await group({ filterConditions: all(rule('groupId', 'equals', a)) });
    await getTestDb().update(deviceGroups).set({ filterConditions: all(rule('groupId', 'equals', b)) }).where(eq(deviceGroups.id, a));
    expect(await resolve(a)).toEqual(refused);
    expect(await saveIssues(a)).toEqual(['input_invalid']);
    for (const bad of [rule('siteId', 'equals', 'not-a-uuid'), rule('osVersion', 'matches', '(')]) {
      expect(await resolve(await group({ filterConditions: all(bad) })), bad.field).toEqual(refused);
    }
  });

  runDb('the group rows and the devices are read in one snapshot, in the run org\'s own context', async () => {
    const g = await group({ filterConditions: all(rule('osType', 'equals', 'linux')) });
    const seen: unknown[] = [];
    hook.afterLoad = async (executor) => {
      const [row] = await (executor as ReturnType<typeof getTestDb>).execute(sql`
        select current_setting('transaction_isolation') as isolation, current_setting('breeze.scope') as scope,
          current_setting('breeze.accessible_org_ids') as orgs, current_user::text as role`) as unknown as Array<Record<string, unknown>>;
      seen.push(row);
      await getTestDb().update(deviceGroups).set({ filterConditions: all(rule('osType', 'equals', 'windows')) }).where(eq(deviceGroups.id, g));
      await member(g, win1, { isPinned: true });
    };
    expect(await resolve(g)).toEqual(set(linux1));
    expect(seen).toEqual([{ isolation: 'repeatable read', scope: 'organization', orgs: orgId, role: 'breeze_app' }]);
    hook.afterLoad = undefined;
    expect(await resolve(g)).toEqual(set(win1, win2)); // control: the change is real
  });
});
