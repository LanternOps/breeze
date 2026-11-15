/**
 * Org-group membership writers that run inside a request (group create, group
 * update and its site prune, pin and unpin, manual add and remove) take the
 * organization's export lock BEFORE they touch a membership row, the same
 * order the per-device writer, the device cleanup and the sweep use. With the
 * opposite order two writers wait on each other and Postgres aborts one of
 * them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroups, deviceGroupMemberships, organizations } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { groupRoutes } from '../../routes/groups';
import { groupsRoutes as deviceGroupsRoutes } from '../../routes/devices/groups';
import type { AiTool } from '../../services/aiTools';
import { registerFleetTools } from '../../services/aiToolsFleet';
import { deleteDeviceGroup } from '../../services/deviceGroupDelete';
import { applyOrgDefaultDeviceGroup } from '../../services/enrollmentDefaultGroup';
import { createAccessToken } from '../../services/jwt';
import {
  addManualGroupMemberships,
  evaluateGroupMembership,
  pinDeviceToGroup,
  pruneGroupMembershipsOutsideSite,
  removeDeviceFromAllGroups,
  removeManualGroupMemberships,
  updateDeviceMembership,
} from '../../services/groupMembership';
import { shutdownDeviceGroupJobs } from '../../jobs/deviceGroupJobs';
import * as ownership from '../../services/deviceGroupOwnership';
import { closeRedis } from '../../services/redis';
import { createDevice, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { backendPid, fixture, gate, members, waitForBlock, waitForStart } from './partnerDeviceGroupEvaluation.helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await shutdownDeviceGroupJobs(); await closeRedis(); });

/** 'ok', or the SQLSTATE the writer failed with (a driver error wraps it in `cause`). */
function outcome(s: PromiseSettledResult<unknown>): string {
  if (s.status === 'fulfilled') return 'ok';
  const err = s.reason as { code?: string; cause?: { code?: string } };
  return err?.cause?.code ?? err?.code ?? String(s.reason);
}

/** A filter the seeded device ("srv-partner") does not match, so both writers remove it. */
const nonMatchingFilter = {
  operator: 'AND' as const,
  conditions: [{ field: 'hostname', operator: 'startsWith' as const, value: 'no-such-host-' }],
};

/**
 * Pause the writer that takes the export lock first (the one started first)
 * right after it takes it, before its first membership write, and report its
 * backend pid.
 */
function pausePerDeviceWriterAfterExportLock() {
  const holding = gate();
  const release = gate();
  let pid = 0;
  let first = true;
  const realExport = ownership.acquireMembershipExportOrgLock;
  vi.spyOn(ownership, 'acquireMembershipExportOrgLock').mockImplementation(async (orgId) => {
    await realExport(orgId);
    if (first) {
      first = false;
      pid = await backendPid();
      holding.release();
      await release.promise;
    }
  });
  return { holding, release, pid: () => pid };
}

