/**
 * Integration test — #12418 W02: a device group named by `fleetFilter.groupId`
 * is resolved from the group's definition, against real Postgres as the
 * unprivileged `breeze_app` role. Who is in a group: the device ids a fleet
 * step resolves; nothing else is asserted.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { FLEET_MAX_TARGETS, FLOW_LIMITS } from '@breeze/shared';

/** Runs between the read of the group rows and the device statement. */
const hook = vi.hoisted(() => ({
  afterLoad: undefined as undefined | ((executor: unknown) => Promise<void>),
  loads: 0,
  /** The reads those loads sent. */
  statements: 0,
}));
vi.mock('../../services/flows/fleetFilterGroupGate', async (orig) => {
  const real = await orig<typeof import('../../services/flows/fleetFilterGroupGate')>();
  return {
    ...real,
    loadGatedGroups: async (...args: Parameters<typeof real.loadGatedGroups>) => {
      hook.loads += 1;
      const executor = new Proxy(args[0] as object, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key === 'select' || key === 'selectDistinct') hook.statements += 1;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof args[0];
      const [, ...rest] = args;
      const rows = await real.loadGatedGroups(executor, ...rest);
      await hook.afterLoad?.(args[0]);
      return rows;
    },
  };
});

import { deviceGroupMemberships, deviceGroups, devices, groupMembershipLog } from '../../db/schema';
import { GROUP_CHECK_TIMEOUT_PROBLEM } from '../../services/flows/builtins/fleetTargets';
import { resolveFleetSelection, type RunScriptOnTargetsInput } from '../../services/flows/builtins/runScriptOnTargets';
import type { BuiltinContext } from '../../services/flows/builtins/types';
import { validateFlowDocument } from '../../services/flowValidator';
import { validateBuiltinStep } from '../../services/flows/validateBuiltins';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { withSlowTimeoutRestore } from './slowTimeoutRestore';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const rule = (field: string, operator: string, value: unknown) => ({ field, operator, value });
const all = (...conditions: unknown[]) => ({ operator: 'AND', conditions });
const any = (...conditions: unknown[]) => ({ operator: 'OR', conditions });

