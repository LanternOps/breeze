import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, transitionMock } = vi.hoisted(() => ({ rows: [] as unknown[][], transitionMock: vi.fn() }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'update', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain };
});
vi.mock('../outcomeProbes', () => ({
  inSystemDbContext: (fn: () => unknown) => fn(),
  readAlertRecovery: vi.fn(async () => null),
  probeTelemetryFreshness: vi.fn(),
  telemetryProbeFor: () => ({ table: 'device_metrics', column: 'cpu_percent' }),
}));
vi.mock('./signatureLoader', () => ({ signatureForSource: vi.fn(async () => null), alertSignature: vi.fn(async () => null), sourceRefFor: vi.fn(() => null) }));
vi.mock('./store', () => ({ transitionOutcome: transitionMock, fillOutcomeSignature: async (row: unknown) => row }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { BreezeEvent } from '../eventBus';
import { probeTelemetryFreshness, readAlertRecovery } from '../outcomeProbes';
import {
  advanceOutcome, decideAwaitingRecovery, decideHolding, decidePending, handleFixOutcomeEvent, readingFromAlert,
  readingFromCleanupRun, readingFromCommand, readingFromEpisode, recurrencePrefilter,
} from './outcomeWatcher';

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe('decidePending', () => {
  it.each([
    [{ status: 'completed', exitCode: 0 }, 1, 'awaiting_recovery', 'script_succeeded'],
    [{ status: 'failed', exitCode: 1 }, 1, 'failed', 'script_failed'],
    [{ status: 'timeout', exitCode: null }, 1, 'failed', 'script_timeout'],
    [{ status: 'cancelled', exitCode: null }, 1, 'cancelled', 'script_cancelled'],
    [{ status: 'running', exitCode: null }, 25, 'inconclusive', 'script_never_finished'],
    [null, 25, 'inconclusive', 'script_execution_missing'],
  ] as const)('%o at +%ih → %s', (script, hours, to, reason) => {
    expect(decidePending({ script, deadlineAt: at(24), now: at(hours) })).toMatchObject({ to, reason });
  });
  it('waits while the script is still running before the deadline', () => {
    expect(decidePending({ script: { status: 'running', exitCode: null }, deadlineAt: at(24), now: at(1) })).toBeNull();
  });
  it.each(['failed', 'timeout'] as const)('a %s execution that was never delivered is inconclusive, not a failed attempt (I2)', (status) => {
    expect(decidePending({ script: { status, exitCode: null, neverDelivered: true }, deadlineAt: at(24), now: at(1) }))
      .toEqual({ to: 'inconclusive', reason: 'script_never_delivered' });
  });
});

describe('advanceOutcome pending → the sweeper tells an undelivered script from a failed one (I2)', () => {
  beforeEach(() => { rows.length = 0; transitionMock.mockReset().mockResolvedValue(true); });
  const pending = {
    id: 'o-p', orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'pending', countedAt: null,
    signatureKey: 'k'.repeat(64), sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1',
    scriptExecutionId: 'e-1', deadlineAt: at(24), createdAt: at(0),
  };

  it('failed, never started, and its command expired on the delivery clock → inconclusive script_never_delivered', async () => {
    // outcome row, device org, script execution, the delivery-clock command row
    rows.push([pending], [{ orgId: 'org-1' }], [{ status: 'failed', exitCode: null, startedAt: null }], [{ id: 'c-1' }]);
    expect(await advanceOutcome('o-p', { now: at(1) })).toBe('inconclusive');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'inconclusive', reason: 'script_never_delivered' });
  });

  it('failed after it started stays a failed attempt (no delivery lookup needed)', async () => {
    rows.push([pending], [{ orgId: 'org-1' }], [{ status: 'failed', exitCode: 1, startedAt: at(0) }], [{ id: 'c-1' }]);
    expect(await advanceOutcome('o-p', { now: at(1) })).toBe('failed');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'failed', reason: 'script_failed' });
    expect(rows).toHaveLength(1); // the command row was never read
  });

  it('failed with no started_at but no delivery-clock expiry (polling agent reported a failure) stays failed', async () => {
    rows.push([pending], [{ orgId: 'org-1' }], [{ status: 'failed', exitCode: 1, startedAt: null }], []);
    expect(await advanceOutcome('o-p', { now: at(1) })).toBe('failed');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'failed', reason: 'script_failed' });
  });
});