describe('request-path org-group membership writers lock the organization first', () => {
  runDb('a filter re-evaluation racing a per-device evaluation of the same device does not deadlock', async () => {
    const f = await fixture();
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Request-path order', orgId: f.a.orgId, type: 'dynamic',
      filterConditions: nonMatchingFilter, filterFieldsUsed: ['hostname'],
    }).returning());
    if (!group) throw new Error('missing org group');
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));

    const perDeviceGate = pausePerDeviceWriterAfterExportLock();
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    let wholePid = 0;
    let whole: Promise<unknown> | undefined;
    try {
      await waitForStart(perDeviceGate.holding.promise, perDevice);
      const wholeStarted = gate();
      whole = withSystemDbAccessContext(async () => {
        wholePid = await backendPid();
        wholeStarted.release();
        // How the group create and update routes call it.
        return evaluateGroupMembership(group.id);
      });
      await waitForStart(wholeStarted.promise, whole);
      await waitForBlock(wholePid, perDeviceGate.pid());
    } finally {
      perDeviceGate.release.release();
    }
    const settled = await Promise.allSettled([perDevice, whole!]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok']);
    expect(await members(group.id)).toEqual([]);
  }, 20000);

  runDb('a site prune racing a per-device evaluation of the same device does not deadlock', async () => {
    const f = await fixture();
    const otherSite = await createSite({ orgId: f.a.orgId });
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Request-path prune order', orgId: f.a.orgId, siteId: otherSite.id, type: 'dynamic',
      filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'startsWith', value: 'srv-' }] },
      filterFieldsUsed: ['hostname'],
    }).returning());
    if (!group) throw new Error('missing org group');
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));

    const perDeviceGate = pausePerDeviceWriterAfterExportLock();
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    let prunePid = 0;
    let prune: Promise<unknown> | undefined;
    try {
      await waitForStart(perDeviceGate.holding.promise, perDevice);
      const pruneStarted = gate();
      prune = withSystemDbAccessContext(async () => {
        prunePid = await backendPid();
        pruneStarted.release();
        // How the group update route calls it: in a savepoint of the request transaction.
        return db.transaction((tx) => pruneGroupMembershipsOutsideSite(
          group.id, otherSite.id, f.a.orgId, tx, { deferPeripheralReconciliation: true, group },
        ));
      });
      await waitForStart(pruneStarted.promise, prune);
      await waitForBlock(prunePid, perDeviceGate.pid());
    } finally {
      perDeviceGate.release.release();
    }
    const settled = await Promise.allSettled([perDevice, prune!]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok']);
    expect(await members(group.id)).toEqual([]);
    // Nothing stranded: neither transaction is still open.
    const [open] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction (aborted)'`);
    expect(open?.n ?? 0).toBe(0);
  }, 20000);

  runDb('pinning a dynamic member racing a per-device evaluation of the same device does not deadlock', async () => {
    const f = await fixture();
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Pin order', orgId: f.a.orgId, type: 'dynamic',
      filterConditions: nonMatchingFilter, filterFieldsUsed: ['hostname'],
    }).returning());
    if (!group) throw new Error('missing org group');
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));
    const perDeviceGate = pausePerDeviceWriterAfterExportLock();
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    let pinPid = 0;
    let pin: Promise<unknown> | undefined;
    try {
      await waitForStart(perDeviceGate.holding.promise, perDevice);
      const started = gate();
      pin = withSystemDbAccessContext(async () => {
        pinPid = await backendPid();
        started.release();
        return pinDeviceToGroup(group.id, f.a.deviceId, true, f.a.orgId);
      });
      await waitForStart(started.promise, pin);
      await waitForBlock(pinPid, perDeviceGate.pid());
    } finally {
      perDeviceGate.release.release();
    }
    const settled = await Promise.allSettled([perDevice, pin!]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok']);
  }, 20000);

  for (const action of ['remove'] as const) {
    runDb(`a manual ${action} racing the device's group cleanup does not deadlock`, async () => {
      const f = await fixture();
      const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
        name: `Manual ${action} order`, orgId: f.a.orgId, type: 'static',
      }).returning());
      const [other] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
        name: `Manual ${action} other`, orgId: f.a.orgId, type: 'static',
      }).returning());
      if (!group || !other) throw new Error('missing static group');
      // The cleanup deletes every membership of the device, including the one
      // the manual writer removes.
      await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values([
        { groupId: other.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'manual' as const },
        { groupId: group.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'manual' as const },
      ]));

      const cleanupGate = pausePerDeviceWriterAfterExportLock();
      const cleanup = withSystemDbAccessContext(() => removeDeviceFromAllGroups(f.a.deviceId));
      let manualPid = 0;
      let manual: Promise<unknown> | undefined;
      try {
        await waitForStart(cleanupGate.holding.promise, cleanup);
        const started = gate();
        manual = withSystemDbAccessContext(async () => {
          manualPid = await backendPid();
          started.release();
          return removeManualGroupMemberships({ groupId: group.id, group, deviceIds: [f.a.deviceId] });
        });
        await waitForStart(started.promise, manual);
        await waitForBlock(manualPid, cleanupGate.pid());
      } finally {
        cleanupGate.release.release();
      }
      const settled = await Promise.allSettled([cleanup, manual!]);
      expect(settled.map(outcome)).toEqual(['ok', 'ok']);
    }, 20000);
  }
});

