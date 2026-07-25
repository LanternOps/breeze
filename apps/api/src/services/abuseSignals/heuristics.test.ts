import { describe, it, expect } from 'vitest';
import { computeHeuristicSignals, ipPrefixGroup, type PartnerAggregates } from './heuristics';
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
    lastSeenIps: [],
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

  it('fires device_ip_scatter at watch (never alert) for a fully scattered IPv4 fleet', () => {
    // 10 devices, each on a different residential /24 — the victim-fleet shape.
    const ips = Array.from({ length: 10 }, (_, i) => `10.${i}.0.1`);
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.device_ip_scatter');
    expect(s).toBeDefined();
    expect(s!.severity).toBe('watch');
    expect(s!.score).toBeLessThan(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(s!.evidence).toMatchObject({
      deviceCount: 10,
      devicesWithIp: 10,
      distinctPrefixes: 10,
      scatterRatio: 1,
    });
    // No raw IPs in evidence.
    expect(JSON.stringify(s!.evidence)).not.toContain('10.0.0.1');
  });

  it('does not fire device_ip_scatter for an office fleet behind one /24', () => {
    const ips = Array.from({ length: 10 }, (_, i) => `192.0.2.${i + 1}`);
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('does not fire device_ip_scatter for a dual-stack office (distinct IPv6 addresses in one /64)', () => {
    // 6 devices with distinct IPv6 addresses inside one delegated /64, plus
    // 2 IPv4 devices behind one /24: 2 prefixes / 8 devices — no scatter.
    const ips = [
      ...Array.from({ length: 6 }, (_, i) => `2001:db8:0:1::${i + 10}`),
      '192.0.2.10',
      '192.0.2.11',
    ];
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 8, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('does not fire device_ip_scatter below min_devices even when fully scattered', () => {
    const ips = Array.from({ length: 5 }, (_, i) => `10.${i}.0.1`);
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 5, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('counts mixed v4/v6 prefixes correctly in device_ip_scatter', () => {
    // 4 distinct IPv4 /24s + 4 distinct IPv6 /64s = 8 prefixes / 8 devices.
    const ips = [
      ...Array.from({ length: 4 }, (_, i) => `10.${i}.0.1`),
      ...Array.from({ length: 4 }, (_, i) => `2001:db8:${i}:0::1`),
    ];
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 8, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.device_ip_scatter');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ devicesWithIp: 8, distinctPrefixes: 8, scatterRatio: 1 });
  });

  it('groups compressed and expanded IPv6 forms into one /64 in device_ip_scatter', () => {
    // 8 addresses, all inside 2001:db8:0:1::/64 written in mixed notations —
    // must count as ONE prefix, so no signal fires.
    const ips = [
      '2001:db8:0:1::1',
      '2001:0db8:0000:0001:0000:0000:0000:0002',
      '2001:DB8:0:1::3',
      '2001:db8::1:0:0:0:4',
      '2001:0db8:0:0001::5',
      '2001:db8:0:1:0:0:0:6',
      '2001:db8:0:1::7',
      '2001:db8:0:1:ffff:ffff:ffff:ffff',
    ];
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 8, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('drops unparseable IPs from both the numerator and denominator of device_ip_scatter', () => {
    // 9 scattered /24s + 3 junk values: the junk must not appear as prefixes
    // NOR pad devicesWithIp (which would dilute the ratio to 9/12 = 0.75 and
    // let a scattered fleet hide behind malformed values).
    const ips = [
      ...Array.from({ length: 9 }, (_, i) => `10.${i}.0.1`),
      'not-an-ip',
      '',
      '999.1.1.1',
    ];
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 12, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.device_ip_scatter');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ devicesWithIp: 9, distinctPrefixes: 9, scatterRatio: 1 });
  });

  it('does not fire device_ip_scatter when junk IPs leave fewer than min_devices parseable', () => {
    const ips = [
      ...Array.from({ length: 5 }, (_, i) => `10.${i}.0.1`),
      ...Array.from({ length: 5 }, () => 'not-an-ip'),
    ];
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('does not age-decay device_ip_scatter (fleet shape is age-independent evidence)', () => {
    const ips = Array.from({ length: 10 }, (_, i) => `10.${i}.0.1`);
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), deviceCount: 10, lastSeenIps: ips })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(true);
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

describe('ipPrefixGroup', () => {
  it('buckets IPv4 by /24', () => {
    expect(ipPrefixGroup('192.0.2.7')).toBe('v4:192.0.2');
    expect(ipPrefixGroup('192.0.2.200')).toBe(ipPrefixGroup('192.0.2.1'));
    expect(ipPrefixGroup('198.51.100.1')).not.toBe(ipPrefixGroup('192.0.2.1'));
  });

  it('buckets IPv6 by /64', () => {
    expect(ipPrefixGroup('2001:db8:0:1::1')).toBe('v6:2001:db8:0:1');
    expect(ipPrefixGroup('2001:db8:0:1:aaaa::1')).toBe(ipPrefixGroup('2001:db8:0:1:bbbb::2'));
    expect(ipPrefixGroup('2001:db8:0:2::1')).not.toBe(ipPrefixGroup('2001:db8:0:1::1'));
  });

  it('canonicalizes compressed, zero-padded, and mixed-case IPv6 forms into the same bucket', () => {
    const expanded = ipPrefixGroup('2001:0db8:0000:0001:0000:0000:0000:0009');
    expect(ipPrefixGroup('2001:db8:0:1::9')).toBe(expanded);
    expect(ipPrefixGroup('2001:DB8:0:1::9')).toBe(expanded);
    expect(ipPrefixGroup('::1')).toBe('v6:0:0:0:0');
  });

  it('buckets IPv4-mapped IPv6 with the embedded IPv4 /24', () => {
    expect(ipPrefixGroup('::ffff:192.0.2.9')).toBe('v4:192.0.2');
  });

  it('returns null for unparseable values', () => {
    expect(ipPrefixGroup('')).toBeNull();
    expect(ipPrefixGroup('not-an-ip')).toBeNull();
    expect(ipPrefixGroup('999.1.1.1')).toBeNull();
    expect(ipPrefixGroup('2001:db8::1::2')).toBeNull();
  });
});