describe('readingFromAlert (Review Focus 2)', () => {
  const base = { resolvedAt: at(2), resolvedBy: null, resolutionReason: 'condition_cleared' };
  it.each([
    [{ status: 'resolved', ...base }, { kind: 'recovered', at: at(2) }],
    [{ status: 'resolved', ...base, resolvedBy: 'user-1' }, { kind: 'cleared_other', reason: 'human_resolved' }],
    [{ status: 'resolved', ...base, resolutionReason: 'source_retired' }, { kind: 'cleared_other', reason: 'resolved_source_retired' }],
    [{ status: 'resolved', ...base, resolutionReason: 'expired' }, { kind: 'cleared_other', reason: 'resolved_expired' }],
    [{ status: 'resolved', ...base, resolutionReason: null }, { kind: 'cleared_other', reason: 'resolved_unspecified' }],
    [{ status: 'dismissed', ...base }, { kind: 'cleared_other', reason: 'alert_dismissed' }],
    // M2: a suppressed alert was silenced, not observed to persist — never a failed attempt.
    [{ status: 'suppressed', ...base }, { kind: 'cleared_other', reason: 'alert_suppressed' }],
    [{ status: 'active', ...base }, { kind: 'still_active' }],
    [null, { kind: 'source_missing' }],
  ] as const)('%o → %o', (reading, expected) => {
    expect(readingFromAlert(reading as never)).toEqual(expected);
  });
});

describe('readingFromEpisode', () => {
  const ep = { status: 'resolved', closeReason: 'cleared', resolvedByUserId: null, resolvedAt: at(3) };
  it('only a cleared, system-closed episode is recovery', () => {
    expect(readingFromEpisode(ep)).toEqual({ kind: 'recovered', at: at(3) });
    expect(readingFromEpisode({ ...ep, closeReason: 'expired_offline' })).toEqual({ kind: 'cleared_other', reason: 'episode_expired_offline' });
    expect(readingFromEpisode({ ...ep, resolvedByUserId: 'u' })).toEqual({ kind: 'cleared_other', reason: 'human_resolved' });
    expect(readingFromEpisode({ ...ep, status: 'open' })).toEqual({ kind: 'still_active' });
    expect(readingFromEpisode('unassembled')).toEqual({ kind: 'unknown' });
    expect(readingFromEpisode('missing')).toEqual({ kind: 'source_missing' });
  });
});

describe('decideAwaitingRecovery', () => {
  const common = { createdAt: at(0), deadlineAt: at(24) };
  it('objective recovery after the fix starts a 24h hold from the recovery time', () => {
    expect(decideAwaitingRecovery({ ...common, now: at(3), reading: { kind: 'recovered', at: at(2) } }))
      .toEqual({ to: 'holding', reason: 'condition_cleared', recoveredAt: at(2), holdingUntil: at(26) });
  });
  it('measures "before the fix" from when the script STARTED when that is known (I3)', () => {
    // cleared after dispatch (createdAt) but before the script started → not the fix's doing
    expect(decideAwaitingRecovery({ ...common, startedAt: at(1), now: at(2), reading: { kind: 'recovered', at: at(0.5) } }))
      .toEqual({ to: 'inconclusive', reason: 'cleared_before_fix' });
    // cleared after the script started → hold
    expect(decideAwaitingRecovery({ ...common, startedAt: at(1), now: at(2), reading: { kind: 'recovered', at: at(1.5) } }))
      .toEqual({ to: 'holding', reason: 'condition_cleared', recoveredAt: at(1.5), holdingUntil: at(25.5) });
    // no start time (never recorded) → dispatch time, as before
    expect(decideAwaitingRecovery({ ...common, startedAt: null, now: at(2), reading: { kind: 'recovered', at: at(0.5) } }))
      .toMatchObject({ to: 'holding' });
  });
  it('a condition that cleared before the fix was admitted is inconclusive', () => {
    expect(decideAwaitingRecovery({ ...common, now: at(1), reading: { kind: 'recovered', at: new Date(at(0).getTime() - 60_000) } }))
      .toEqual({ to: 'inconclusive', reason: 'cleared_before_fix' });
  });
  it.each([
    [{ kind: 'cleared_other', reason: 'human_resolved' }, 1, { to: 'inconclusive', reason: 'human_resolved' }],
    [{ kind: 'source_missing' }, 1, { to: 'inconclusive', reason: 'source_missing' }],
    [{ kind: 'no_observable_condition' }, 1, { to: 'inconclusive', reason: 'no_observable_condition' }],
    [{ kind: 'device_moved' }, 1, { to: 'cancelled', reason: 'device_moved' }],
    [{ kind: 'still_active' }, 23, null],
    [{ kind: 'still_active' }, 24, { to: 'failed', reason: 'condition_persisted' }],
    [{ kind: 'unknown' }, 24, { to: 'inconclusive', reason: 'recovery_unobservable' }],
  ] as const)('%o at +%ih → %o', (reading, hours, expected) => {
    expect(decideAwaitingRecovery({ ...common, now: at(hours), reading: reading as never })).toEqual(expected);
  });
});

