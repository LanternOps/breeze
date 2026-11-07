import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { alerts, deviceNetworkIsolations, devices, incidents, type DeviceNetworkIsolation } from '../db/schema';

const mocks = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), system: vi.fn(), outside: vi.fn(), afterCommit: vi.fn(),
  alert: vi.fn(), publish: vi.fn(), outcome: vi.fn(), capture: vi.fn(),
  queueAdd: vi.fn(), queueClose: vi.fn(), repeats: vi.fn(), removeRepeat: vi.fn(),
  workerClose: vi.fn(), workerCreated: vi.fn(), observed: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { select: mocks.select, update: mocks.update, transaction: mocks.transaction },
  withSystemDbAccessContext: mocks.system, runOutsideDbContext: mocks.outside, runAfterDbContextCommit: mocks.afterCommit,
}));
vi.mock('../services/networkIsolation/outcome', async original => ({
  synchronizeEpisodeOutcome: mocks.outcome.mockImplementation((await original<typeof import('../services/networkIsolation/outcome')>()).synchronizeEpisodeOutcome),
}));
vi.mock('../services/alertService', () => ({ createSourcedAlert: mocks.alert }));
vi.mock('../services/deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => 'site') }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publish }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.observed }));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd; close = mocks.queueClose;
    getRepeatableJobs = mocks.repeats; removeRepeatableByKey = mocks.removeRepeat;
  },
  Worker: class {
    constructor(...args: unknown[]) { mocks.workerCreated(...args); }
    close = mocks.workerClose; on = vi.fn();
  },
}));

import { sweepNetworkIsolations, initializeNetworkIsolationSweeper, shutdownNetworkIsolationSweeper } from './networkIsolationSweeper';

const now = new Date('2026-11-02T12:00:00Z');
const hour = 3_600_000;
let callbacks: Array<() => Promise<void>>;
let row: DeviceNetworkIsolation;
let inSystem: boolean;
let beforeLock: (() => void) | undefined;
let predicates: string[];
let predicateParams: unknown[][];
let limits: number[];
let writes: Array<Record<string, unknown>>;
let markerCommitted: boolean;
let candidates: Array<{ id: string }> | undefined;

function episode(patch: Partial<DeviceNetworkIsolation> = {}): DeviceNetworkIsolation {
  return {
    id: '00000000-0000-4000-8000-000000000001', orgId: '00000000-0000-4000-8000-000000000002',
    deviceId: '00000000-0000-4000-8000-000000000003', incidentId: '00000000-0000-4000-8000-000000000004',
    requestedByUserId: '00000000-0000-4000-8000-000000000005', requestedByKind: 'user',
    incidentActionId: null, commandId: null, releaseCommandId: null, state: 'verified', desiredState: 'isolated', generation: 1,
    lastJournalSeq: 3, expiresAt: new Date(now.getTime() + 12 * hour), expiryWarnedAt: null,
    breakGlassSecretEnc: 'encrypted-fixture', breakGlassAckSeq: null, reason: 'Contain incident',
    deadManSeconds: 0, remoteRelay: false, mechanism: null, allowSnapshot: [], allowSnapshotRevision: null, appliedPolicyRevision: null, policyEventSeq: 0, lastAgentReport: null,
    failureCode: null, releaseKind: null, requestedAt: now, dispatchedAt: null, appliedAt: null,
    verifiedAt: null, releaseRequestedAt: null, releasedAt: null, releaseConfirmedAt: null,
    acknowledgedAt: null, acknowledgedBy: null, createdAt: now, updatedAt: now,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alert.mockReset(); mocks.publish.mockReset(); mocks.transaction.mockReset();
  callbacks = []; markerCommitted = false; candidates = undefined;
  mocks.afterCommit.mockImplementation((_label: string, fn: () => Promise<void>) => { callbacks.push(fn); });
  row = episode(); inSystem = false; beforeLock = undefined; predicates = []; predicateParams = []; limits = []; writes = [];
  mocks.outside.mockImplementation((fn: () => unknown) => fn());
  mocks.system.mockImplementation(async (fn: () => Promise<unknown>) => {
    inSystem = true;
    try { return await fn(); } finally { inSystem = false; markerCommitted = row.expiryWarnedAt !== null; }
  });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ select: mocks.select, update: mocks.update, insert: mocks.insert }));
  mocks.select.mockImplementation(() => {
    expect(inSystem).toBe(true);
    let table: unknown;
    const result = () => table === deviceNetworkIsolations ? candidates ?? [{ ...row }]
      : table === incidents ? [{ assignedTo: '00000000-0000-4000-8000-000000000006' }]
        : table === devices ? [{ siteId: '00000000-0000-4000-8000-000000000007' }] : [];
    const chain = {
      from: vi.fn((value: unknown) => { table = value; return chain; }),
      where: vi.fn((predicate) => { const query = new PgDialect().sqlToQuery(predicate); predicates.push(query.sql); predicateParams.push(query.params); return chain; }),
      orderBy: vi.fn(() => chain), limit: vi.fn((n: number) => { limits.push(n); return chain; }),
      for: vi.fn(async () => { beforeLock?.(); return [{ ...row }]; }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  });
  mocks.update.mockImplementation(() => ({ set: (patch: Record<string, unknown>) => ({ where: () => {
    expect(inSystem).toBe(true); writes.push(patch); Object.assign(row, patch);
    return { returning: async () => [{ id: row.id }], then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(resolve) };
  } }) }));
  mocks.insert.mockImplementation(() => ({ values: vi.fn(() => ({ returning: async () => [{ id: 'alert-id' }] })) }));
  mocks.alert.mockResolvedValue('00000000-0000-4000-8000-000000000008');
  mocks.publish.mockResolvedValue('event-id');
  mocks.repeats.mockResolvedValue([]);
  mocks.queueAdd.mockResolvedValue({});
});

