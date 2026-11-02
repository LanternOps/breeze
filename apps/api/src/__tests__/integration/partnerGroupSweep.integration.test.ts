/** Real discovery predicates and org-group writes for the six-hour retry sweep. */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroups, softwareInventory } from '../../db/schema';
import { runPartnerGroupSweep } from '../../jobs/partnerGroupEvaluationJobs';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import * as groupMembership from '../../services/groupMembership';
import { closeRedis } from '../../services/redis';
import { fixture, hostnameFilter, members, softwareFilter, softwareName } from './partnerDeviceGroupEvaluation.helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await shutdownPeripheralJobs(); await closeRedis(); });

async function sweepFixture() {
  const f = await fixture();
  const groups = await withSystemDbAccessContext(async () => {
    await db.insert(softwareInventory).values({ deviceId: f.a.deviceId, orgId: f.a.orgId, name: softwareName });
    return db.insert(deviceGroups).values([
      { orgId: f.a.orgId, name: 'Software sweep', type: 'dynamic', filterConditions: softwareFilter, filterFieldsUsed: ['software.installed'] },
      { orgId: f.a.orgId, name: 'Hostname sweep', type: 'dynamic', filterConditions: hostnameFilter, filterFieldsUsed: ['hostname'] },
      { orgId: f.a.orgId, name: 'Static sweep', type: 'static', filterConditions: softwareFilter, filterFieldsUsed: ['software.installed'] },
    ]).returning();
  });
  const software = groups.find(group => group.name === 'Software sweep');
  const hostname = groups.find(group => group.name === 'Hostname sweep');
  const manual = groups.find(group => group.name === 'Static sweep');
  if (!software || !hostname || !manual) throw new Error('missing sweep groups');
  return { ...f, software, hostname, manual };
}

describe('partner group sweep discovery', () => {
  runDb('enqueues only dynamic partner groups and evaluates exactly software org groups against the real database', async () => {
    const f = await sweepFixture();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi.spyOn(groupMembership, 'evaluateGroupMembership');
    expect(await runPartnerGroupSweep({ enqueue, random: () => 0 })).toEqual({ partnerGroups: 1, orgGroups: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ groupId: f.group.id, revision: null }), { delayMs: 0 });
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(f.software.id, { exportLockBeforeWrites: true });
    expect((await members(f.software.id)).map(row => row.deviceId)).toEqual([f.a.deviceId]);
    expect(await members(f.hostname.id)).toEqual([]);
    expect(await members(f.manual.id)).toEqual([]);
    expect(await members(f.group.id)).toEqual([]);
  });

  runDb('rejects with AggregateError when a discovered software org-group evaluation throws', async () => {
    const f = await sweepFixture();
    const failure = new Error('org group evaluation failed');
    const evaluate = vi.spyOn(groupMembership, 'evaluateGroupMembership').mockRejectedValueOnce(failure);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runPartnerGroupSweep({ enqueue, random: () => 0 })).rejects.toMatchObject({
      name: 'AggregateError', errors: [failure],
    });
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(f.software.id, { exportLockBeforeWrites: true });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ groupId: f.group.id }), { delayMs: 0 });
    expect(await members(f.software.id)).toEqual([]);
  });
});