describe('decideHolding (Review Focus 3)', () => {
  const fresh = { fresh: true, reason: 'ok', coverage: 0.9 } as const;
  it.each([
    [{ recurrence: 'recurred', deviceMoved: false, now: at(5), freshness: null }, { to: 'recurred', reason: 'same_signature_recurred' }],
    [{ recurrence: 'clear', deviceMoved: true, now: at(5), freshness: null }, { to: 'cancelled', reason: 'device_moved' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(5), freshness: null }, null],
    [{ recurrence: 'unscanned', deviceMoved: false, now: at(5), freshness: null }, null],
    [{ recurrence: 'unscanned', deviceMoved: false, now: at(27), freshness: fresh }, { to: 'inconclusive', reason: 'recurrence_scan_capped' }],
    [{ recurrence: 'unsignable', deviceMoved: false, now: at(5), freshness: null }, null],
    [{ recurrence: 'unsignable', deviceMoved: false, now: at(27), freshness: fresh }, { to: 'inconclusive', reason: 'recurrence_unsignable' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: fresh }, { to: 'verified', reason: 'held_with_fresh_telemetry' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'heartbeat_stale', coverage: 0 } }, { to: 'inconclusive', reason: 'telemetry_heartbeat_stale' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'metric_gap', coverage: 0.4 } }, { to: 'inconclusive', reason: 'telemetry_metric_gap' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'metric_unmapped', coverage: 0 } }, { to: 'inconclusive', reason: 'telemetry_metric_unmapped' }],
  ] as const)('%o → %o', (input, expected) => {
    expect(decideHolding({ ...input, holdingUntil: at(26) } as never)).toEqual(expected);
  });
});

describe('recurrencePrefilter (Review Focus 3 — recurrence must not hide behind unrelated alerts)', () => {
  const dialect = new PgDialect();
  it('only ever narrows to alerts whose signature could match', () => {
    expect(dialect.sqlToQuery(recurrencePrefilter('rule:service_stopped')!).sql).toContain('"rule_id" is not null');
    const sourced = dialect.sqlToQuery(recurrencePrefilter('sourced:script_exit_code:s-1')!);
    expect(sourced.sql).toContain(`->>'source' =`);
    expect(sourced.params).toEqual(['script_exit_code']);
    expect(dialect.sqlToQuery(recurrencePrefilter('sourced:patch_failed:any')!).params).toEqual(['patch-job-finalizer']);
    expect(dialect.sqlToQuery(recurrencePrefilter('anomaly:device_metrics:spike:cpu')!).sql).toContain(`'metric_anomaly'`);
    expect(recurrencePrefilter('sourced:unknown_thing')).toBeNull();
    expect(recurrencePrefilter(null)).toBeNull();
  });
});