describe('a group named by a fleetFilter resolves from its definition (#12418 W02, real Postgres)', () => {
  let partnerId: string; let orgId: string; let s1: string; let s2: string;
  let win1: string; let win2: string; let linux1: string;

  beforeEach(async () => {
    hook.afterLoad = undefined;
    hook.loads = 0;
    hook.statements = 0;
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
    // Neither the log of the add itself nor another device's pin says otherwise.
    await getTestDb().insert(groupMembershipLog).values([
      { groupId: g, deviceId: win1, orgId, action: 'added', reason: 'manual' },
      { groupId: g, deviceId: win2, orgId, action: 'added', reason: 'pinned' },
    ]);
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

  runDb('a static group member counts as added by hand from its latest add', async () => {
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
    for (const bad of [rule('siteId', 'equals', 'not-a-uuid'), rule('osVersion', 'matches', '('),
      // Never reaches Postgres: the driver cannot bind it.
      rule('lastSeenAt', 'after', 1700000000000), rule('lastSeenAt', 'after', { amount: 7, unit: 'days' })]) {
      expect(await resolve(await group({ filterConditions: all(bad) })), JSON.stringify(bad)).toEqual(refused);
    }
  });

  runDb('a group check that outruns the statement bound is refused at save and at resolve, and leaves nothing behind', async () => {
    const g = await group({ type: 'static' });
    await member(g, win1);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE group_membership_log IN ACCESS EXCLUSIVE MODE`);
      locked();
      await Promise.race([released, new Promise((r) => setTimeout(r, 4_000))]);
    });
    await Promise.race([isLocked, holder]);
    const started = Date.now();
    try {
      expect(await resolve(g)).toMatchObject({ kind: 'outcome', outcome: { code: 'targets_unresolvable', message: GROUP_CHECK_TIMEOUT_PROBLEM } });
      expect(await saveIssues(g)).toEqual(['input_invalid']);
    } finally {
      release();
      await holder;
    }
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(await resolve(g)).toEqual(set(win1));
    expect(await saveIssues(g)).toEqual([]);
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

  // ── one time budget for the whole check ──

  /** A document with one fleet step per group named, and the issues of its group checks by step. */
  const groupIssues = async (groupIds: string[]) => (await validateFlowDocument({
    version: 1, name: 'Fleet', trigger: { type: 'manual' }, inputs: [],
    steps: groupIds.map((groupId, i) => ({ id: `s${i}`, tool: 'run_script_on_targets', input: { scriptId: randomUUID(), fleetFilter: { groupId } } })),
  }, { owner: { orgId, partnerId } })).issues.filter((i) => i.pointer?.endsWith('/fleetFilter/groupId')).map((i) => [i.stepId, i.code, i.message]);
  const timedOut = (n: number) => Array.from({ length: n }, (_, i) => [`s${i}`, 'input_invalid', expect.stringContaining('could not be checked in time')]);
  /** `n` dynamic groups, each naming the next, down to a static group. Head first. */
  async function chain(n: number): Promise<string[]> {
    const ids = [await group({ type: 'static' })];
    for (let i = 0; i < n; i += 1) ids.unshift(await group({ filterConditions: all(rule('groupId', 'equals', ids[0])) }));
    return ids;
  }
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => { taken = r; });
    const holder = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE group_membership_log IN ACCESS EXCLUSIVE MODE`);
      taken();
      await Promise.race([released, new Promise((r) => setTimeout(r, 30_000))]);
    });
    await Promise.race([isTaken, holder]);
    try {
      return await fn();
    } finally {
      release();
      await holder;
    }
  }

  runDb('a document reads each group once, in one transaction, however many steps reach it', async () => {
    const ids = await chain(5);
    const heads = [ids[0]!, ids[2]!, ids[5]!];
    const transactions = new Set<unknown>();
    hook.afterLoad = async (executor) => {
      const [row] = await (executor as ReturnType<typeof getTestDb>).execute(sql`select now()::text || '/' || pg_backend_pid() as tx`) as unknown as Array<Record<string, unknown>>;
      transactions.add(row!.tx);
    };
    const issues = await groupIssues(Array.from({ length: 40 }, (_, i) => heads[i % 3]!));
    expect(issues).toEqual([]);
    // The three named groups with the static one among them (three reads), then the two levels of rules they leave.
    expect([hook.loads, hook.statements, transactions.size]).toEqual([3, 5, 1]);
  }, 60_000);

  runDb('a document whose check outruns its budget is refused at every step, whatever each read takes', async () => {
    const a = await chain(9);
    const b = await chain(9);
    hook.afterLoad = async (executor) => { await (executor as ReturnType<typeof getTestDb>).execute(sql`select pg_sleep(0.3)`); };
    const started = Date.now();
    const issues = await groupIssues([a[0]!, b[0]!, a[0]!]);
    const ms = Date.now() - started;
    expect(issues).toEqual(timedOut(3));
    expect(hook.loads).toBeGreaterThan(1);
    expect(ms).toBeLessThan(5_000);
    hook.afterLoad = undefined;
    expect(await groupIssues([a[0]!, b[0]!, a[0]!])).toEqual([]); // control: only time refused them
  }, 60_000);

  runDb('a document of many static groups is refused once the read waits too long, and passes when it does not', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) ids.push(await group({ type: 'static' }));
    const started = Date.now();
    const issues = await locked(() => groupIssues(ids));
    const ms = Date.now() - started;
    expect(issues).toEqual(timedOut(20));
    expect(ms).toBeLessThan(5_000);
    expect([hook.loads, hook.statements]).toEqual([1, 3]);
    hook.loads = 0;
    expect(await groupIssues(ids)).toEqual([]);
    expect(hook.loads).toBe(1);
  }, 60_000);

  runDb('a step whose group check outruns its budget is refused at resolve, whatever each read takes', async () => {
    const ids = await chain(5);
    await member(ids[5]!, win1);
    hook.afterLoad = async (executor) => { await (executor as ReturnType<typeof getTestDb>).execute(sql`select pg_sleep(0.2)`); };
    const out = await resolve(ids[0]!);
    expect(out).toMatchObject({ kind: 'outcome', outcome: { code: 'targets_unresolvable', message: GROUP_CHECK_TIMEOUT_PROBLEM } });
    expect(hook.loads).toBeGreaterThan(1);
    expect(hook.loads).toBeLessThan(6);
    hook.afterLoad = undefined;
    expect(await resolve(ids[0]!)).toEqual(set(win1)); // control
  }, 60_000);

  // #12656 / #12715: the statement that restores the timeout after the last
  // read runs under the limit that read had. Every read finished, so the check
  // stands: the restore calls no function a search_path could slow down.
  runDb('a save whose reads finished passes its group check when only the restore would be slow', async () => {
    const g = await group({ filterConditions: all(rule('osType', 'equals', 'windows')) });
    await withSlowTimeoutRestore(async (slow) => {
      hook.afterLoad = (executor) => slow(executor as ReturnType<typeof getTestDb>);
      expect(await groupIssues([g, g])).toEqual([]);
      expect(hook.loads).toBe(1);
    });
    hook.afterLoad = undefined;
    expect(await groupIssues([g, g])).toEqual([]); // control
  }, 60_000);

  runDb('a step whose reads finished resolves its group when only the restore would be slow', async () => {
    const g = await group({ filterConditions: all(rule('osType', 'equals', 'windows')) });
    await withSlowTimeoutRestore(async (slow) => {
      hook.afterLoad = (executor) => slow(executor as ReturnType<typeof getTestDb>);
      expect(await resolve(g)).toEqual(set(win1, win2));
      expect(hook.loads).toBe(1);
    });
    hook.afterLoad = undefined;
    expect(await resolve(g)).toEqual(set(win1, win2)); // control
  }, 60_000);

  runDb('the number of steps that may name a group is the document\'s own step limit', async () => {
    const g = await group({ type: 'static' });
    expect(await groupIssues(Array.from({ length: FLOW_LIMITS.maxSteps }, () => g))).toEqual([]);
    expect(hook.loads).toBe(1);
    hook.loads = 0;
    const tooMany = await validateFlowDocument({
      version: 1, name: 'Fleet', trigger: { type: 'manual' }, inputs: [],
      steps: Array.from({ length: FLOW_LIMITS.maxSteps + 1 }, (_, i) => ({ id: `s${i}`, tool: 'run_script_on_targets', input: { scriptId: randomUUID(), fleetFilter: { groupId: g } } })),
    }, { owner: { orgId, partnerId } });
    expect(tooMany.issues.map((i) => i.code)).toEqual(['schema']);
    expect(hook.loads).toBe(0);
  }, 60_000);
});