/** Wait until some backend is blocked by `blocker` (the writer's pid is not known up front). */
async function waitForAnyBlockedBy(blocker: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await getTestDb().execute<{ pid: number }>(sql`
      SELECT pid FROM pg_stat_activity WHERE ${blocker}::integer = ANY(pg_blocking_pids(pid))`);
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nothing became blocked by backend ${blocker}`);
}

/** A writer's result: 'ok', or what it failed with (SQLSTATE, HTTP status, tool error). */
async function settle(work: Promise<unknown>): Promise<string> {
  try {
    const value = await work;
    if (value instanceof Response) return value.ok ? 'ok' : `http ${value.status}`;
    if (typeof value === 'string' && value.includes('"error"')) return `tool ${value}`;
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.cause?.code ?? e?.code ?? String(err);
  }
}

type WriterKind = 'add' | 'remove';
type Writer = { name: string; kind: WriterKind; run: (ctx: WriterContext) => unknown };
type WriterContext = { env: TestEnvironment; groupId: string; deviceId: string; token: string };

function orgAuth(env: TestEnvironment): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([env.organization.id]);
  return {
    principal: { kind: 'user_session' },
    user: { id: env.user.id, email: env.user.email, name: 'Fixture', isPlatformAdmin: false },
    token: { sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id, scope: 'organization', type: 'access', mfa: true },
    partnerId: env.partner.id,
    orgId: env.organization.id,
    scope: 'organization',
    accessibleOrgIds: [env.organization.id],
    orgCondition,
    canAccessOrg,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

const fleetTools = new Map<string, AiTool>();
registerFleetTools(fleetTools);

function routeApp(): Hono {
  const app = new Hono();
  app.route('/groups', groupRoutes);
  app.route('/devices', deviceGroupsRoutes);
  return app;
}

/**
 * Every writer that adds or removes a membership row of its own. Each one
 * races an export-first writer (a pin of the same device into the same group)
 * that holds the export lock and then writes that same row: a writer that
 * wrote its row before taking the lock would deadlock with it.
 */
const WRITERS: Writer[] = [
  { name: 'shared manual add', kind: 'add', run: ({ env, groupId, deviceId }) => withSystemDbAccessContext(() =>
    addManualGroupMemberships({ groupId, orgId: env.organization.id, deviceIds: [deviceId] })) },
  { name: 'shared manual remove', kind: 'remove', run: ({ groupId, deviceId }) => withSystemDbAccessContext(() =>
    removeManualGroupMemberships({ groupId, deviceIds: [deviceId] })) },
  { name: 'device group route add', kind: 'add', run: ({ groupId, deviceId, token }) => routeApp().request(`/devices/groups/${groupId}/members`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceIds: [deviceId] }),
  }) },
  { name: 'device group route remove', kind: 'remove', run: ({ groupId, deviceId, token }) => routeApp().request(`/devices/groups/${groupId}/members`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceIds: [deviceId] }),
  }) },
  { name: 'group route single remove', kind: 'remove', run: ({ groupId, deviceId, token }) => routeApp().request(`/groups/${groupId}/devices/${deviceId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  }) },
  { name: 'AI fleet tool add', kind: 'add', run: ({ env, groupId, deviceId }) => withSystemDbAccessContext(() =>
    fleetTools.get('manage_groups')!.handler({ action: 'add_devices', groupId, deviceIds: [deviceId] }, orgAuth(env))) },
  { name: 'AI fleet tool remove', kind: 'remove', run: ({ env, groupId, deviceId }) => withSystemDbAccessContext(() =>
    fleetTools.get('manage_groups')!.handler({ action: 'remove_devices', groupId, deviceIds: [deviceId] }, orgAuth(env))) },
  // Enrollment never fails on its default group (it logs and skips), so a
  // skipped write is the failure signal here.
  { name: 'enrollment default group', kind: 'add', run: async ({ env, deviceId }) => {
    const outcome = await withSystemDbAccessContext(() =>
      applyOrgDefaultDeviceGroup(db as never, { orgId: env.organization.id, deviceId, siteId: env.site.id }));
    if (outcome !== 'added') throw new Error(`default group ${outcome}`);
    return outcome;
  } },
];

