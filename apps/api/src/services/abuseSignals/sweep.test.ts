import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PartnerAggregates } from './heuristics';
import type { ComputedSignal } from './types';

const {
  computeInvariantSignals,
  loadPartnerAggregates,
  computeHeuristicSignals,
  loadHostnameIndicators,
  loadScriptFindings,
  computeScriptSignals,
  loadScriptIndicators,
  loadBillingIdentityAggregates,
  computeBillingIdentitySignals,
  syncEndpointFingerprints,
  loadRecidivistMatches,
  computeRecidivistSignals,
  loadOriginIpAggregates,
  persistSignals,
  markDelivered,
  sendOpsAlert,
  recordAbuseSignalFired,
} = vi.hoisted(() => ({
  computeInvariantSignals: vi.fn(),
  loadPartnerAggregates: vi.fn(),
  computeHeuristicSignals: vi.fn(),
  loadHostnameIndicators: vi.fn(),
  loadScriptFindings: vi.fn(),
  computeScriptSignals: vi.fn(),
  loadScriptIndicators: vi.fn(),
  loadBillingIdentityAggregates: vi.fn(),
  computeBillingIdentitySignals: vi.fn(),
  syncEndpointFingerprints: vi.fn(),
  loadRecidivistMatches: vi.fn(),
  computeRecidivistSignals: vi.fn(),
  loadOriginIpAggregates: vi.fn(),
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
vi.mock('./heuristics', () => ({ loadPartnerAggregates, computeHeuristicSignals, loadHostnameIndicators }));
vi.mock('./scriptContent', () => ({ loadScriptFindings, computeScriptSignals, loadScriptIndicators }));
vi.mock('./billingIdentity', () => ({ loadBillingIdentityAggregates, computeBillingIdentitySignals }));
vi.mock('./recidivistEndpoint', () => ({
  syncEndpointFingerprints,
  loadRecidivistMatches,
  computeRecidivistSignals,
}));
// computeOriginIpSignals is deliberately NOT mocked — the wiring test below
// proves the real scorer runs inside the sweep and its output reaches
// persistSignals and the corroborator.
vi.mock('./originIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./originIp')>()),
  loadOriginIpAggregates,
}));
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
    lastSeenIps: [],
    hostnames: [],
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
  loadHostnameIndicators.mockReturnValue({ prefixes: [] });
  loadScriptFindings.mockResolvedValue({ findings: [], sharedHosts: new Map(), scannedPartnerIds: [] });
  computeScriptSignals.mockReturnValue([]);
  loadScriptIndicators.mockReturnValue({ tlds: [], hosts: [] });
  loadBillingIdentityAggregates.mockResolvedValue({
    aggregates: [],
    sharedFingerprints: new Map(),
    scannedPartnerIds: [],
  });
  computeBillingIdentitySignals.mockReturnValue([]);
  syncEndpointFingerprints.mockResolvedValue(undefined);
  loadRecidivistMatches.mockResolvedValue({ matches: [], scannedPartnerIds: [] });
  computeRecidivistSignals.mockReturnValue([]);
  loadOriginIpAggregates.mockResolvedValue({
    aggregates: [],
    corpus: { suspendedIps: new Map(), probes: [] },
    scannedPartnerIds: [],
  });
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

  it('threads the loaded hostname indicators into computeHeuristicSignals', async () => {
    // computeHeuristicSignals takes the indicator list as its 4th argument and
    // it feeds the only alert-capable tier of rmm.provider_default_hostname.
    // Nothing else in this suite would notice the sweep dropping the argument,
    // so the curated tier could be disconnected with zero test failures.
    const indicators = { prefixes: ['xy-'] };
    loadHostnameIndicators.mockReturnValue(indicators);

    await runAbuseSweep();

    expect(loadHostnameIndicators).toHaveBeenCalledTimes(1);
    expect(computeHeuristicSignals).toHaveBeenCalledTimes(1);
    expect(computeHeuristicSignals.mock.calls[0]![3]).toBe(indicators);
  });

  it('passes persistSignals an evaluatedPartnerIds set built from the aggregates partnerIds', async () => {
    loadPartnerAggregates.mockResolvedValue([agg({ partnerId: 'pA' }), agg({ partnerId: 'pB' })]);

    await runAbuseSweep();

    expect(persistSignals).toHaveBeenCalledTimes(1);
    const evaluatedPartnerIds = persistSignals.mock.calls[0]![2] as Set<string>;
    expect(evaluatedPartnerIds).toBeInstanceOf(Set);
    expect([...evaluatedPartnerIds].sort()).toEqual(['pA', 'pB']);
  });

  it('unions script-scanned partner ids into evaluatedPartnerIds so script signals can stale-resolve', async () => {
    loadPartnerAggregates.mockResolvedValue([agg({ partnerId: 'pA' })]);
    loadScriptFindings.mockResolvedValue({
      findings: [],
      sharedHosts: new Map(),
      scannedPartnerIds: ['pA', 'pScript'],
    });

    await runAbuseSweep();

    const evaluatedPartnerIds = persistSignals.mock.calls[0]![2] as Set<string>;
    expect([...evaluatedPartnerIds].sort()).toEqual(['pA', 'pScript']);
  });

  it('unions billing-scanned partner ids into evaluatedPartnerIds so billing signals can stale-resolve', async () => {
    loadPartnerAggregates.mockResolvedValue([agg({ partnerId: 'pA' })]);
    loadBillingIdentityAggregates.mockResolvedValue({
      aggregates: [],
      sharedFingerprints: new Map(),
      scannedPartnerIds: ['pA', 'pBilling'],
    });

    await runAbuseSweep();

    const evaluatedPartnerIds = persistSignals.mock.calls[0]![2] as Set<string>;
    expect([...evaluatedPartnerIds].sort()).toEqual(['pA', 'pBilling']);
  });

  it('includes computeBillingIdentitySignals output in the persisted signal set', async () => {
    const billingSignal: ComputedSignal = {
      partnerId: 'pB',
      signalKey: 'billing.shared_card_fingerprint',
      score: 70,
      severity: 'alert',
      evidence: {},
    };
    computeBillingIdentitySignals.mockReturnValue([billingSignal]);

    const result = await runAbuseSweep();

    expect(result.fired).toBe(1);
    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    expect(persisted).toContainEqual(billingSignal);
  });

  it('includes computeScriptSignals output in the persisted signal set', async () => {
    const scriptSignal: ComputedSignal = {
      partnerId: 'pS',
      signalKey: 'rmm.remote_access_installer',
      score: 90,
      severity: 'alert',
      evidence: {},
    };
    computeScriptSignals.mockReturnValue([scriptSignal]);

    const result = await runAbuseSweep();

    expect(result.fired).toBe(1);
    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    expect(persisted).toContainEqual(scriptSignal);
  });

  it('includes computeRecidivistSignals output in the persisted signal set', async () => {
    const recidivistSignal: ComputedSignal = {
      partnerId: 'pR',
      signalKey: 'rmm.recidivist_endpoint',
      score: 100,
      severity: 'alert',
      evidence: {},
    };
    computeRecidivistSignals.mockReturnValue([recidivistSignal]);

    const result = await runAbuseSweep();

    expect(result.fired).toBe(1);
    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    expect(persisted).toContainEqual(recidivistSignal);
  });

  it('unions recidivist-scanned partner ids into evaluatedPartnerIds so recidivist signals can stale-resolve', async () => {
    loadPartnerAggregates.mockResolvedValue([agg({ partnerId: 'pA' })]);
    loadRecidivistMatches.mockResolvedValue({
      matches: [],
      scannedPartnerIds: ['pA', 'pRecidivist'],
    });

    await runAbuseSweep();

    const evaluatedPartnerIds = persistSignals.mock.calls[0]![2] as Set<string>;
    expect([...evaluatedPartnerIds].sort()).toEqual(['pA', 'pRecidivist']);
  });
});

