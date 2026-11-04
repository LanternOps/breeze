import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISOLATION_FAILURE_CODES, type IsolationState } from '@breeze/shared';
import { alerts, type DeviceNetworkIsolation } from '../../db/schema';
import type { EpisodeTx } from './episodeStore';
import { toEpisodeSnapshot } from './episodeStore';
import { synchronizeEpisodeOutcome } from './outcome';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), publish: vi.fn(), capture: vi.fn(), afterCommit: vi.fn(), returning: vi.fn(), site: vi.fn() }));
vi.mock('../../db', () => ({ runAfterDbContextCommit: mocks.afterCommit }));
vi.mock('../eventBus', () => ({ publishEvent: mocks.publish }));
vi.mock('../deviceSiteResolver', () => ({ resolveDeviceSiteId: mocks.site }));
vi.mock('../sentry', () => ({ captureException: mocks.capture }));

const alertId = '00000000-0000-4000-8000-000000000008';
const siteId = '00000000-0000-4000-8000-000000000009';
const at = new Date('2026-11-02T12:00:00Z');
let callbacks: Array<() => Promise<void>>;
let row: DeviceNetworkIsolation;
const tx = { insert: mocks.insert } as unknown as EpisodeTx;

beforeEach(() => {
  vi.clearAllMocks();
  callbacks = [];
  mocks.afterCommit.mockImplementation((_label: string, fn: () => Promise<void>) => { callbacks.push(fn); });
  mocks.insert.mockReturnValue({ values: vi.fn(() => ({ returning: mocks.returning })) });
  mocks.returning.mockResolvedValue([{ id: alertId }]);
  mocks.site.mockResolvedValue(siteId);
  mocks.publish.mockResolvedValue('event-id');
  row = {
    id: '00000000-0000-4000-8000-000000000001', orgId: '00000000-0000-4000-8000-000000000002',
    deviceId: '00000000-0000-4000-8000-000000000003', incidentId: '00000000-0000-4000-8000-000000000004',
    incidentActionId: null, commandId: null, releaseCommandId: null, requestedByKind: 'user', requestedByUserId: null,
    state: 'applied', desiredState: 'isolated', generation: 1, lastJournalSeq: 2,
    breakGlassSecretEnc: 'secret-ciphertext-must-never-be-published', breakGlassAckSeq: null,
    allowSnapshot: [{ kind: 'host', host: 'control.example.test', ports: [443], proto: 'tcp', scope: 'breeze' }],
    reason: 'private reason must never be published', deadManSeconds: 0, remoteRelay: false, mechanism: null,
    lastAgentReport: null, expiresAt: at, expiryWarnedAt: null, failureCode: null, releaseKind: null,
    requestedAt: at, dispatchedAt: null, appliedAt: at, verifiedAt: null, releaseRequestedAt: null,
    releasedAt: null, releaseConfirmedAt: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: at, updatedAt: at,
  };
});

async function change(state: IsolationState, failureCode = row.failureCode, releaseKind = row.releaseKind) {
  const prev = toEpisodeSnapshot(row);
  const next = { ...prev, state, generation: 2, failureCode, releaseKind };
  await synchronizeEpisodeOutcome(tx, row, prev, next, at);
  return next;
}

async function commit() { for (const callback of callbacks.splice(0)) await callback(); }

describe('isolation transition alerts', () => {
  it.each(ISOLATION_FAILURE_CODES)('creates one high-severity failed alert for %s, without replay duplicates', async failureCode => {
    const next = await change('failed', failureCode);
    await synchronizeEpisodeOutcome(tx, { ...row, ...next }, next, { ...next, lastJournalSeq: 3 }, at);
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(alerts);
    expect(mocks.insert.mock.results[0]!.value.values).toHaveBeenCalledExactlyOnceWith({
      orgId: row.orgId, ownerKind: 'device', deviceId: row.deviceId, severity: 'high',
      title: 'Network isolation failed', message: 'Network isolation failed. Review the incident before retrying.',
      context: { source: 'network_isolation', isolationId: row.id, generation: 2, state: 'failed', failureCode },
      triggeredAt: at,
    });
  });

  it.each([
    ['self_released', 'dead_man', 'Network isolation self-released'],
    ['released_locally', 'local_code', 'Network isolation released locally'],
    ['released_locally', 'local_forced', 'Network isolation released locally'],
  ] as const)('creates one critical alert for %s/%s', async (state, kind, title) => {
    const next = await change(state, null, kind);
    await synchronizeEpisodeOutcome(tx, { ...row, ...next }, next, next, at);
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(alerts);
    expect(mocks.insert.mock.results[0]!.value.values).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical', title,
      context: { source: 'network_isolation', isolationId: row.id, generation: 2, state, releaseKind: kind },
    }));
  });

  it.each(['requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested', 'released', 'expired', 'uninstalled'] as const)(
    'does not alert for %s', async state => { await change(state); expect(mocks.insert).not.toHaveBeenCalled(); },
  );
});

