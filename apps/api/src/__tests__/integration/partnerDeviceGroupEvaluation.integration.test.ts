/** #10521 W2b: partner evaluation through real transactions and event handlers. */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, devices, groupMembershipLog } from '../../db/schema';
import { updateDeviceMembership } from '../../services/groupMembership';
import { createDeviceChangeEvent, emitDeviceChange, initializeDeviceEventHandlers } from '../../events/deviceEvents';
import { createPartner, setupTestEnvironment } from './db-utils';
import { getDeviceGroupReevaluationQueue, runDeviceGroupReevaluationJob, shutdownDeviceGroupJobs } from '../../jobs/deviceGroupJobs';
import { evaluatePartnerGroupForOrg } from '../../services/partnerGroupEvaluation';
import { processPartnerGroupEvaluation, type PartnerGroupEvaluationJobData } from '../../jobs/partnerGroupEvaluationJobs';
import * as filterEngine from '../../services/filterEngine';
import * as ownership from '../../services/deviceGroupOwnership';
import { ingestSoftwareInventoryReport } from '../../services/softwareInventoryObservations';
import { resolvePatchConfigPolicyForDevice } from '../../services/featureConfigResolver';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createAccessToken } from '../../services/jwt';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';
import { awaitQueuedJob, backendPid, fixture, gate, inventoryReport, members, seedDevice, seedGroup, seedOrg, seedPartnerPolicy, softwareFilter, waitForBlock, waitForStart } from './partnerDeviceGroupEvaluation.helpers';
import { closeRedis } from '../../services/redis';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterEach(async () => {
  vi.restoreAllMocks();
  await getDeviceGroupReevaluationQueue().obliterate({ force: true });
});

afterAll(async () => { await shutdownDeviceGroupJobs(); await closeRedis(); });