describe('handleFixOutcomeEvent (Review Focus 1)', () => {
  beforeEach(() => { rows.length = 0; transitionMock.mockReset().mockResolvedValue(true); });

  const awaiting = {
    id: 'o-1', orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'awaiting_recovery', countedAt: null,
    signatureKey: 'k'.repeat(64), sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1',
    scriptExecutionId: 'e-1', deadlineAt: at(24), createdAt: at(0),
  };
  const evt = { id: 'ev', type: 'alert.resolved', orgId: 'org-1', source: 's', priority: 'normal',
    payload: { alertId: 'a-1', resolvedAt: at(2).toISOString(), resolvedBy: null, resolutionReason: 'condition_cleared' },
    metadata: { timestamp: '' } } as unknown as BreezeEvent;

  it('duplicate alert.resolved delivery transitions once', async () => {
    // delivery 1: lookup ids -> outcome row -> device org
    rows.push([{ id: 'o-1' }], [awaiting], [{ orgId: 'org-1' }]);
    await handleFixOutcomeEvent(evt);
    // delivery 2 raced the lookup: the row it re-reads has already left awaiting_recovery for good
    rows.push([{ id: 'o-1' }], [{ ...awaiting, state: 'verified', countedAt: at(30) }]);
    await handleFixOutcomeEvent(evt);
    // delivery 3 after the move: the state-filtered lookup finds nothing
    rows.push([]);
    await handleFixOutcomeEvent(evt);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'holding', reason: 'condition_cleared', recoveredAt: at(2), holdingUntil: at(26) });
  });

  it('ignores script.* (W1 never subscribes to them — decision D-a) and malformed payloads', async () => {
    // Each case seeds enough rows that a handler which mistakenly processed
    // the event WOULD find the outcome and transition it (id lookup -> row ->
    // device org). If either guard below were removed, this test goes red —
    // verified by temporarily deleting each guard and observing the failure
    // (not committed; see task-13-report.md fix round 1).
    rows.push([{ id: 'o-1' }], [awaiting], [{ orgId: 'org-1' }]);
    await handleFixOutcomeEvent({
      ...evt, type: 'script.failed',
      payload: { alertId: 'a-1', executionId: 'e-1', status: 'failed', resolvedAt: at(2).toISOString(), resolvedBy: null, resolutionReason: 'condition_cleared' },
    } as unknown as BreezeEvent);

    rows.push([{ id: 'o-1' }], [awaiting], [{ orgId: 'org-1' }]);
    await handleFixOutcomeEvent({ ...evt, payload: { resolvedAt: at(2).toISOString() } } as unknown as BreezeEvent);

    // alert.triggered is not a watcher event any more (I5): the sweeper owns recurrence.
    rows.push([{ id: 'o-1' }], [{ ...awaiting, state: 'holding' }], [{ orgId: 'org-1' }]);
    await handleFixOutcomeEvent({ ...evt, type: 'alert.triggered', payload: { alertId: 'a-2', deviceId: 'd-1' } } as unknown as BreezeEvent);

    expect(transitionMock).not.toHaveBeenCalled();
    // No branch touched the db: all three seeded 3-row batches are still queued.
    expect(rows.length).toBe(9);
  });
});

describe('advanceOutcome awaiting_recovery reads the execution start time (I3)', () => {
  beforeEach(() => {
    rows.length = 0;
    transitionMock.mockReset().mockResolvedValue(true);
    vi.mocked(readAlertRecovery).mockReset();
  });
  const awaitingRow = {
    id: 'o-a', orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'awaiting_recovery', countedAt: null,
    signatureKey: 'k'.repeat(64), sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1',
    scriptExecutionId: 'e-1', deadlineAt: at(24), createdAt: at(0),
  };

  it('an alert that cleared after dispatch but before the script started is inconclusive cleared_before_fix', async () => {
    vi.mocked(readAlertRecovery).mockResolvedValueOnce({ status: 'resolved', resolvedAt: at(0.5), resolvedBy: null, resolutionReason: 'condition_cleared' });
    rows.push([awaitingRow], [{ orgId: 'org-1' }], [{ startedAt: at(1) }]);
    expect(await advanceOutcome('o-a', { now: at(2) })).toBe('inconclusive');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'inconclusive', reason: 'cleared_before_fix' });
  });

  it('an alert that cleared after the script started starts the hold', async () => {
    vi.mocked(readAlertRecovery).mockResolvedValueOnce({ status: 'resolved', resolvedAt: at(1.5), resolvedBy: null, resolutionReason: 'condition_cleared' });
    rows.push([awaitingRow], [{ orgId: 'org-1' }], [{ startedAt: at(1) }]);
    expect(await advanceOutcome('o-a', { now: at(2) })).toBe('holding');
    expect(transitionMock.mock.calls[0]![1]).toMatchObject({ to: 'holding', recoveredAt: at(1.5) });
  });
});

describe('scanRecurrence fails closed when unsignable (Review Focus 3 — fix round 1)', () => {
  beforeEach(() => { rows.length = 0; transitionMock.mockReset().mockResolvedValue(true); });

  it('a holding outcome with no signature never reaches verified, even past the hold window', async () => {
    const holdingRow = {
      id: 'o-2', orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'holding', countedAt: null,
      signatureKey: null, sourceType: 'alert', sourceId: 'a-2', alertId: 'a-2', anomalyEpisodeId: null,
      signatureFacets: null, scriptExecutionId: null, deadlineAt: at(24), createdAt: at(0),
      recoveredAt: at(2), holdingUntil: at(26),
    };
    // fixOutcomes lookup, device-org lookup. scanRecurrence returns
    // 'unsignable' before ever touching the alerts table, so no third batch.
    rows.push([holdingRow], [{ orgId: 'org-1' }]);

    const result = await advanceOutcome('o-2', { now: at(30) });

    expect(result).toBe('inconclusive');
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'inconclusive', reason: 'recurrence_unsignable' });
  });
});

