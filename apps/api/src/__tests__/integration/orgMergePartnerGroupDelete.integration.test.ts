/**
 * #10692: a partner-owned device-group delete racing an org merge of one of
 * that partner's orgs must not deadlock (40P01).
 *
 * The delete (`deleteDeviceGroup(groupId, { partnerId })`, #10521 W3) takes the
 * group row FOR UPDATE and then the partner-export org locks over every org of
 * the partner plus every org with a membership in the group. The merge takes
 * the export locks of its two orgs, and its loser-membership repoint fires the
 * deferred `device_group_memberships_group_owner_check` trigger, which takes
 * FOR KEY SHARE on the group row at COMMIT. Unless the merge takes the group
 * row BEFORE its export locks, the two orders cross.
 *
 * The first test drives the real service. The second needs the delete paused
 * between its FOR UPDATE and its export locks, which the service offers no
 * seam for, so `deletePartnerGroupPausable` reproduces that part of its lock
 * order (group FOR UPDATE, then the same export-lock set) with a pause hook.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog, organizations } from '../../db/schema';
import * as orgMerge from '../../services/orgMerge';
import { deleteDeviceGroup } from '../../services/deviceGroupDelete';
import { shutdownDeviceGroupJobs } from '../../jobs/deviceGroupJobs';
import { closeRedis } from '../../services/redis';
import { createPartner } from './db-utils';
import { backendPid, gate, members, seedGroup, seedOrg, waitForBlock, waitForStart } from './partnerDeviceGroupEvaluation.helpers';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const actor = '00000000-0000-0000-0000-000000000000';

beforeEach(() => { vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await shutdownDeviceGroupJobs(); await closeRedis(); });

/** `deleteDeviceGroup`'s partner lock order (group FOR UPDATE, export org locks, deletes) with a pause after the row lock. */
async function deletePartnerGroupPausable(
  groupId: string,
  partnerId: string,
  onLocked: (pid: number) => Promise<void>,
) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    const [group] = await tx.select({ id: deviceGroups.id }).from(deviceGroups)
      .where(eq(deviceGroups.id, groupId)).for('update');
    if (!group) throw new Error('group not found');
    await onLocked(await backendPid());
    await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY(
      SELECT org_id FROM (
        SELECT ${organizations.id} AS org_id FROM ${organizations}
          WHERE ${organizations.partnerId} = ${partnerId}
        UNION
        SELECT ${deviceGroupMemberships.orgId} AS org_id FROM ${deviceGroupMemberships}
          WHERE ${deviceGroupMemberships.groupId} = ${groupId}
      ) AS affected_orgs ORDER BY org_id
    )::uuid[])`);
    await tx.delete(groupMembershipLog).where(eq(groupMembershipLog.groupId, groupId));
    await tx.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
    await tx.delete(deviceGroups).where(eq(deviceGroups.id, groupId));
  })));
}

async function seedMergeFixture() {
  const partner = await createPartner();
  const loser = await seedOrg(partner.id);
  const survivor = await seedOrg(partner.id);
  const group = await seedGroup(partner.id);
  await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
    groupId: group.id, deviceId: loser.deviceId, orgId: loser.orgId, addedBy: 'dynamic_rule',
  }));
  return { partnerId: partner.id, loser, survivor, group };
}

const sqlState = (err: unknown): string | undefined => {
  let node: unknown = err;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
};

async function expectMergedAndDeleted(f: Awaited<ReturnType<typeof seedMergeFixture>>) {
  const [device] = await withSystemDbAccessContext(() =>
    db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, f.loser.deviceId)));
  expect(device?.orgId).toBe(f.survivor.orgId);
  const remaining = await getTestDb().execute(sql`SELECT id FROM device_groups WHERE id = ${f.group.id}::uuid`);
  expect(remaining).toHaveLength(0);
  expect(await members(f.group.id)).toEqual([]);
}

describe('org merge racing a partner-group delete (#10692)', () => {
  runDb('a delete arriving while the merge holds its export locks waits and both commit without 40P01', async () => {
    const f = await seedMergeFixture();
    const mergeLocked = gate();
    const releaseMerge = gate();
    let mergePid = 0;
    const realValidate = orgMerge.assertPairStillMergeable;
    // Runs inside Phase B right after the export locks: hold the merge there
    // until the delete is queued behind it.
    vi.spyOn(orgMerge, 'assertPairStillMergeable').mockImplementation(async (...args) => {
      await realValidate(...args);
      await db.execute(sql`SET LOCAL statement_timeout = '20s'`);
      mergePid = await backendPid();
      mergeLocked.release();
      await releaseMerge.promise;
    });
    const merge = orgMerge.executeOrgMerge({
      loserOrgId: f.loser.orgId, survivorOrgId: f.survivor.orgId, partnerId: f.partnerId, performedBy: actor,
    });
    void merge.catch(() => {});
    let remove: Promise<void> | undefined;
    try {
      await waitForStart(mergeLocked.promise, merge);
      // Without the fix the delete gets its FOR UPDATE and waits on the export
      // lock; with it, it waits on the group row. Either way it must queue
      // behind the merge before the merge is released.
      remove = deleteDeviceGroup(f.group.id, { partnerId: f.partnerId }).then(() => undefined);
      void remove.catch(() => {});
      let deletePidNow = 0;
      const deadline = Date.now() + 15000;
      while (deletePidNow === 0 && Date.now() < deadline) {
        const rows = await getTestDb().execute<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
           WHERE ${mergePid}::int = ANY(pg_blocking_pids(pid))
             AND (query ILIKE '%device_groups%for update%'
                  OR query ILIKE '%breeze_partner_export_lock_orgs_exclusive%')`);
        if (rows[0]) deletePidNow = rows[0].pid;
        else await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(deletePidNow).not.toBe(0);
      await waitForBlock(deletePidNow, mergePid);
    } finally {
      releaseMerge.release();
    }
    const [mergeOutcome, deleteOutcome] = await Promise.allSettled([merge, remove!]);
    const codes = [mergeOutcome, deleteOutcome]
      .map((o) => (o.status === 'rejected' ? sqlState(o.reason) ?? String(o.reason) : 'ok'));
    expect(codes).toEqual(['ok', 'ok']);
    await expectMergedAndDeleted(f);
  }, 60000);

  runDb('a merge arriving while the delete holds the group row waits and both commit without 40P01', async () => {
    const f = await seedMergeFixture();
    const deleteLocked = gate();
    const releaseDelete = gate();
    let deletePid = 0;
    // Paused between its FOR UPDATE and its export locks.
    const remove = deletePartnerGroupPausable(f.group.id, f.partnerId, async (pid) => {
      deletePid = pid;
      deleteLocked.release();
      await releaseDelete.promise;
    });
    void remove.catch(() => {});
    let merge: ReturnType<typeof orgMerge.executeOrgMerge> | undefined;
    try {
      await waitForStart(deleteLocked.promise, remove);
      merge = orgMerge.executeOrgMerge({
        loserOrgId: f.loser.orgId, survivorOrgId: f.survivor.orgId, partnerId: f.partnerId, performedBy: actor,
      });
      void merge.catch(() => {});
      // Do not release the delete until the merge is provably waiting on it:
      // on the group row's KEY SHARE before its export locks (fixed), or on
      // the deferred owner check's KEY SHARE at COMMIT (unfixed). Releasing
      // earlier would let the two run one after the other and pass vacuously.
      const deadline = Date.now() + 15000;
      let mergeBlocked = false;
      while (!mergeBlocked && Date.now() < deadline) {
        const [row] = await getTestDb().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE ${deletePid}::int = ANY(pg_blocking_pids(pid))
             AND (query ILIKE '%device_groups%' OR query ILIKE 'commit%')`);
        mergeBlocked = (row?.n ?? 0) > 0;
        if (!mergeBlocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(mergeBlocked).toBe(true);
    } finally {
      releaseDelete.release();
    }
    const [deleteOutcome, mergeOutcome] = await Promise.allSettled([remove, merge!]);
    const codes = [mergeOutcome, deleteOutcome]
      .map((o) => (o.status === 'rejected' ? sqlState(o.reason) ?? String(o.reason) : 'ok'));
    expect(codes).toEqual(['ok', 'ok']);
    await expectMergedAndDeleted(f);
  }, 60000);
});
