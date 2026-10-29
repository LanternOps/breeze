/**
 * #10692: a partner-owned device-group delete racing an org merge of one of
 * that partner's orgs must not deadlock (40P01).
 *
 * The delete (#10521 W3, PR #10690) takes the group row FOR UPDATE and then the
 * partner-export org locks over every org of the partner. The merge takes the
 * export locks of its two orgs first, and its loser-membership repoint fires
 * the deferred `device_group_memberships_group_owner_check` trigger, which
 * takes FOR KEY SHARE on the group row at COMMIT. Without a group-row lock
 * taken BEFORE the export locks, the two orders cross.
 *
 * `deletePartnerGroup` below mirrors the transactional part of the W3
 * `deleteDeviceGroup(groupId, { partnerId })` lock for lock. Swap it for the
 * real service once #10690 is on main.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog, organizations } from '../../db/schema';
import * as orgMerge from '../../services/orgMerge';
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

/** Lock order of the W3 partner delete: group FOR UPDATE, export org locks, deletes. */
async function deletePartnerGroup(groupId: string, partnerId: string, onLocked?: (pid: number) => void) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
    const [group] = await tx.select({ id: deviceGroups.id }).from(deviceGroups)
      .where(eq(deviceGroups.id, groupId)).for('update');
    if (!group) throw new Error('group not found');
    onLocked?.(await backendPid());
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
      let deletePid = 0;
      const deleteStarted = gate();
      // Without the fix the delete gets its FOR UPDATE and blocks on the
      // export lock; with it, it blocks on the group row. Either way it waits.
      remove = deletePartnerGroup(f.group.id, f.partnerId, (pid) => { deletePid = pid; deleteStarted.release(); });
      void remove.catch(() => {});
      const deletePidNow = await Promise.race([
        deleteStarted.promise.then(() => deletePid),
        (async () => {
          // With the fix the delete blocks before it reports a pid; find it by query.
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const rows = await getTestDb().execute<{ pid: number }>(sql`
              SELECT pid FROM pg_stat_activity
               WHERE ${mergePid}::int = ANY(pg_blocking_pids(pid)) AND query ILIKE '%device_groups%for update%'`);
            if (rows[0]) return rows[0].pid;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return 0;
        })(),
      ]);
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
    const remove = runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
      await tx.select({ id: deviceGroups.id }).from(deviceGroups).where(eq(deviceGroups.id, f.group.id)).for('update');
      deletePid = await backendPid();
      deleteLocked.release();
      await releaseDelete.promise;
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY(
        SELECT id FROM organizations WHERE partner_id = ${f.partnerId}::uuid ORDER BY id)::uuid[])`);
      await tx.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, f.group.id));
      await tx.delete(deviceGroups).where(eq(deviceGroups.id, f.group.id));
    })));
    void remove.catch(() => {});
    let merge: ReturnType<typeof orgMerge.executeOrgMerge> | undefined;
    try {
      await waitForStart(deleteLocked.promise, remove);
      merge = orgMerge.executeOrgMerge({
        loserOrgId: f.loser.orgId, survivorOrgId: f.survivor.orgId, partnerId: f.partnerId, performedBy: actor,
      });
      void merge.catch(() => {});
      // The merge blocks either on the group row (fixed) or on nothing until
      // commit (unfixed); give it time to reach whichever it hits first.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await getTestDb().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${deletePid}::int = ANY(pg_blocking_pids(pid))`);
        if ((row?.n ?? 0) > 0) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
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