describe('holding -> verified re-checks the source (Review Focus 3 — fix round 1)', () => {
  beforeEach(() => {
    rows.length = 0;
    transitionMock.mockReset().mockResolvedValue(true);
    vi.mocked(probeTelemetryFreshness).mockReset();
    vi.mocked(readAlertRecovery).mockReset();
  });

  const holdingRow = (id: string, alertId: string) => ({
    id, orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'holding', countedAt: null,
    signatureKey: 'k'.repeat(64), sourceType: 'alert', sourceId: alertId, alertId, anomalyEpisodeId: null,
    signatureFacets: null, scriptExecutionId: null, deadlineAt: at(24), createdAt: at(0),
    recoveredAt: at(2), holdingUntil: at(26),
  });

  it('a reopened alert blocks verification even with fresh telemetry and no recurrence (fail closed)', async () => {
    // fixOutcomes lookup, device-org lookup, empty recurrence-scan alert batch.
    rows.push([holdingRow('o-3', 'a-3')], [{ orgId: 'org-1' }], []);
    vi.mocked(probeTelemetryFreshness).mockResolvedValueOnce({ fresh: true, reason: 'ok', coverage: 0.9 });
    vi.mocked(readAlertRecovery).mockResolvedValueOnce({ status: 'active', resolvedAt: null, resolvedBy: null, resolutionReason: null });

    const result = await advanceOutcome('o-3', { now: at(30) });

    expect(result).toBe('inconclusive');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'inconclusive', reason: 'source_not_resolved' });
  });

  it('a source that is now closed some OTHER way (human resolve, dismiss) no longer confirms the hold (M1)', async () => {
    rows.push([holdingRow('o-5', 'a-5')], [{ orgId: 'org-1' }], []);
    vi.mocked(probeTelemetryFreshness).mockResolvedValueOnce({ fresh: true, reason: 'ok', coverage: 0.9 });
    vi.mocked(readAlertRecovery).mockResolvedValueOnce({ status: 'resolved', resolvedAt: at(20), resolvedBy: 'user-1', resolutionReason: 'manual' });

    const result = await advanceOutcome('o-5', { now: at(30) });

    expect(result).toBe('inconclusive');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'inconclusive', reason: 'source_not_resolved' });
  });

  it('verifies normally once the source re-check confirms it is still resolved', async () => {
    rows.push([holdingRow('o-4', 'a-4')], [{ orgId: 'org-1' }], []);
    vi.mocked(probeTelemetryFreshness).mockResolvedValueOnce({ fresh: true, reason: 'ok', coverage: 0.9 });
    vi.mocked(readAlertRecovery).mockResolvedValueOnce({ status: 'resolved', resolvedAt: at(2), resolvedBy: null, resolutionReason: 'condition_cleared' });

    const result = await advanceOutcome('o-4', { now: at(30) });

    expect(result).toBe('verified');
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'verified', reason: 'held_with_fresh_telemetry' });
  });
});

describe('built-in pending readings (W2 Task 15)', () => {
  it.each([
    ['completed', { status: 'completed', exitCode: 0 }],
    ['failed', { status: 'failed', exitCode: null }],
    ['timeout', { status: 'timeout', exitCode: null }],
    ['cancelled', { status: 'cancelled', exitCode: null }],
    ['sent', { status: 'running', exitCode: null }],
    [null, null],
  ])('command %s', (status, reading) => expect(readingFromCommand(status)).toEqual(reading));

  it.each([
    ['executed', null, { status: 'completed', exitCode: 0 }],
    ['failed', 'boom', { status: 'failed', exitCode: null }],
    ['running', null, { status: 'running', exitCode: null }],
    [null, null, null],
  ])('cleanup run %s', (status, error, reading) => expect(readingFromCleanupRun(status, error)).toEqual(reading));

  it('a pending built-in attempt reads its command, not a script execution', async () => {
    transitionMock.mockReset();
    transitionMock.mockResolvedValue(true);
    const row = {
      id: 'o-1', state: 'pending', deviceId: 'd-1', orgId: 'org-1', actionCommandId: 'cmd-1', actionCleanupRunId: null,
      scriptExecutionId: null, deadlineAt: at(24), createdAt: at(0), alertId: null,
    };
    // 1: the outcome row, 2: deviceLeftOrg, 3: the device_commands status
    rows.push([row], [{ orgId: 'org-1' }], [{ status: 'completed' }]);
    await advanceOutcome('o-1');
    expect(transitionMock.mock.calls[0]![1]).toMatchObject({ to: 'awaiting_recovery', reason: 'script_succeeded' });
  });
});
