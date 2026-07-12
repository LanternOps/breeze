import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PartnerAggregates } from './heuristics';
import type { ComputedSignal } from './types';

const {
  computeInvariantSignals,
  loadPartnerAggregates,
  computeHeuristicSignals,
  persistSignals,
  markDelivered,
  sendOpsAlert,
  recordAbuseSignalFired,
} = vi.hoisted(() => ({
  computeInvariantSignals: vi.fn(),
  loadPartnerAggregates: vi.fn(),
  computeHeuristicSignals: vi.fn(),
  persistSignals: vi.fn(),
  markDelivered: vi.fn(),
  sendOpsAlert: vi.fn(),
  recordAbuseSignalFired: vi.fn(),
}));

// Context helpers as pass-through fns — the sweep's own runSystemDbCompute
// wiring (Fix 4: hard-throws if either is missing) is covered separately;
// here we just need them to be functions so the sweep runs.
vi.mock('../../db', () => ({
  // `db` itself is only used by runAbuseDigest (not exercised by this file's
  // tests), but index.ts destructures it at module load time.
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('./invariants', () => ({ computeInvariantSignals }));
vi.mock('./heuristics', () => ({ loadPartnerAggregates, computeHeuristicSignals }));
vi.mock('./persistence', () => ({ persistSignals, markDelivered }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert, isOpsAlertingConfigured: vi.fn(() => true) }));
vi.mock('../abuseMetrics', () => ({ recordAbuseSignalFired, recordAbuseSweepRun: vi.fn() }));

import { runAbuseSweep } from './index';

function agg(overrides: Partial<PartnerAggregates>): PartnerAggregates {
  return {
    partnerId: 'p1',
    partnerName: 'Acme',
    partnerCreatedAt: new Date('2026-07-01T00:00:00Z'),
    deviceCount: 0,
    consumerHostnameCount: 0,
    enrolled24h: 0,
    distinctEnrollmentIps30d: 0,
    devicesEnrolled30d: 0,
    sessions7d: 0,
    fastRemoteSessions7d: 0,
    failedLogins24h: 0,
    enrollmentDenied24h: 0,
    commands24h: 0,
    scriptExecutions24h: 0,
    ...overrides,
  };
}

function notifiable(rowId: string, partnerId = 'p1'): ComputedSignal & { rowId: string } {
  return {
    partnerId,
    signalKey: 'rmm.consumer_devices',
    score: 90,
    severity: 'alert',
    evidence: {},
    rowId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  computeInvariantSignals.mockResolvedValue([]);
  loadPartnerAggregates.mockResolvedValue([agg({})]);
  computeHeuristicSignals.mockReturnValue([]);
  persistSignals.mockResolvedValue({ toNotify: [] });
  markDelivered.mockResolvedValue(undefined);
});

describe('runAbuseSweep', () => {
  it('marks every notifiable row delivered when every send succeeds', async () => {
    persistSignals.mockResolvedValue({ toNotify: [notifiable('r1'), notifiable('r2')] });
    sendOpsAlert.mockResolvedValue(true);

    const result = await runAbuseSweep();

    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(markDelivered.mock.calls[0]![0]).toEqual(['r1', 'r2']);
    expect(result.notified).toBe(2);
  });

  it('does not call markDelivered when sendOpsAlert returns false for everything', async () => {
    persistSignals.mockResolvedValue({ toNotify: [notifiable('r1'), notifiable('r2')] });
    sendOpsAlert.mockResolvedValue(false);

    const result = await runAbuseSweep();

    expect(markDelivered).not.toHaveBeenCalled();
    expect(result.notified).toBe(0);
  });

  it('marks only the rows whose delivery succeeded when delivery is partial', async () => {
    persistSignals.mockResolvedValue({
      toNotify: [notifiable('r1'), notifiable('r2'), notifiable('r3')],
    });
    sendOpsAlert
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await runAbuseSweep();

    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(markDelivered.mock.calls[0]![0]).toEqual(['r1', 'r3']);
    expect(result.notified).toBe(2);
  });

  it('passes persistSignals an evaluatedPartnerIds set built from the aggregates partnerIds', async () => {
    loadPartnerAggregates.mockResolvedValue([agg({ partnerId: 'pA' }), agg({ partnerId: 'pB' })]);

    await runAbuseSweep();

    expect(persistSignals).toHaveBeenCalledTimes(1);
    const evaluatedPartnerIds = persistSignals.mock.calls[0]![2] as Set<string>;
    expect(evaluatedPartnerIds).toBeInstanceOf(Set);
    expect([...evaluatedPartnerIds].sort()).toEqual(['pA', 'pB']);
  });
});