describe('network isolation sweeper', () => {
  it('warns once at the 12h boundary, with both recipients and device/site scope', async () => {
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 1, notDelivered: 0 });
    expect(row.expiryWarnedAt).toEqual(now);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({
      orgId: row.orgId, deviceId: row.deviceId, severity: 'medium',
      context: expect.objectContaining({ source: 'network_isolation', requestedByUserId: row.requestedByUserId,
        incidentOwnerUserId: '00000000-0000-4000-8000-000000000006', isolationId: row.id }),
    }));
    expect(mocks.publish).toHaveBeenCalledWith('device.isolation_expiring', row.orgId,
      expect.objectContaining({ isolationId: row.id, generation: 1, deviceId: row.deviceId }),
      'network-isolation-sweeper', expect.objectContaining({ siteId: '00000000-0000-4000-8000-000000000007' }));
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.system).toHaveBeenCalled();
    expect(mocks.outside).toHaveBeenCalled();
  });

  it.each(['requested', 'dispatched'] as const)('fails undelivered %s through the state machine and preserves an unconfirmed tombstone', async state => {
    row = episode({ state, lastJournalSeq: 0, expiresAt: new Date(now.getTime() - 30 * 60_000 - 1) });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 1 });
    expect(mocks.outcome).toHaveBeenCalledTimes(1);
    expect(mocks.outcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: row.id }),
      expect.objectContaining({ state }), expect.objectContaining({ state: 'failed', failureCode: 'not_delivered' }), now);
    expect(row).toMatchObject({ state: 'failed', failureCode: 'not_delivered', generation: 2,
      desiredState: 'released', releaseConfirmedAt: null, releasedAt: null, breakGlassSecretEnc: '' });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(alerts);
    expect(mocks.insert.mock.results[0]!.value.values).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'high', context: { source: 'network_isolation', isolationId: row.id, generation: 2, state: 'failed', failureCode: 'not_delivered' },
    }));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    for (const callback of callbacks) await callback();
    expect(mocks.publish.mock.calls.filter(([type]) => type === 'alert.triggered')).toHaveLength(1);
    expect(mocks.publish).toHaveBeenCalledWith('alert.triggered', row.orgId, expect.objectContaining({
      alertId: 'alert-id', isolationId: row.id, failureCode: 'not_delivered', ownerKey: `device:${row.deviceId}`,
    }), 'network-isolation-result', { siteId: 'site' });
  });

  it.each([
    { state: 'applying' as const }, { state: 'applied' as const }, { lastJournalSeq: 1 },
    { expiresAt: new Date(now.getTime() - 30 * 60_000) },
    { expiresAt: new Date(now.getTime() - 29 * 60_000) },
  ])('does not infer not_delivered when one prerequisite fails: %j', async patch => {
    row = episode({ state: 'dispatched', lastJournalSeq: 0, expiresAt: new Date(now.getTime() - hour), ...patch });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(writes).toEqual([]);
  });

  it.each([
    { state: 'release_requested' as const }, { expiryWarnedAt: now },
    { expiresAt: new Date(now.getTime() + 12 * hour + 1) },
  ])('does not warn outside the warning conditions: %j', async patch => {
    Object.assign(row, patch);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'applying' as const }, { lastJournalSeq: 1 }, { expiresAt: new Date(now.getTime() + hour), generation: 2 },
  ])('rechecks delivery conditions under the episode lock: %j', async patch => {
    row = episode({ state: 'requested', lastJournalSeq: 0, expiresAt: new Date(now.getTime() - hour) });
    beforeLock = () => Object.assign(row, patch);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(writes).toEqual([]);
  });

  it('rechecks warning eligibility after a concurrent extend', async () => {
    beforeLock = () => Object.assign(row, { expiresAt: new Date(now.getTime() + 72 * hour), generation: 2 });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it.each(['verified', 'dispatched', 'release_requested'] as const)('never infers released or expired from elapsed time for %s', async state => {
    row.state = state;
    row.lastJournalSeq = 3;
    row.expiresAt = new Date(now.getTime() - 72 * hour);
    await sweepNetworkIsolations(now);
    expect(row.state).toBe(state);
    expect(row.releaseConfirmedAt).toBeNull();
    expect(writes.every(patch => patch.state !== 'released' && patch.state !== 'expired')).toBe(true);
  });

  it('commits the warning marker before creating or publishing notifications', async () => {
    mocks.alert.mockImplementationOnce(async () => {
      expect(markerCommitted).toBe(true);
      return '00000000-0000-4000-8000-000000000008';
    });
    mocks.publish.mockImplementationOnce(async () => {
      expect(markerCommitted).toBe(true);
      return 'event-id';
    });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 1, notDelivered: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('keeps the committed warning marker when alert creation fails and does not retry', async () => {
    mocks.alert.mockResolvedValueOnce(null);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(row.expiryWarnedAt).toEqual(now);
    expect(markerCommitted).toBe(true);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { isolationId: row.id });
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it('keeps the committed warning marker when publication fails and does not repeat the alert', async () => {
    mocks.publish.mockRejectedValueOnce(new Error('event publication failed'));
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(row.expiryWarnedAt).toEqual(now);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { isolationId: row.id });
    expect(mocks.publish.mock.calls[0]![4].eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('continues processing later candidates when the first candidate throws', async () => {
    const badId = '00000000-0000-4000-8000-000000000009';
    candidates = [{ id: badId }, { id: row.id }];
    mocks.transaction.mockRejectedValueOnce(new Error('candidate failed'));
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 1, notDelivered: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { isolationId: badId });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(row.expiryWarnedAt).toEqual(now);
  });

  it('bounds the due scan and uses expiry/state predicates for the active-expiry index', async () => {
    await sweepNetworkIsolations(now);
    expect(limits).toContain(500);
    expect(predicates[0]).toContain('expires_at');
    expect(predicates[0]).toContain('state');
    expect(predicates[0]).toContain('last_journal_seq');
    expect(predicates[0]).toContain('expiry_warned_at');
  });

  it('re-arms once after an extension moves expiry into a new warning window', async () => {
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 1, notDelivered: 0 });
    row.expiresAt = new Date(now.getTime() + 72 * hour);
    row.generation++;
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    const nextWindow = new Date(now.getTime() + 60 * hour);
    expect(await sweepNetworkIsolations(nextWindow)).toEqual({ warned: 1, notDelivered: 0 });
    expect(row.expiryWarnedAt).toEqual(nextWindow);
    expect(await sweepNetworkIsolations(nextWindow)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])('does not re-warn when the prior warning is at or after window start (+%sms)', async offset => {
    row.expiryWarnedAt = new Date(row.expiresAt.getTime() - 12 * hour + offset);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 0, notDelivered: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('uses the same re-arm threshold in the candidate SQL as in the locked check', async () => {
    row.expiryWarnedAt = new Date(now.getTime() - 1);
    expect(await sweepNetworkIsolations(now)).toEqual({ warned: 1, notDelivered: 0 });
    expect(predicates[0]).toMatch(/"expiry_warned_at" < .*"expires_at" - \$\d+ \* interval '1 millisecond'/);
    expect(predicateParams[0]).toContain(12 * hour);
  });

});


describe('network isolation sweeper worker', () => {
  it('registers one observed consumer and replaces only its repeatable job every five minutes', async () => {
    mocks.repeats.mockResolvedValue([
      { name: 'sweep-network-isolations', key: 'old-sweep' },
      { name: 'unrelated-job', key: 'other' },
    ]);
    try {
      await initializeNetworkIsolationSweeper();
      await initializeNetworkIsolationSweeper();
      expect(mocks.workerCreated).toHaveBeenCalledTimes(1);
      expect(mocks.workerCreated).toHaveBeenCalledWith('network-isolation-sweeper', expect.any(Function),
        expect.objectContaining({ concurrency: 1 }));
      expect(mocks.observed).toHaveBeenCalledWith(expect.anything(), 'networkIsolationSweeper');
      expect(mocks.removeRepeat).toHaveBeenCalledExactlyOnceWith('old-sweep');
      expect(mocks.queueAdd).toHaveBeenCalledWith('sweep-network-isolations', expect.anything(),
        expect.objectContaining({ repeat: { every: 300_000 }, jobId: 'network-isolation-sweeper' }));
    } finally { await shutdownNetworkIsolationSweeper(); }
    expect(mocks.workerClose).toHaveBeenCalledTimes(1);
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
  });

  it('closes the consumer on scheduling failure and allows initialization to retry', async () => {
    mocks.queueAdd.mockRejectedValueOnce(new Error('schedule failed'));
    try {
      await expect(initializeNetworkIsolationSweeper()).rejects.toThrow('schedule failed');
      expect(mocks.workerClose).toHaveBeenCalledTimes(1);
      await initializeNetworkIsolationSweeper();
      expect(mocks.workerCreated).toHaveBeenCalledTimes(2);
    } finally { await shutdownNetworkIsolationSweeper(); }
  });
});
