/** Revision guards must observe commits made while waiting for membership admission. */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroups } from '../../db/schema';
import * as ownership from '../../services/deviceGroupOwnership';
import * as evaluation from '../../services/partnerGroupEvaluation';
import { updateDeviceMembership } from '../../services/groupMembership';
import { processPartnerGroupEvaluation } from '../../jobs/partnerGroupEvaluationJobs';
import { closeRedis } from '../../services/redis';
import { backendPid, fixture, gate, members, waitForBlock, waitForStart } from './partnerDeviceGroupEvaluation.helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterEach(() => vi.restoreAllMocks());
afterAll(() => closeRedis());

describe('partner group revision admission', () => {
  runDb('a whole-org writer rereads the revision after waiting and preserves a newer per-device result', async () => {
    const f = await fixture({ operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'wks-old-filter' }] });
    const held = gate();
    const releaseHolder = gate();
    const writerWaiting = gate();
    let holderPid = 0;
    let writerPid = 0;
    const acquire = ownership.acquireGroupOrgMembershipLocks;
    vi.spyOn(ownership, 'acquireGroupOrgMembershipLocks').mockImplementation(async (pairs, mode) => {
      if (mode === 'exclusive') {
        writerPid = await backendPid();
        writerWaiting.release();
      }
      return acquire(pairs, mode);
    });
    // Shared holders admit the newer per-device writer while excluding the
    // older whole-org writer, making the revision race deterministic.
    const holder = withSystemDbAccessContext(async () => {
      holderPid = await backendPid();
      await acquire([{ groupId: f.group.id, orgId: f.a.orgId }], 'shared');
      held.release();
      await releaseHolder.promise;
      return updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId);
    });
    void holder.catch(() => undefined);
    let writer: ReturnType<typeof evaluation.evaluatePartnerGroupForOrg> | undefined;
    try {
      await waitForStart(held.promise, holder);
      writer = evaluation.evaluatePartnerGroupForOrg(f.group.id, f.a.orgId, { expectedRevision: f.group.filterRevision });
      void writer.catch(() => undefined);
      await waitForStart(writerWaiting.promise, writer);
      await waitForBlock(writerPid, holderPid);
      await withSystemDbAccessContext(() => db.update(deviceGroups).set({
        filterRevision: f.group.filterRevision + 1,
        filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'srv-partner' }] },
      }).where(eq(deviceGroups.id, f.group.id)));
      // Re-enter the holder's shared key: a new connection would queue behind
      // the exclusive waiter. Its per-device write commits before the waiting
      // whole-org writer can acquire admission.
      releaseHolder.release();
    } finally {
      releaseHolder.release();
      await Promise.allSettled([holder, ...(writer ? [writer] : [])]);
    }
    if (!writer) throw new Error('writer did not start');
    expect(await holder).toMatchObject({ added: 1, removed: 0 });
    expect(await writer).toMatchObject({ status: 'superseded', added: 0, removed: 0 });
    expect((await members(f.group.id)).map(row => row.deviceId)).toEqual([f.a.deviceId]);
  }, 15000);

  runDb('a revision bump after the final org supersedes finalization and queues a fresh head', async () => {
    const f = await fixture();
    const evaluate = evaluation.evaluatePartnerGroupForOrg;
    let evaluated = 0;
    vi.spyOn(evaluation, 'evaluatePartnerGroupForOrg').mockImplementation(async (...args) => {
      const result = await evaluate(...args);
      evaluated += 1;
      if (evaluated === 2) {
        await withSystemDbAccessContext(() => db.update(deviceGroups)
          .set({ filterRevision: f.group.filterRevision + 1 }).where(eq(deviceGroups.id, f.group.id)));
      }
      return result;
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await processPartnerGroupEvaluation({
      type: 'partner-group-evaluation', groupId: f.group.id, revision: null, afterOrgId: null,
      failedOrgs: 0, evaluatedOrgs: 0, reason: 'revision_test', queuedAt: new Date().toISOString(),
    }, { enqueue, pageSize: 50 });
    expect(result).toMatchObject({ status: 'superseded', evaluatedOrgs: 2 });
    const [fresh] = await withSystemDbAccessContext(() => db.select().from(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    expect(fresh?.evaluatedRevision).toBe(f.group.evaluatedRevision);
    expect(fresh?.evaluatedAt).toEqual(f.group.evaluatedAt);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      groupId: f.group.id, revision: null, afterOrgId: null, evaluatedOrgs: 0,
    }), { jobId: `partner-group-eval-${f.group.id}` });
  });
});
