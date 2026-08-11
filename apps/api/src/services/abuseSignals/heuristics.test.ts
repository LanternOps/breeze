import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  computeHeuristicSignals,
  ipPrefixGroup,
  classifyHostname,
  loadHostnameIndicators,
  type HostnameIndicators,
  type PartnerAggregates,
} from './heuristics';
import { SIGNAL_DEFAULTS, type SignalConfig } from './config';

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

const NO_INDICATORS: HostnameIndicators = { prefixes: [] };

// computeHeuristicSignals takes the indicator list as a REQUIRED 4th argument
// (no default — a forgotten argument would silently disable the curated tier),
// so cases that aren't about hostnames route through here rather than repeating
// the empty list.
const compute = (
  aggs: PartnerAggregates[],
  cfg: SignalConfig = SIGNAL_DEFAULTS,
  indicators: HostnameIndicators = NO_INDICATORS,
) => computeHeuristicSignals(aggs, cfg, now, indicators);

const HOST_SIGNAL = 'rmm.provider_default_hostname';
const hostSignal = (a: PartnerAggregates, indicators: HostnameIndicators = NO_INDICATORS) =>
  compute([a], SIGNAL_DEFAULTS, indicators).find((s) => s.signalKey === HOST_SIGNAL);

describe('computeHeuristicSignals', () => {
  it('emits nothing for a quiet partner', () => {
    expect(compute([agg({})])).toEqual([]);
  });

  it('fires consumer_devices when ratio and fleet size exceed thresholds', () => {
    const signals = compute([agg({ deviceCount: 10, consumerHostnameCount: 9 })]);
    const s = signals.find((x) => x.signalKey === 'rmm.consumer_devices');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ deviceCount: 10, consumerHostnameCount: 9 });
    expect(s!.score).toBeGreaterThan(0);
  });

  it('fires enrollment_velocity on a 24h burst', () => {
    const signals = compute([agg({ enrolled24h: 30, deviceCount: 30 })]);
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_velocity')).toBe(true);
  });

  it('weighs fast enroll-to-remote sessions, but only to watch tier', () => {
    const signals = compute([agg({ deviceCount: 5, sessions7d: 12, fastRemoteSessions7d: 5 })]);
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
    const s = compute([agg(shape)]).find(
      (x) => x.signalKey === 'rmm.session_intensity',
    );
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(s!.severity).not.toBe('alert');
  });

  it('fires enrollment_ip_spread when nearly every device came from a distinct IP', () => {
    const signals = compute([agg({ deviceCount: 10, devicesEnrolled30d: 10, distinctEnrollmentIps30d: 10 })]);
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_ip_spread')).toBe(true);
  });

  it('decays scores for old partners (zero weight at 90+ days)', () => {
    const signals = compute([agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), deviceCount: 10, consumerHostnameCount: 10 })]);
    expect(signals).toEqual([]); // weight 0 → score 0 → not emitted
  });

  it('does not decay fraud/resource signals', () => {
    const signals = compute([agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), failedLogins24h: 100 })]);
    expect(signals.some((x) => x.signalKey === 'fraud.failed_login_cluster')).toBe(true);
  });

  it('fires enrollment_denied on repeated cap/key rejections', () => {
    const signals = compute([agg({ enrollmentDenied24h: 40 })]);
    expect(signals.some((x) => x.signalKey === 'resource.enrollment_denied')).toBe(true);
  });

  it('emits nothing (not NaN) when a threshold is overridden to 0', () => {
    const cfg = { ...SIGNAL_DEFAULTS, 'rmm.enrollment_velocity.devices_24h': 0 };
    const signals = compute([agg({ enrolled24h: 0, deviceCount: 0 })], cfg);
    expect(signals).toEqual([]);
  });

  it('fires device_ip_scatter at watch (never alert) for a fully scattered IPv4 fleet', () => {
    // 10 devices, each on a different residential /24 — the victim-fleet shape.
    const ips = Array.from({ length: 10 }, (_, i) => `10.${i}.0.1`);
    const signals = compute([agg({ deviceCount: 10, lastSeenIps: ips })]);
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
    const signals = compute([agg({ deviceCount: 10, lastSeenIps: ips })]);
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
    const signals = compute([agg({ deviceCount: 8, lastSeenIps: ips })]);
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('does not fire device_ip_scatter below min_devices even when fully scattered', () => {
    const ips = Array.from({ length: 5 }, (_, i) => `10.${i}.0.1`);
    const signals = compute([agg({ deviceCount: 5, lastSeenIps: ips })]);
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('counts mixed v4/v6 prefixes correctly in device_ip_scatter', () => {
    // 4 distinct IPv4 /24s + 4 distinct IPv6 /64s = 8 prefixes / 8 devices.
    const ips = [
      ...Array.from({ length: 4 }, (_, i) => `10.${i}.0.1`),
      ...Array.from({ length: 4 }, (_, i) => `2001:db8:${i}:0::1`),
    ];
    const signals = compute([agg({ deviceCount: 8, lastSeenIps: ips })]);
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
    const signals = compute([agg({ deviceCount: 8, lastSeenIps: ips })]);
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
    const signals = compute([agg({ deviceCount: 12, lastSeenIps: ips })]);
    const s = signals.find((x) => x.signalKey === 'rmm.device_ip_scatter');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ devicesWithIp: 9, distinctPrefixes: 9, scatterRatio: 1 });
  });

  it('does not fire device_ip_scatter when junk IPs leave fewer than min_devices parseable', () => {
    const ips = [
      ...Array.from({ length: 5 }, (_, i) => `10.${i}.0.1`),
      ...Array.from({ length: 5 }, () => 'not-an-ip'),
    ];
    const signals = compute([agg({ deviceCount: 10, lastSeenIps: ips })]);
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(false);
  });

  it('does not age-decay device_ip_scatter (fleet shape is age-independent evidence)', () => {
    const ips = Array.from({ length: 10 }, (_, i) => `10.${i}.0.1`);
    const signals = compute([agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), deviceCount: 10, lastSeenIps: ips })]);
    expect(signals.some((x) => x.signalKey === 'rmm.device_ip_scatter')).toBe(true);
  });

  it('fires volume_outlier on command volume regardless of partner age', () => {
    const signals = compute([agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), commands24h: 1200 })]);
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

  it('leaves site-code + serial naming alone — that is mainstream MSP practice, not a provider default', () => {
    // The built-in list is restricted to stock-OS-installer artifacts. A
    // <tag>-<serial> shape is how a large share of MSPs name endpoints, and
    // since this signal never decays, a watch row raised on one could never
    // stale-resolve. Such prefixes belong in ABUSE_HOSTNAME_INDICATORS.
    for (const h of ['ZQ-40001', 'zq-40002', 'ABCD-12345678', 'PC-00123', 'SRV-0001', 'NY-10045']) {
      expect(classifyHostname(h, none)).toBeNull();
    }
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

  it('does not match a near-miss of the stock Windows shape', () => {
    // WIN- with anything other than exactly 11 alphanumerics is a human name.
    expect(classifyHostname('WIN-A1B2C3', none)).toBeNull();
    expect(classifyHostname('WIN-A1B2C3D4E5F6', none)).toBeNull();
    expect(classifyHostname('WIN-SERVER-01', none)).toBeNull();
  });

  it('promotes a curated prefix above the generic shape', () => {
    expect(classifyHostname('XY-99887', { prefixes: ['xy-'] })).toBe('curated');
    // Curated matching is prefix-based, so it catches names no built-in
    // pattern does — that is the whole point of the operator-supplied list.
    expect(classifyHostname('xy-staging-box', { prefixes: ['xy-'] })).toBe('curated');
    expect(classifyHostname('xy-staging-box', none)).toBeNull();
    // And it outranks the generic shape, so one host is never scored twice.
    expect(classifyHostname('WIN-A1B2C3D4E5F', { prefixes: ['win-'] })).toBe('curated');
  });

  it('matches curated prefixes case-insensitively and ignores blank hostnames', () => {
    expect(classifyHostname('  XY-1  ', { prefixes: ['xy-'] })).toBe('curated');
    expect(classifyHostname('   ', { prefixes: ['xy-'] })).toBeNull();
  });
});