describe('every membership writer takes the export lock before its row', () => {
  for (const writer of WRITERS) {
    runDb(`${writer.name} racing an export-first writer on the same row does not deadlock`, async () => {
      const env = await setupTestEnvironment();
      const token = await createAccessToken({
        sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
        scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
      });
      const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id, hostname: 'srv-race' });
      const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
        name: `Writer race ${writer.name}`, orgId: env.organization.id, type: 'static',
      }).returning());
      if (!group) throw new Error('missing static group');
      if (writer.kind === 'remove') {
        await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
          groupId: group.id, deviceId: device.id, orgId: env.organization.id, addedBy: 'manual',
        }));
      }
      if (writer.name === 'enrollment default group') {
        await getTestDb().update(organizations).set({ settings: { defaults: { deviceGroup: group.id } } })
          .where(eq(organizations.id, env.organization.id));
      }

      const pinGate = pausePerDeviceWriterAfterExportLock();
      const pin = withSystemDbAccessContext(() => pinDeviceToGroup(group.id, device.id, true, env.organization.id));
      let work: Promise<unknown> | undefined;
      try {
        await waitForStart(pinGate.holding.promise, pin);
        work = Promise.resolve(writer.run({ env, groupId: group.id, deviceId: device.id, token }));
        await waitForAnyBlockedBy(pinGate.pid());
      } finally {
        pinGate.release.release();
      }
      expect([await settle(pin), await settle(work!)]).toEqual(['ok', 'ok']);
      // The pin landed; a remove that ran after it may have taken the row away again.
      const rows = await withSystemDbAccessContext(() => db.select().from(deviceGroupMemberships)
        .where(and(eq(deviceGroupMemberships.groupId, group.id), eq(deviceGroupMemberships.deviceId, device.id))));
      expect(rows.length).toBeLessThanOrEqual(1);
    }, 20000);
  }
});

/**
 * Deleting an org-owned group is not yet in the export-first order (it locks
 * the group row first). Until it is, the org-path delete retries once when
 * Postgres picks it as a deadlock victim.
 */
describe('deleting an org-owned group racing a device evaluation', () => {
  const matchingFilter = { operator: 'AND' as const, conditions: [{ field: 'hostname', operator: 'startsWith' as const, value: 'srv-' }] };

  async function raceDeleteWithPerDevice(f: Awaited<ReturnType<typeof fixture>>, groupId: string) {
    const perDeviceGate = pausePerDeviceWriterAfterExportLock();
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    let deletePid = 0;
    let del: Promise<unknown> | undefined;
    try {
      await waitForStart(perDeviceGate.holding.promise, perDevice);
      const started = gate();
      del = withSystemDbAccessContext(async () => {
        deletePid = await backendPid();
        started.release();
        return deleteDeviceGroup(groupId, { orgId: f.a.orgId });
      });
      await waitForStart(started.promise, del);
      await waitForBlock(deletePid, perDeviceGate.pid());
    } finally {
      perDeviceGate.release.release();
    }
    return (await Promise.allSettled([perDevice, del!])).map(outcome);
  }

  runDb('a delete racing a per-device removal from the group completes', async () => {
    const f = await fixture();
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Delete race remove', orgId: f.a.orgId, type: 'dynamic', filterConditions: nonMatchingFilter, filterFieldsUsed: ['hostname'],
    }).returning());
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group!.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));
    expect(await raceDeleteWithPerDevice(f, group!.id)).toEqual(['ok', 'ok']);
    const [still] = await withSystemDbAccessContext(() => db.select().from(deviceGroups).where(eq(deviceGroups.id, group!.id)));
    expect(still).toBeUndefined();
  }, 20000);

  runDb('a delete racing a per-device addition to the group completes', async () => {
    const f = await fixture();
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Delete race add', orgId: f.a.orgId, type: 'dynamic', filterConditions: matchingFilter, filterFieldsUsed: ['hostname'],
    }).returning());
    const second = await createDevice({ orgId: f.a.orgId, siteId: f.a.siteId, hostname: 'srv-second' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group!.id, deviceId: second.id, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));
    expect(await raceDeleteWithPerDevice(f, group!.id)).toEqual(['ok', 'ok']);
  }, 20000);
});
