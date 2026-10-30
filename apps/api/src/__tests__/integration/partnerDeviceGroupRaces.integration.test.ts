/** Regression outcomes for concurrent membership writers, using independent transactions. */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog } from '../../db/schema';
import { updateDeviceMembership } from '../../services/groupMembership';
import { evaluatePartnerGroupForOrg } from '../../services/partnerGroupEvaluation';
import { runPartnerGroupSweep } from '../../jobs/partnerGroupEvaluationJobs';
import { shutdownDeviceGroupJobs } from '../../jobs/deviceGroupJobs';
import * as filterEngine from '../../services/filterEngine';
import * as ownership from '../../services/deviceGroupOwnership';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { setupTestEnvironment } from './db-utils';
import { backendPid, fixture, gate, members, seedDevice, seedGroup, seedOrg, softwareFilter, waitForBlock, waitForStart } from './partnerDeviceGroupEvaluation.helpers';
import { closeRedis } from '../../services/redis';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await shutdownDeviceGroupJobs(); await closeRedis(); });

describe('partner membership race outcomes', () => {
  runDb('a matching nonmember added by the whole-group writer is removed by the newer per-device evaluation', async () => {
    const f = await fixture();
    expect(await members(f.group.id)).toEqual([]);
    const filterRead = gate();
    const releaseFilter = gate();
    let wholePid = 0;
    let devicePid = 0;
    const deviceStarted = gate();
    const realFilter = filterEngine.evaluateFilter;
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementationOnce(async (filter, opts) => {
      wholePid = await backendPid();
      const result = await realFilter(filter, opts);
      expect(result.deviceIds).toContain(f.a.deviceId);
      filterRead.release();
      await releaseFilter.promise;
      return result;
    });
    const whole = evaluatePartnerGroupForOrg(f.group.id, f.a.orgId);
    let perDevice: ReturnType<typeof updateDeviceMembership> | undefined;
    let blocked = false;
    try {
      await waitForStart(filterRead.promise, whole);
      await withSystemDbAccessContext(() => db.update(devices).set({ hostname: 'wks-nomatch' }).where(eq(devices.id, f.a.deviceId)));
      perDevice = withSystemDbAccessContext(async () => {
        devicePid = await backendPid();
        deviceStarted.release();
        return updateDeviceMembership(f.a.deviceId, ['hostname'], f.a.orgId);
      });
      await waitForStart(deviceStarted.promise, perDevice);
      // If the shared lock is removed, the device writer returns with no diff.
      // Keep going in that case so the final-state assertion detects the lost update.
      blocked = await Promise.race([
        waitForBlock(devicePid, wholePid).then(() => true),
        perDevice.then(() => false),
      ]);
    } finally {
      releaseFilter.release();
      await Promise.allSettled([whole, ...(perDevice ? [perDevice] : [])]);
    }
    if (!perDevice) throw new Error('per-device evaluation did not start');
    expect(await whole).toMatchObject({ ok: true, added: 1 });
    expect(await members(f.group.id)).toEqual([]);
    expect(await perDevice).toMatchObject({ removed: 1 });
    expect(blocked).toBe(true);
    const logs = await withSystemDbAccessContext(() => db.select().from(groupMembershipLog)
      .where(eq(groupMembershipLog.groupId, f.group.id)));
    expect(logs.map(row => row.action).sort()).toEqual(['added', 'removed']);
  }, 20000);

  runDb.each(['add', 'delete'])('an org move racing a per-device evaluation leaves no stale-org membership (%s)', async (operation) => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const source = { orgId: env.organization.id, siteId: env.site.id,
      deviceId: await seedDevice(env.organization.id, env.site.id) };
    const target = await seedOrg(env.partner.id);
    const group = await seedGroup(env.partner.id);
    if (operation === 'delete') {
      await withSystemDbAccessContext(() => updateDeviceMembership(source.deviceId, ['hostname'], source.orgId));
      await withSystemDbAccessContext(() => db.update(devices).set({ hostname: 'wks-moving' }).where(eq(devices.id, source.deviceId)));
    }
    const moveEntered = gate();
    const finishMove = gate();
    const exportEntered = gate();
    let movePid = 0;
    let evaluatorPid = 0;
    const realExportLock = ownership.acquireMembershipExportOrgLock;
    vi.spyOn(ownership, 'acquireMembershipExportOrgLock').mockImplementation(async orgId => {
      evaluatorPid = await backendPid();
      exportEntered.release();
      return realExportLock(orgId);
    });
    const move = withSystemDbAccessContext(() => db.transaction(async tx => {
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
    let evaluation: ReturnType<typeof updateDeviceMembership> | undefined;
    try {
      await waitForStart(moveEntered.promise, move);
      evaluation = withSystemDbAccessContext(() => updateDeviceMembership(source.deviceId, ['hostname'], source.orgId));
      await waitForStart(exportEntered.promise, evaluation);
      await waitForBlock(evaluatorPid, movePid);
    } finally {
      finishMove.release();
      await Promise.allSettled([move, ...(evaluation ? [evaluation] : [])]);
    }
    if (!evaluation) throw new Error('per-device evaluation did not start');
    await move;
    expect(await evaluation).toMatchObject({ added: 0, removed: 0 });
    expect(await members(group.id)).toEqual([]);
    const [moved] = await withSystemDbAccessContext(() => db.select().from(devices).where(eq(devices.id, source.deviceId)));
    expect(moved?.orgId).toBe(target.orgId);
  }, 20000);

  runDb('the sweep and a per-device org-group writer take export locks before membership rows without deadlocking', async () => {
    const f = await fixture();
    const [group] = await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
      name: 'Software org race', orgId: f.a.orgId, type: 'dynamic',
      filterConditions: softwareFilter, filterFieldsUsed: ['software.installed'],
    }).returning());
    if (!group) throw new Error('missing org group');
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({
      groupId: group.id, deviceId: f.a.deviceId, orgId: f.a.orgId, addedBy: 'dynamic_rule',
    }));
    const deviceHasExport = gate();
    const releaseDevice = gate();
    const sweepRead = gate();
    let devicePid = 0;
    let sweepPid = 0;
    let firstExport = true;
    const realExport = ownership.acquireMembershipExportOrgLock;
    vi.spyOn(ownership, 'acquireMembershipExportOrgLock').mockImplementation(async orgId => {
      await realExport(orgId);
      if (firstExport) {
        firstExport = false;
        devicePid = await backendPid();
        deviceHasExport.release();
        await releaseDevice.promise;
      }
    });
    const realFilter = filterEngine.evaluateFilter;
    vi.spyOn(filterEngine, 'evaluateFilter').mockImplementation(async (filter, opts) => {
      sweepPid = await backendPid();
      const result = await realFilter(filter, opts);
      sweepRead.release();
      return result;
    });
    const perDevice = withSystemDbAccessContext(() => updateDeviceMembership(f.a.deviceId, ['software.installed'], f.a.orgId));
    let sweep: ReturnType<typeof runPartnerGroupSweep> | undefined;
    try {
      await waitForStart(deviceHasExport.promise, perDevice);
      sweep = runPartnerGroupSweep({ enqueue: async () => undefined, random: () => 0 });
      await waitForStart(sweepRead.promise, sweep);
      await waitForBlock(sweepPid, devicePid);
    } finally {
      releaseDevice.release();
      await Promise.allSettled([perDevice, ...(sweep ? [sweep] : [])]);
    }
    if (!sweep) throw new Error('sweep did not start');
    expect(await sweep).toMatchObject({ orgGroups: 1 });
    expect(await perDevice).toMatchObject({ removed: 1 });
    expect(await members(group.id)).toEqual([]);
  }, 20000);
});