describe('isolation transition events', () => {
  it.each([
    ['verified', 'device.isolated', null, null],
    ['failed', 'device.isolation_failed', 'not_delivered', null],
    ['self_released', 'device.isolation_self_released', null, 'dead_man'],
    ['released', 'device.isolation_released', null, 'console'],
    ['released', 'device.isolation_released', null, null],
    ['expired', 'device.isolation_released', null, 'expired'],
    ['released_locally', 'device.isolation_released', null, 'local_forced'],
    ['uninstalled', 'device.isolation_released', null, 'uninstall'],
  ] as const)('publishes %s only after commit and never on same-state replay', async (state, event, failureCode, releaseKind) => {
    const next = await change(state, failureCode, releaseKind);
    await synchronizeEpisodeOutcome(tx, { ...row, ...next }, next, next, at);
    expect(mocks.publish).not.toHaveBeenCalled();
    const alerting = state === 'failed' || state === 'self_released' || state === 'released_locally';
    expect(callbacks).toHaveLength(alerting ? 2 : 1);
    await commit();
    expect(mocks.publish.mock.calls.filter(([type]) => type === event)).toHaveLength(1);
    expect(mocks.publish).toHaveBeenCalledWith(event, row.orgId, {
      orgId: row.orgId, deviceId: row.deviceId, isolationId: row.id, generation: 2, incidentId: row.incidentId,
      state, ...(failureCode ? { failureCode } : {}), ...(event === 'device.isolation_released' || event === 'device.isolation_self_released' ? { releaseKind } : {}),
    }, 'network-isolation-result');
    const payload = JSON.stringify(mocks.publish.mock.calls[0]![2]);
    expect(payload).not.toContain('secret');
    expect(payload).not.toContain('control.example.test');
    expect(payload).not.toContain('private reason');
  });

  it.each(['requested', 'dispatched', 'applying', 'applied', 'release_requested'] as const)(
    'does not publish for %s', async state => {
      await change(state); await commit();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );

  it('publishes nothing if the transaction rolls back and drops its commit callbacks', async () => {
    await change('verified');
    callbacks = [];
    await commit();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('logs and captures a post-commit publication failure without throwing', async () => {
    const error = new Error('event bus unavailable');
    mocks.publish.mockImplementation(async (type: string) => { if (type !== 'alert.triggered') throw error; return 'event-id'; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await change('failed', 'apply_error');
      await expect(commit()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalled();
      expect(mocks.capture).toHaveBeenCalledWith(error, undefined, expect.objectContaining({
        phase: 'isolation_outcome_publish', isolationId: row.id, incidentId: row.incidentId,
      }));
    } finally { log.mockRestore(); }
  });
});


describe('isolation alert notifications', () => {
  it.each([
    ['failed', 'apply_error', null],
    ['self_released', null, 'dead_man'],
    ['released_locally', null, 'local_code'],
    ['released_locally', null, 'local_forced'],
  ] as const)('publishes one alert.triggered after commit for %s/%s/%s', async (state, failureCode, releaseKind) => {
    const next = await change(state, failureCode, releaseKind);
    await synchronizeEpisodeOutcome(tx, { ...row, ...next }, next, next, at);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.returning).toHaveBeenCalledExactlyOnceWith({ id: alerts.id });
    await commit();
    const fields = mocks.insert.mock.results[0]!.value.values.mock.calls[0]![0];
    expect(mocks.site).toHaveBeenCalledExactlyOnceWith(row.deviceId);
    expect(mocks.publish.mock.calls.filter(([type]) => type === 'alert.triggered')).toHaveLength(1);
    expect(mocks.publish).toHaveBeenCalledWith('alert.triggered', row.orgId, {
      alertId, ruleId: null, severity: fields.severity, title: fields.title, message: fields.message,
      source: 'network_isolation', deviceId: row.deviceId, owner: null, ownerKey: `device:${row.deviceId}`,
      monitorId: null, kind: null,
      isolationId: row.id, generation: 2, incidentId: row.incidentId, state,
      ...(failureCode ? { failureCode } : {}), ...(releaseKind ? { releaseKind } : {}),
    }, 'network-isolation-result', { siteId });
  });

  it.each(['failed', 'self_released', 'released_locally'] as const)('does not publish an alert when %s rolls back', async state => {
    await change(state, state === 'failed' ? 'apply_error' : null);
    expect(mocks.publish).not.toHaveBeenCalled();
    callbacks = [];
    await commit();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('preserves fail-closed site attribution when the resolver has no site', async () => {
    mocks.site.mockResolvedValue(undefined);
    await change('failed', 'apply_error');
    await commit();
    expect(mocks.publish).toHaveBeenCalledWith('alert.triggered', row.orgId, expect.anything(),
      'network-isolation-result', { siteId: undefined });
  });

  it('logs ids and captures alert publication failure without throwing or suppressing the device event', async () => {
    const error = new Error('notification bus unavailable');
    mocks.publish.mockImplementation(async (type: string) => { if (type === 'alert.triggered') throw error; return 'event-id'; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await change('failed', 'apply_error');
      await expect(commit()).resolves.toBeUndefined();
      const tags = { phase: 'isolation_alert_publish', alertId, orgId: row.orgId, deviceId: row.deviceId,
        isolationId: row.id, incidentId: row.incidentId };
      expect(log).toHaveBeenCalledWith('[isolation] alert event publish failed', tags);
      expect(mocks.capture).toHaveBeenCalledWith(error, undefined, tags);
      expect(mocks.publish).toHaveBeenCalledWith('device.isolation_failed', row.orgId, expect.anything(), 'network-isolation-result');
    } finally { log.mockRestore(); }
  });

  it('fails the transition if alert insertion returns no id instead of committing a silent alert', async () => {
    mocks.returning.mockResolvedValue([]);
    await expect(change('failed', 'apply_error')).rejects.toThrow('isolation_alert_insert_missing');
    expect(callbacks).toHaveLength(0);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