describe('loadHostnameIndicators', () => {
  afterEach(() => {
    delete process.env.ABUSE_HOSTNAME_INDICATORS;
    vi.restoreAllMocks();
  });

  it('is empty when unset, so the public repo names no provider', () => {
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
  });

  it('parses, lowercases and trims a prefix list', () => {
    process.env.ABUSE_HOSTNAME_INDICATORS = JSON.stringify({ prefixes: [' XY- ', 'ZZ-'] });
    expect(loadHostnameIndicators()).toEqual({ prefixes: ['xy-', 'zz-'] });
  });

  it('drops whitespace-only entries instead of normalizing them to a catch-all prefix', () => {
    // A ' ' entry passes a length check on the RAW string and then trims to
    // '', and host.startsWith('') is true for every hostname — the whole fleet
    // would classify as 'curated', which is alert-capable with no ratio gate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_HOSTNAME_INDICATORS = JSON.stringify({ prefixes: [' ', '\t'] });
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2'));
    expect(classifyHostname('ACME-DC01', loadHostnameIndicators())).toBeNull();
  });

  it('falls back to empty on malformed input rather than throwing mid-sweep', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_HOSTNAME_INDICATORS = 'not json';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    process.env.ABUSE_HOSTNAME_INDICATORS = '["xy-"]';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    process.env.ABUSE_HOSTNAME_INDICATORS = JSON.stringify({ prefixes: [1, '', 'xy-'] });
    expect(loadHostnameIndicators()).toEqual({ prefixes: ['xy-'] });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  // Both shapes below leave the env var SET, so the operator's only evidence
  // that the curated tier is configured still looks right — silence here would
  // disable the one alert-capable tier with nothing to notice.
  it('warns rather than silently emptying when the key is misspelled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_HOSTNAME_INDICATORS = '{"prefix":["xy-"]}';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no "prefixes" key'));
  });

  it('warns rather than silently emptying when prefixes is a bare string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_HOSTNAME_INDICATORS = '{"prefixes":"xy-"}';
    expect(loadHostnameIndicators()).toEqual({ prefixes: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be an array'));
  });
});

