import { describe, it, expect } from 'vitest';
import { computeHeuristicSignals, type PartnerAggregates } from './heuristics';
import { SIGNAL_DEFAULTS } from './config';

const now = new Date('2026-07-15T00:00:00Z');

function agg(overrides: Partial<PartnerAggregates>): PartnerAggregates {
  return {
    partnerId: 'p1',
    partnerName: 'Acme',
    partnerCreatedAt: new Date('2026-07-10T00:00:00Z'), // 5 days old → full weight
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

describe('computeHeuristicSignals', () => {
  it('emits nothing for a quiet partner', () => {
    expect(computeHeuristicSignals([agg({})], SIGNAL_DEFAULTS, now)).toEqual([]);
  });

  it('fires consumer_devices when ratio and fleet size exceed thresholds', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, consumerHostnameCount: 9 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.consumer_devices');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ deviceCount: 10, consumerHostnameCount: 9 });
    expect(s!.score).toBeGreaterThan(0);
  });

  it('fires enrollment_velocity on a 24h burst', () => {
    const signals = computeHeuristicSignals([agg({ enrolled24h: 30, deviceCount: 30 })], SIGNAL_DEFAULTS, now);
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_velocity')).toBe(true);
  });

  it('weighs fast enroll-to-remote sessions heavily', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 5, sessions7d: 12, fastRemoteSessions7d: 5 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.session_intensity');
    expect(s).toBeDefined();
    expect(s!.severity).toBe('alert');
  });

  it('fires enrollment_ip_spread when nearly every device came from a distinct IP', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, devicesEnrolled30d: 10, distinctEnrollmentIps30d: 10 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_ip_spread')).toBe(true);
  });

  it('decays scores for old partners (zero weight at 90+ days)', () => {
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), deviceCount: 10, consumerHostnameCount: 10 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals).toEqual([]); // weight 0 → score 0 → not emitted
  });

  it('does not decay fraud/resource signals', () => {
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), failedLogins24h: 100 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'fraud.failed_login_cluster')).toBe(true);
  });

  it('fires enrollment_denied on repeated cap/key rejections', () => {
    const signals = computeHeuristicSignals([agg({ enrollmentDenied24h: 40 })], SIGNAL_DEFAULTS, now);
    expect(signals.some((x) => x.signalKey === 'resource.enrollment_denied')).toBe(true);
  });

  it('emits nothing (not NaN) when a threshold is overridden to 0', () => {
    const cfg = { ...SIGNAL_DEFAULTS, 'rmm.enrollment_velocity.devices_24h': 0 };
    const signals = computeHeuristicSignals([agg({ enrolled24h: 0, deviceCount: 0 })], cfg, now);
    expect(signals).toEqual([]);
  });

  it('fires volume_outlier on command volume regardless of partner age', () => {
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), commands24h: 1200 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'resource.volume_outlier');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ commands24h: 1200 });
  });
});