describe('partner device group evaluation', () => {
  runDb('updateDeviceMembership adds a matching device in any partner org, writing the device org to membership and log', async () => {
    const f = await fixture();
    for (const member of [f.a, f.b]) {
      await withSystemDbAccessContext(() => updateDeviceMembership(member.deviceId, ['hostname'], member.orgId));
    }
    expect((await members(f.group.id)).map(m => [m.deviceId, m.orgId]).sort()).toEqual(
      [f.a, f.b].map(m => [m.deviceId, m.orgId]).sort());
    const logs = await withSystemDbAccessContext(() => db.select().from(groupMembershipLog)
      .where(eq(groupMembershipLog.groupId, f.group.id)));
    expect(logs.map(m => [m.deviceId, m.orgId]).sort()).toEqual([f.a, f.b].map(m => [m.deviceId, m.orgId]).sort());
  });

  runDb('device.created in a brand-new org joins the partner group', async () => {
    const f = await fixture();
    const fresh = await seedOrg(f.partnerId);
    initializeDeviceEventHandlers();
    await withSystemDbAccessContext(() => emitDeviceChange(createDeviceChangeEvent('device.created', fresh.deviceId, fresh.orgId, [])));
    expect((await members(f.group.id)).map(m => m.deviceId)).toEqual([fresh.deviceId]);
  });

  runDb('Quick Support and holding-org devices never join', async () => {
    const f = await fixture();
    for (const type of ['quick_support', 'unassigned_pool'] as const) {
      const excluded = await seedOrg(f.partnerId, type);
      await withSystemDbAccessContext(() => updateDeviceMembership(excluded.deviceId, ['hostname'], excluded.orgId));
    }
    expect(await members(f.group.id)).toEqual([]);
  });

  runDb('a foreign partner\'s device never joins', async () => {
    const f = await fixture();
    const foreignPartner = await createPartner();
    const foreign = await seedOrg(foreignPartner.id);
    await withSystemDbAccessContext(() => updateDeviceMembership(foreign.deviceId, ['hostname'], f.a.orgId));
    expect(await members(f.group.id)).toEqual([]);
  });

  runDb('each org runs in its own transaction; a filter timeout in one org keeps its previous members and reports ok: false', async () => {
    const f = await fixture();
    expect((await evaluatePartnerGroupForOrg(f.group.id, f.a.orgId)).added).toBe(1);
    const transactionIds: string[] = [];
    const original = filterEngine.evaluateFilter;
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementation(async (filter, opts) => {
      const [row] = await db.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
      if (!row) throw new Error('missing transaction id');
      transactionIds.push(row.id);
      if (opts.orgId === f.a.orgId) {
        await db.execute(sql`SELECT set_config('statement_timeout', '20ms', true)`);
        await db.execute(sql`SELECT pg_sleep(0.1)`);
      }
      return original(filter, opts);
    });
    await withSystemDbAccessContext(async () => {
      const [outer] = await db.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
      if (!outer) throw new Error('missing outer transaction id');
      const failed = await evaluatePartnerGroupForOrg(f.group.id, f.a.orgId);
      expect(failed).toMatchObject({ orgId: f.a.orgId, ok: false, status: 'failed', added: 0, removed: 0 });
      expect(failed.error).toContain('engine_error');
      expect(await evaluatePartnerGroupForOrg(f.group.id, f.b.orgId)).toMatchObject({ ok: true, added: 1 });
      expect(new Set([outer.id, ...transactionIds]).size).toBe(3);
    });
    expect((await members(f.group.id)).map(row => row.deviceId).sort()).toEqual([f.a.deviceId, f.b.deviceId].sort());
  });

  runDb('a per-device write racing a whole-group write for the same (group, org) does not lose the newer result', async () => {
    const f = await fixture();
    expect((await evaluatePartnerGroupForOrg(f.group.id, f.a.orgId)).added).toBe(1);
    const filterEntered = gate();
    const releaseFilter = gate();
    const deviceEntered = gate();
    let wholePid = 0;
    let devicePid = 0;
    const original = filterEngine.evaluateFilter;
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementationOnce(async (filter, opts) => {
      wholePid = await backendPid();
      filterEntered.release();
      await releaseFilter.promise;
      // This writer commits a newer device state while the competing evaluator
      // waits on its exclusive (group, org) advisory lock.
      await db.update(devices).set({ hostname: 'wks-new-state' }).where(eq(devices.id, f.a.deviceId));
      return original(filter, opts);
    });
    const whole = evaluatePartnerGroupForOrg(f.group.id, f.a.orgId);
    let perDevice: ReturnType<typeof updateDeviceMembership> | undefined;
    try {
      await waitForStart(filterEntered.promise, whole);
      perDevice = withSystemDbAccessContext(async () => {
        devicePid = await backendPid();
        deviceEntered.release();
        return updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId);
      });
      await waitForStart(deviceEntered.promise, perDevice);
      await waitForBlock(devicePid, wholePid);
    } finally {
      releaseFilter.release();
      await Promise.allSettled([whole, ...(perDevice ? [perDevice] : [])]);
    }
    if (!perDevice) throw new Error('per-device evaluation did not start');
    const [wholeResult] = await Promise.all([whole, perDevice]);
    expect(wholeResult).toMatchObject({ ok: true, removed: 1 });
    expect(await members(f.group.id)).toEqual([]);
  }, 15000);

  runDb('a per-device writer waiting behind a newer whole-group revision rereads the filter before writing', async () => {
    const f = await fixture();
    await withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    expect((await members(f.group.id)).map(row => row.deviceId)).toEqual([f.a.deviceId]);
    const candidatesLoaded = gate();
    const allowSharedLock = gate();
    const wholeFilterEntered = gate();
    const finishWholeFilter = gate();
    let devicePid = 0;
    let wholePid = 0;
    const originalLocks = ownership.acquireGroupOrgMembershipLocks;
    const originalFilter = filterEngine.evaluateFilter;
    vi.spyOn(ownership, 'acquireGroupOrgMembershipLocks').mockImplementation(async (pairs, mode) => {
      if (mode === 'shared') {
        // The device path has selected revision 1 and taken KEY SHARE rows,
        // but its membership advisory locks have not yet been acquired.
        devicePid = await backendPid();
        candidatesLoaded.release();
        await allowSharedLock.promise;
      }
      return originalLocks(pairs, mode);
    });
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementationOnce(async (filter, opts) => {
      wholePid = await backendPid();
      wholeFilterEntered.release();
      await finishWholeFilter.promise;
      return originalFilter(filter, opts);
    });
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId));
    void perDevice.catch(() => undefined);
    let whole: ReturnType<typeof evaluatePartnerGroupForOrg> | undefined;
    try {
      await waitForStart(candidatesLoaded.promise, perDevice);
      await withSystemDbAccessContext(() => db.update(deviceGroups).set({
        filterRevision: 2,
        filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'new-revision-only' }] },
      }).where(eq(deviceGroups.id, f.group.id)));
      whole = evaluatePartnerGroupForOrg(f.group.id, f.a.orgId, { expectedRevision: 2 });
      await waitForStart(wholeFilterEntered.promise, whole);
      allowSharedLock.release();
      await waitForBlock(devicePid, wholePid);
    } finally {
      allowSharedLock.release();
      finishWholeFilter.release();
      // Settle both transactions even if synchronization assertions fail.
      await Promise.allSettled([perDevice, ...(whole ? [whole] : [])]);
    }
    if (!whole) throw new Error('whole-group writer did not start');
    expect(await whole).toMatchObject({ ok: true, removed: 1 });
    expect(await perDevice).toMatchObject({ added: 0, removed: 0 });
    expect(await members(f.group.id)).toEqual([]);
  }, 15000);

  runDb.each(['add', 'delete'])('an org move racing a per-org evaluation of the same device does not deadlock (%s)', async (operation) => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const source = { orgId: env.organization.id, siteId: env.site.id,
      deviceId: await seedDevice(env.organization.id, env.site.id) };
    const target = await seedOrg(env.partner.id);
    const group = await seedGroup(env.partner.id);
    if (operation === 'delete') {
      expect((await evaluatePartnerGroupForOrg(group.id, source.orgId)).added).toBe(1);
      await withSystemDbAccessContext(() => db.update(devices).set({ hostname: 'wks-moving' }).where(eq(devices.id, source.deviceId)));
    }
    const moveEntered = gate();
    const finishMove = gate();
    const filterEntered = gate();
    let movePid = 0;
    let evaluatorPid = 0;
    const original = filterEngine.evaluateFilter;
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementationOnce(async (filter, opts) => {
      evaluatorPid = await backendPid();
      const result = await original(filter, opts);
      filterEntered.release();
      return result;
    });
    const move = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      movePid = await backendPid();
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${source.orgId}::uuid, ${target.orgId}::uuid])`);
      moveEntered.release();
      await finishMove.promise;
      return moveDeviceOrgInTransaction(tx, {
        deviceId: source.deviceId, sourceOrgId: source.orgId, targetOrgId: target.orgId,
        targetSiteId: target.siteId, targetOrgName: 'Target org', deviceLinkGroupId: null,
        acceptCurrencyMismatch: undefined, actor: { userId: env.user.id, allowedSiteIds: undefined },
        stepUp: null, via: 'generic_move',
      });
    }));
    let evaluation: ReturnType<typeof evaluatePartnerGroupForOrg> | undefined;
    try {
      await waitForStart(moveEntered.promise, move);
      evaluation = evaluatePartnerGroupForOrg(group.id, source.orgId);
      await waitForStart(filterEntered.promise, evaluation);
      // A SQL-observed wait, not a timer-based assumption: the evaluator's diff
      // exists but it has not taken a membership tuple lock ahead of the mover.
      await waitForBlock(evaluatorPid, movePid);
    } finally {
      finishMove.release();
      await Promise.allSettled([move, ...(evaluation ? [evaluation] : [])]);
    }
    if (!evaluation) throw new Error('per-org evaluation did not start');
    const [, result] = await Promise.all([move, evaluation]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 'evaluated' });
    expect(await members(group.id)).toEqual([]);
    const [moved] = await withSystemDbAccessContext(() => db.select().from(devices).where(eq(devices.id, source.deviceId)));
    expect(moved?.orgId).toBe(target.orgId);
  }, 20000);

  runDb('filter edit mid-pagination ends at the newest revision', async () => {
    const f = await fixture();
    const extra = [];
    for (let index = 0; index < 3; index += 1) extra.push(await seedOrg(f.partnerId));
    const all = [f.a, f.b, ...extra].sort((a, b) => a.orgId.localeCompare(b.orgId));
    const queue: PartnerGroupEvaluationJobData[] = [{ type: 'partner-group-evaluation', groupId: f.group.id,
      revision: null, afterOrgId: null, failedOrgs: 0, evaluatedOrgs: 0,
      reason: 'integration', queuedAt: new Date().toISOString() }];
    let edited = false;
    let finalized = false;
    let superseded = false;
    let processed = 0;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) throw new Error('missing queued job');
      if (++processed > 12) throw new Error('revision job did not converge');
      const result = await processPartnerGroupEvaluation(next, { pageSize: 2, enqueue: async (job) => {
        if (!edited && job.afterOrgId !== null) {
          edited = true;
          const newestFilter = { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'newest-match' }] };
          await withSystemDbAccessContext(() => db.update(deviceGroups).set({
            filterRevision: 2, filterConditions: newestFilter,
          }).where(eq(deviceGroups.id, f.group.id)));
          // Change a device already visited by revision 1 and one not visited:
          // the fresh head must replace both the old positive and negative sets.
          for (const member of [all[0], all[4]]) {
            if (!member) throw new Error('missing org fixture');
            await withSystemDbAccessContext(() => db.update(devices).set({ hostname: 'newest-match' }).where(eq(devices.id, member.deviceId)));
          }
        }
        queue.push(job);
      } });
      finalized ||= result.status === 'finalized';
      superseded ||= result.status === 'superseded';
    }
    expect(edited && finalized && superseded).toBe(true);
    const [group] = await withSystemDbAccessContext(() => db.select().from(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    expect(group).toMatchObject({ filterRevision: 2, evaluatedRevision: 2, evaluationFailedOrgs: 0 });
    expect(group?.evaluatedAt).toBeInstanceOf(Date);
    expect((await members(f.group.id)).map(row => row.deviceId).sort()).toEqual([all[0]?.deviceId, all[4]?.deviceId].sort());
  });

  runDb("inventory report in org A and org B adds both devices to the software partner group; the partner policy's effective config reaches both", async () => {
    const f = await fixture(softwareFilter);
    const policyId = await seedPartnerPolicy(f.partnerId, f.group.id);
    for (const member of [f.a, f.b]) {
      const ingested = await ingestSoftwareInventoryReport({
        device: { id: member.deviceId, orgId: member.orgId, agentVersion: '1.0.0' },
        report: inventoryReport(), receivedAt: new Date('2026-08-24T12:00:01Z'),
      });
      expect(ingested.acceptedForInventory).toBe(true);
      const job = await awaitQueuedJob(member.deviceId);
      expect(job.data).toMatchObject({ eventType: 'device.updated', reason: 'software_inventory_change' });
      expect(job.data.changedFields.sort()).toEqual(['software.installed', 'software.notInstalled']);
      await runDeviceGroupReevaluationJob(job.data);
      await job.remove();
      const effective = await withDbAccessContext({ scope: 'organization', orgId: member.orgId,
        accessibleOrgIds: [member.orgId], accessiblePartnerIds: [], currentPartnerId: f.partnerId,
        userId: null }, () => resolvePatchConfigPolicyForDevice(member.deviceId));
      expect(effective).toMatchObject({ configPolicyId: policyId, assignmentLevel: 'device_group', assignmentTargetId: f.group.id });
    }
    expect((await members(f.group.id)).map(row => [row.deviceId, row.orgId]).sort())
      .toEqual([f.a, f.b].map(row => [row.deviceId, row.orgId]).sort());
  }, 20000);

  runDb('same-partner move restores partner-group membership after the move re-evaluation', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const source = { orgId: env.organization.id, siteId: env.site.id,
      deviceId: await seedDevice(env.organization.id, env.site.id) };
    const target = await seedOrg(env.partner.id);
    const group = await seedGroup(env.partner.id);
    await withSystemDbAccessContext(() => updateDeviceMembership(source.deviceId, ['hostname'], source.orgId));
    expect((await members(group.id)).map(row => row.orgId)).toEqual([source.orgId]);
    const token = await createAccessToken({ sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: null, partnerId: env.partner.id, scope: 'partner', mfa: true, aep: 1, mep: 1, sid: 'partner-eval-move' });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    const response = await app.request(`/devices/${source.deviceId}/move-org`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, source.deviceId, { orgId: target.orgId, siteId: target.siteId })),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(await members(group.id)).toEqual([]);
    const job = await awaitQueuedJob(source.deviceId);
    expect(job.data).toMatchObject({ eventType: 'device.created', orgId: target.orgId, reason: 'device_org_moved' });
    await runDeviceGroupReevaluationJob(job.data);
    expect((await members(group.id)).map(row => [row.deviceId, row.orgId])).toEqual([[source.deviceId, target.orgId]]);
  }, 20000);

});