describe('runAbuseSweep — corroboration wiring', () => {
  // The pure scorer is covered in corroboration.test.ts; these prove the sweep
  // actually feeds it every detector's output and persists what it returns.
  // './corroboration' is deliberately NOT mocked here.
  function watch(signalKey: string, score: number, partnerId = 'p1'): ComputedSignal {
    return { partnerId, signalKey, score, severity: 'watch', evidence: { partnerName: 'Acme' } };
  }

  it('emits a corroborated alert from watch signals produced by DIFFERENT detectors', async () => {
    // session_intensity comes from heuristics, cardholder_name_mismatch from
    // billingIdentity — the cross-detector case that motivated this.
    computeHeuristicSignals.mockReturnValue([watch('rmm.session_intensity', 65)]);
    computeBillingIdentitySignals.mockReturnValue([watch('billing.cardholder_name_mismatch', 55)]);

    await runAbuseSweep();

    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    const corroborated = persisted.filter((s) => s.signalKey === 'fraud.corroborated_watch');
    expect(corroborated).toHaveLength(1);
    expect(corroborated[0]!.severity).toBe('alert');
    expect(corroborated[0]!.partnerId).toBe('p1');
    // The underlying signals are still persisted at their own honest severity.
    expect(persisted.filter((s) => s.severity === 'watch')).toHaveLength(2);
  });

  it('does not corroborate when only one axis fires', async () => {
    computeHeuristicSignals.mockReturnValue([watch('rmm.session_intensity', 65)]);

    await runAbuseSweep();

    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    expect(persisted.some((s) => s.signalKey === 'fraud.corroborated_watch')).toBe(false);
  });

  it('counts the corroborated signal in the fired total and the severity metric', async () => {
    computeHeuristicSignals.mockReturnValue([watch('rmm.session_intensity', 65)]);
    computeBillingIdentitySignals.mockReturnValue([watch('billing.cardholder_name_mismatch', 55)]);

    const result = await runAbuseSweep();

    expect(result.fired).toBe(3);
    expect(recordAbuseSignalFired).toHaveBeenCalledWith('alert');
  });
});