describe('rmm.provider_default_hostname', () => {
  const XY = { prefixes: ['xy-'] };
  // Distinct stock Windows Server names: WIN- plus exactly 11 alphanumerics.
  const win = (i: number) => `WIN-A1B2C3D4E${String(i).padStart(2, '0')}`;
  const named = (n: number) => Array.from({ length: n }, (_, i) => `ACME-WS${String(i).padStart(2, '0')}`);

  it('alerts on a single curated-prefix device', () => {
    const s = hostSignal(agg({ deviceCount: 1, hostnames: ['XY-70001'] }), XY);
    expect(s).toBeDefined();
    expect(s!.score).toBe(SIGNAL_DEFAULTS['rmm.provider_default_hostname.curated_score']);
    expect(s!.severity).toBe('alert');
    // Examples keep the hostname exactly as stored — triage needs the real
    // string to search on, not a normalized one.
    expect(s!.evidence).toMatchObject({ tier: 'curated', matchedHostnames: 1, examples: ['XY-70001'] });
  });

  it('scores curated matches linearly so extra real devices cannot dilute it', () => {
    const one = hostSignal(agg({ deviceCount: 1, hostnames: ['XY-1'] }), XY)!;
    const three = hostSignal(
      agg({ deviceCount: 40, hostnames: ['XY-1', 'XY-2', 'XY-3', ...named(37)] }),
      XY,
    )!;
    // curated_score + (n-1) * curated_per_extra — pinned concretely, because a
    // `>` assertion passes on any ramp at all, including one that no longer
    // separates one staging box from a rack of them.
    expect(one.score).toBe(70);
    expect(three.score).toBe(90);
    expect(three.severity).toBe('alert');
  });

  it('saturates the curated ramp at 100 on a large fleet rather than overflowing', () => {
    const s = hostSignal(
      agg({ deviceCount: 60, hostnames: [...Array.from({ length: 20 }, (_, i) => `XY-${i}`), ...named(40)] }),
      XY,
    )!;
    // 70 + 19*10 = 260 before the Math.min(100, ...) clamp in push().
    expect(s.score).toBe(100);
    expect(s.severity).toBe('alert');
  });

  it('scores the generic tier on the excess above the gate, not one flat capped value', () => {
    // A (1 + ratio) multiplier would clamp both of these to generic_max_score,
    // collapsing the tier to a single score for every ratio the gate admits.
    const half = hostSignal(agg({ deviceCount: 4, hostnames: [win(1), win(2), 'ACME-DC01', 'jsmith-laptop'] }))!;
    const all = hostSignal(agg({ deviceCount: 4, hostnames: [win(1), win(2), win(3), win(4)] }))!;
    expect(half.score).toBe(SIGNAL_DEFAULTS['rmm.provider_default_hostname.generic_score']);   // ratio 0.5 → 45
    expect(all.score).toBe(SIGNAL_DEFAULTS['rmm.provider_default_hostname.generic_max_score']); // ratio 1.0 → 55
    expect(half.score).toBeLessThan(all.score);
  });

  it('caps the generic tier below the alert threshold even at ratio 1', () => {
    const s = hostSignal(agg({
      deviceCount: 12,
      hostnames: Array.from({ length: 12 }, (_, i) => win(i)),
    }))!;
    expect(s.score).toBe(55);
    expect(s.severity).toBe('watch');
    expect(s.evidence).toMatchObject({ tier: 'generic', matchedHostnames: 12, ratio: 1 });
  });

  it('fires at exactly generic_min_devices hostnames', () => {
    const n = SIGNAL_DEFAULTS['rmm.provider_default_hostname.generic_min_devices'];
    const s = hostSignal(agg({ deviceCount: n, hostnames: Array.from({ length: n }, (_, i) => win(i)) }))!;
    expect(s.score).toBe(55);
    expect(s.evidence).toMatchObject({ devicesWithHostname: n });
  });

  it('fires at exactly generic_ratio, scoring the bottom of the ramp', () => {
    const s = hostSignal(agg({ deviceCount: 4, hostnames: [win(1), win(2), 'ACME-DC01', 'ACME-FILESRV'] }))!;
    expect(s.evidence).toMatchObject({ ratio: SIGNAL_DEFAULTS['rmm.provider_default_hostname.generic_ratio'] });
    expect(s.score).toBe(45);
  });

  it('divides by the hostnames actually sampled, not the uncapped device count', () => {
    // The hosts CTE caps at 5000 rows per partner while deviceCount is an
    // uncapped COUNT(*), so a deviceCount denominator would read a bounded
    // sample as "barely any stock names" on exactly the largest fleets.
    const s = hostSignal(agg({ deviceCount: 500, hostnames: [win(1), win(2), 'ACME-DC01', 'jsmith-laptop'] }))!;
    expect(s.score).toBe(45);
    expect(s.evidence).toMatchObject({
      tier: 'generic',
      deviceCount: 500,       // kept for triage context
      devicesWithHostname: 4, // the denominator actually used
      matchedHostnames: 2,
      ratio: 0.5,
    });
  });

  it('does not fire generic on one stray stock name in a properly-named fleet', () => {
    expect(hostSignal(agg({ deviceCount: 30, hostnames: [win(1), ...named(29)] }))).toBeUndefined();
  });

  it('does not fire generic below generic_min_devices', () => {
    expect(hostSignal(agg({ deviceCount: 2, hostnames: [win(1), win(2)] }))).toBeUndefined();
  });

  it('emits one signal per partner, never both tiers for the same fleet', () => {
    const signals = compute(
      [agg({ deviceCount: 4, hostnames: ['XY-1', win(1), win(2), win(3)] })],
      SIGNAL_DEFAULTS,
      XY,
    ).filter((s) => s.signalKey === HOST_SIGNAL);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toMatchObject({ tier: 'curated' });
  });

  it('does not stack with rmm.consumer_devices off the same hostnames', () => {
    // DESKTOP-/LAPTOP- are scored by rmm.consumer_devices alone; if the
    // built-in pattern list ever grew to cover them, one fleet would stack two
    // independent-looking scores.
    const hostnames = [...Array.from({ length: 9 }, (_, i) => `DESKTOP-A1B2C${String(i).padStart(2, '0')}`), 'ACME-DC01'];
    const keys = compute([agg({ deviceCount: 10, consumerHostnameCount: 9, hostnames })]).map((s) => s.signalKey);
    expect(keys).toContain('rmm.consumer_devices');
    expect(keys).not.toContain(HOST_SIGNAL);
  });

  it('is not age-decayed — an old account running stock VMs still scores', () => {
    const old = agg({
      partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), // ~6 months → zero young weight
      deviceCount: 1,
      hostnames: ['XY-70001'],
    });
    expect(hostSignal(old, XY)!.severity).toBe('alert');
  });

  it('stays silent for a fleet with no stock names', () => {
    expect(hostSignal(agg({ deviceCount: 5, hostnames: ['ACME-RECEPTION', 'ACME-FILESRV', 'ACME-DC01', 'jsmith-laptop', 'ACME-WS07'] })))
      .toBeUndefined();
  });

  it('keeps the generic tier structurally below alert and the curated tier at it', () => {
    // The tier split is only real while these hold; both numbers are
    // independently overridable via ABUSE_SIGNAL_OVERRIDES, so pin the intent
    // the config.ts comment states rather than trusting it to stay true.
    expect(SIGNAL_DEFAULTS['rmm.provider_default_hostname.generic_max_score'])
      .toBeLessThan(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(SIGNAL_DEFAULTS['rmm.provider_default_hostname.curated_score'])
      .toBe(SIGNAL_DEFAULTS['severity.alert_score']);
  });
});
