import { describe, it, expect, afterEach } from 'vitest';
import {
  computeHeuristicSignals,
  ipPrefixGroup,
  classifyHostname,
  loadHostnameIndicators,
  type PartnerAggregates,
} from './heuristics';
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
    hostnames: [],
    ...overrides,
  };
}

const HOST_SIGNAL = 'rmm.provider_default_hostname';
const hostSignal = (a: PartnerAggregates, indicators = { prefixes: [] as string[] }) =>
  computeHeuristicSignals([a], SIGNAL_DEFAULTS, now, indicators).find((s) => s.signalKey === HOST_SIGNAL);

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

  it('weighs fast enroll-to-remote sessions, but only to watch tier', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 5, sessions7d: 12, fastRemoteSessions7d: 5 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.session_intensity');
    expect(s).toBeDefined();
    expect(s!.severity).toBe('watch');
  });

  // Session shape corroborates but never accuses — no input, however extreme,
  // may reach alert on its own. Shapes below are drawn from real reviewed
  // accounts on both sides of the call, which scored identically here.
  it.each([
    ['single device, few sessions', { deviceCount: 1, sessions7d: 5, fastRemoteSessions7d: 5 }],
    ['single device, more sessions', { deviceCount: 1, sessions7d: 9, fastRemoteSessions7d: 9 }],
    ['absurd volume', { deviceCount: 1, sessions7d: 5000, fastRemoteSessions7d: 5000 }],
  ])('never alerts on session shape alone (%s)', (_label, shape) => {
    const s = computeHeuristicSignals([agg(shape)], SIGNAL_DEFAULTS, now).find(
      (x) => x.signalKey === 'rmm.session_intensity',
    );
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(s!.severity).not.toBe('alert');
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

describe('classifyHostname', () => {
  const none = { prefixes: [] };

  it('classifies a provider serial hostname as generic', () => {
    expect(classifyHostname('ZQ-40001', none)).toBe('generic');
    expect(classifyHostname('zq-40002', none)).toBe('generic');
    expect(classifyHostname('ABCD-12345678', none)).toBe('generic');
  });

  it('classifies a stock Windows Server computer name as generic', () => {
    expect(classifyHostname('WIN-A1B2C3D4E5F', none)).toBe('generic');
    expect(classifyHostname('WIN-K9M2P4Q7R1T', none)).toBe('generic');
  });

  it('leaves DESKTOP-/LAPTOP- to rmm.consumer_devices so a device is never double-counted', () => {
    expect(classifyHostname('DESKTOP-A1B2C3D', none)).toBeNull();
    expect(classifyHostname('LAPTOP-X9Y8Z7W', none)).toBeNull();
  });

  it('does not match real named or domain-joined machines', () => {
    for (const h of ['ACME-RECEPTION', 'ACME-FILESRV', 'ACME-DC01', 'jsmith-laptop', 'ACME-WS-SPARE', 'Workstation42']) {
      expect(classifyHostname(h, none)).toBeNull();
    }
  });

  it('does not match a short numeric suffix that a real naming scheme would use', () => {
    // PC-42 / WS-007 are plausible human schemes; the provider defaults this
    // targets carry long serials.
    expect(classifyHostname('PC-42', none)).toBeNull();
    expect(classifyHostname('WS-007', none)).toBeNull();
  });

  it('promotes a curated prefix above the generic shape', () => {
    expect(classifyHostname('XY-99887', { prefixes: ['xy-'] })).toBe('curated');
    // Curated matching is prefix-based, so it catches names the shape misses.
    expect(classifyHostname('xy-staging-box', { prefixes: ['xy-'] })).toBe('curated');
    expect(classifyHostname('xy-staging-box', none)).toBeNull();
  });

  it('matches curated prefixes case-insensitively and ignores blank hostnames', () => {
    expect(classifyHostname('  XY-1  ', { prefixes: ['xy-'] })).toBe('curated');
    expect(classifyHostname('   ', { prefixes: ['xy-'] })).toBeNull();
  });
});

describe('loadHostnameIndicators', () => {
  afterEach(() => {
    delete process.env.ABUSE_HOSTNAME_INDICATORS;
  });

  it('is empty when unset, so the public repo names no provider', () => {
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
  });

  it('parses, lowercases and trims a prefix list', () => {
    process.env.ABUSE_HOSTNAME_INDICATORS = JSON.stringify({ prefixes: [' XY- ', 'ZZ-'] });
    expect(loadHostnameIndicators()).toEqual({ prefixes: ['xy-', 'zz-'] });
  });

  it('falls back to empty on malformed input rather than throwing mid-sweep', () => {
    process.env.ABUSE_HOSTNAME_INDICATORS = 'not json';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    process.env.ABUSE_HOSTNAME_INDICATORS = '["xy-"]';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    process.env.ABUSE_HOSTNAME_INDICATORS = JSON.stringify({ prefixes: [1, '', 'xy-'] });
    expect(loadHostnameIndicators()).toEqual({ prefixes: ['xy-'] });
  });
});

describe('rmm.provider_default_hostname', () => {
  it('alerts on a single curated-prefix device', () => {
    const s = hostSignal(agg({ deviceCount: 1, hostnames: ['XY-22257'] }), { prefixes: ['xy-'] });
    expect(s).toBeDefined();
    expect(s!.severity).toBe('alert');
    // Examples keep the hostname exactly as stored — triage needs the real
    // string to search on, not a normalized one.
    expect(s!.evidence).toMatchObject({ tier: 'curated', matchedHostnames: 1, examples: ['XY-22257'] });
  });

  it('scores curated matches linearly so extra real devices cannot dilute it', () => {
    const one = hostSignal(agg({ deviceCount: 1, hostnames: ['XY-1'] }), { prefixes: ['xy-'] })!;
    const three = hostSignal(
      agg({ deviceCount: 40, hostnames: ['XY-1', 'XY-2', 'XY-3', ...Array.from({ length: 37 }, (_, i) => `ACME-SRV${i}`)] }),
      { prefixes: ['xy-'] },
    )!;
    expect(three.score).toBeGreaterThan(one.score);
    expect(three.severity).toBe('alert');
  });

  it('caps the generic tier below the alert threshold', () => {
    const s = hostSignal(agg({
      deviceCount: 12,
      hostnames: Array.from({ length: 12 }, (_, i) => `WIN-A1B2C3D4E${String(i).padStart(2, '0')}`),
    }))!;
    expect(s.score).toBeLessThan(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(s.severity).toBe('watch');
    expect(s.evidence).toMatchObject({ tier: 'generic' });
  });

  it('does not fire generic on one stray stock name in a properly-named fleet', () => {
    const hostnames = ['WIN-A1B2C3D4E5F', ...Array.from({ length: 29 }, (_, i) => `ACME-WS${i}`)];
    expect(hostSignal(agg({ deviceCount: 30, hostnames }))).toBeUndefined();
  });

  it('does not fire generic below generic_min_devices', () => {
    expect(hostSignal(agg({ deviceCount: 2, hostnames: ['ZQ-40001', 'ZQ-40003'] }))).toBeUndefined();
  });

  it('emits one signal per partner, never both tiers for the same fleet', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 4, hostnames: ['XY-1', 'WIN-A1B2C3D4E5F', 'WIN-K9M2P4Q7R1T', 'WIN-B3N5V8X2Z6C'] })],
      SIGNAL_DEFAULTS,
      now,
      { prefixes: ['xy-'] },
    ).filter((s) => s.signalKey === HOST_SIGNAL);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toMatchObject({ tier: 'curated' });
  });

  it('is not age-decayed — an old account running stock VMs still scores', () => {
    const old = agg({
      partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), // ~6 months → zero young weight
      deviceCount: 1,
      hostnames: ['XY-22257'],
    });
    expect(hostSignal(old, { prefixes: ['xy-'] })!.severity).toBe('alert');
  });

  it('stays silent for a fleet with no stock names', () => {
    expect(hostSignal(agg({ deviceCount: 5, hostnames: ['ACME-RECEPTION', 'ACME-FILESRV', 'ACME-DC01', 'jsmith-laptop', 'ACME-WS07'] })))
      .toBeUndefined();
  });
});