describe('runAbuseSweep — origin-IP detector wiring', () => {
  it('reproduces the 08-31 re-establishment: a /24 probe match plus a billing mismatch pages', async () => {
    // The account that got away. The operator probed a SUSPENDED partner's
    // login from 192.0.2.72, signed up minutes later from a clean residential
    // address (so the signup gate saw nothing), then worked the new account
    // from 192.0.2.61. Its only signal was a capped billing watch, which
    // notified nobody, and $99 was captured before anyone looked.
    //
    // Origin-IP contributes a second INDEPENDENT axis, and the pair clears
    // severity.alert_score through the existing corroborator.
    loadOriginIpAggregates.mockResolvedValue({
      aggregates: [
        {
          partnerId: 'p1',
          partnerName: 'Nordvane',
          partnerStatus: 'active' as const,
          originIps: ['192.0.2.61'],
        },
      ],
      corpus: {
        suspendedIps: new Map(),
        probes: [{ ip: '192.0.2.72', partnerName: 'Techlace', at: new Date() }],
      },
      scannedPartnerIds: ['p1'],
    });
    computeBillingIdentitySignals.mockReturnValue([
      {
        partnerId: 'p1',
        signalKey: 'billing.cardholder_name_mismatch',
        score: 55,
        severity: 'watch',
        evidence: { partnerName: 'Nordvane' },
      },
    ]);

    await runAbuseSweep();

    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    const byKey = new Map(persisted.map((s) => [s.signalKey, s]));

    // The detector itself stays honest at watch — a /24 is a weaker tie than
    // an exact address.
    expect(byKey.get('fraud.dead_account_probe_origin')?.severity).toBe('watch');
    // ...and the two axes together reach alert, which is what pages.
    const corroborated = byKey.get('fraud.corroborated_watch');
    expect(corroborated?.severity).toBe('alert');
    expect(corroborated?.evidence.axisCount).toBe(2);

    // Origin-IP-scanned partners must join the evaluated set, or their rows can
    // never stale-resolve once the operator's infrastructure goes quiet.
    const evaluated = persistSignals.mock.calls[0]![2] as Set<string>;
    expect(evaluated.has('p1')).toBe(true);
  });

  it('does not double-count the two origin-IP signals as independent axes', async () => {
    // Both signals restate one observation. An exact match already suppresses
    // the /24 row, but even if both were present they share an axis and must
    // not manufacture an alert between themselves.
    loadOriginIpAggregates.mockResolvedValue({
      aggregates: [
        {
          partnerId: 'p1',
          partnerName: 'Nordvane',
          partnerStatus: 'pending' as const,
          originIps: ['192.0.2.61'],
        },
      ],
      corpus: {
        suspendedIps: new Map(),
        probes: [{ ip: '192.0.2.72', partnerName: 'Techlace', at: new Date() }],
      },
      scannedPartnerIds: ['p1'],
    });

    await runAbuseSweep();

    const persisted = persistSignals.mock.calls[0]![0] as ComputedSignal[];
    expect(persisted.map((s) => s.signalKey)).toEqual(['fraud.dead_account_probe_origin']);
    expect(persisted.some((s) => s.signalKey === 'fraud.corroborated_watch')).toBe(false);
  });
});
