import { describe, expect, it } from 'vitest';
import { NETWORK_ISOLATION_LIMITS, NETWORK_ISOLATION_TTL } from '../utils/networkIsolation';
import {
  CONTAINMENT_POLICY_DEFAULTS,
  containmentExtraAllowToEntries,
  containmentInlineSettingsSchema,
} from './containmentPolicy';
import { addFeatureLinkSchema } from './index';
import { isolationAllowEntrySchema } from './networkIsolation';

const entry = { host: 'relay.example.test', proto: 'tcp', ports: [443], label: 'Relay' };
const settings = (extraAllow: unknown[]) => ({ version: 1, extraAllow });

describe('containmentInlineSettingsSchema', () => {
  it('uses the W1 fixed defaults with an explicit version', () => {
    expect(containmentInlineSettingsSchema.parse({ version: 1 })).toEqual({
      version: 1,
      extraAllow: [],
      defaultTtlHours: NETWORK_ISOLATION_TTL.defaultHours,
      deadManMinutes: 0,
      remoteRelay: true,
      requireSignedReleaseToken: false,
    });
    expect(CONTAINMENT_POLICY_DEFAULTS).toEqual(containmentInlineSettingsSchema.parse({ version: 1 }));
  });

  it('freezes the default settings and empty allowlist so callers cannot grant permits by mutation', () => {
    expect(Object.isFrozen(CONTAINMENT_POLICY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(CONTAINMENT_POLICY_DEFAULTS.extraAllow)).toBe(true);
  });

  it.each([undefined, 0, 2, '1', null])('requires version 1, refusing %s', (version) => {
    expect(containmentInlineSettingsSchema.safeParse({ version }).success).toBe(false);
  });

  // Denied-address literals are necessary to pin the security reject list; accepted fixtures below
  // use only documentation addresses and reserved example.test names.
  it.each([
    ['IPv4 default route', { cidr: '0.0.0.0/0' }],
    ['IPv6 default route', { cidr: '::/0' }],
    ['IPv4 prefix shorter than /8', { cidr: '192.0.2.0/7' }],
    ['IPv6 prefix shorter than /32', { cidr: '2001:db8::/31' }],
    ['IPv4 loopback range', { cidr: '127.0.0.0/8' }],
    ['IPv4 loopback address', { cidr: '127.0.0.1/32' }],
    ['IPv6 loopback', { cidr: '::1/128' }],
    ['expanded IPv6 loopback', { cidr: '0:0:0:0:0:0:0:1/128' }],
    ['IPv6 range containing loopback', { cidr: '::/32' }],
    ['IPv4-mapped IPv6 loopback', { cidr: '::ffff:127.0.0.1/128' }],
    ['hexadecimal IPv4-mapped IPv6 loopback', { cidr: '::ffff:7f00:1/128' }],
    ['malformed IPv6', { cidr: '1:2:3:4:5:6:7:8:9::/128' }],
    ['localhost', { host: 'localhost' }],
    ['localhost subdomain', { host: 'relay.localhost' }],
    ['mixed-case localhost', { host: 'Relay.LocalHost' }],
    ['wildcard subdomain', { host: '*.example.test' }],
    ['embedded wildcard', { host: 'rel*y.example.test' }],
    ['IPv4 literal hostname', { host: '192.0.2.1' }],
    ['IPv6 literal hostname', { host: '2001:db8::1' }],
    ['IPv4-mapped /96 covering mapped loopback', { cidr: '::ffff:0:0/96' }],
    ['IPv4-mapped loopback /104 (hex)', { cidr: '::ffff:7f00:0/104' }],
    ['IPv4-mapped loopback /104 (dotted)', { cidr: '::ffff:127.0.0.1/104' }],
    ['upper-case IPv4-mapped loopback', { cidr: '::FFFF:7F00:1/128' }],
    ['IPv4 unspecified address', { cidr: '0.0.0.0/32' }],
    ['IPv4 this-network range', { cidr: '0.0.0.0/8' }],
    ['IPv6 unspecified address', { cidr: '::/128' }],
    ['IPv4-mapped unspecified', { cidr: '::ffff:0.0.0.0/128' }],
    ['IPv4-compatible loopback (dotted)', { cidr: '::127.0.0.1/128' }],
    ['IPv4-compatible loopback (hex)', { cidr: '::7f00:1/128' }],
    ['NAT64 loopback', { cidr: '64:ff9b::7f00:1/128' }],
    ['hex-address hostname', { host: '0x7f000001' }],
    ['hex-label hostname', { host: '0x7f.0x1' }],
    ['localhost.localdomain', { host: 'localhost.localdomain' }],
    ['ip6-localhost', { host: 'ip6-localhost' }],
    ['ip6-loopback', { host: 'ip6-loopback' }],
  ])('rejects %s', (_name, target) => {
    expect(containmentInlineSettingsSchema.safeParse(settings([
      { ...target, proto: 'tcp', ports: [443], label: 'Denied' },
    ])).success).toBe(false);
  });

  it.each([
    { host: 'relay.example.test' },
    { host: 'updates.example.test' },
    { cidr: '192.0.2.0/24' },
    { cidr: '198.51.100.0/24' },
    { cidr: '203.0.113.0/24' },
    { cidr: '2001:db8::/32' },
    // Controls: adjacent to a blocked range, must not be over-rejected.
    { cidr: '::ffff:126.0.0.0/104' },
    { cidr: '::ffff:c000:200/120' },
    { cidr: '64:ff9b::c000:200/120' },
    { host: 'box0x.example.test' },
  ])('accepts documentation destinations %j', (target) => {
    expect(containmentInlineSettingsSchema.safeParse(settings([
      { ...target, proto: 'udp+tcp', ports: [53, 443], label: 'Allowed' },
    ])).success).toBe(true);
  });

  it.each([
    { proto: 'tcp', ports: [443], label: 'Neither' },
    { ...entry, cidr: '192.0.2.0/24' },
  ])('requires exactly one destination: %j', (invalid) => {
    expect(containmentInlineSettingsSchema.safeParse(settings([invalid])).success).toBe(false);
  });

  it.each([[], [0], [65536], [1.5], [443, 443], Array.from({ length: 17 }, (_, i) => i + 1)].map((ports) => ({ ports })))(
    'uses the wire contract port rules: %j', ({ ports }) => {
      expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, ports }])).success).toBe(false);
    },
  );

  it.each(['tcp', 'udp', 'udp+tcp'])('accepts protocol %s and port boundaries', (proto) => {
    expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, proto, ports: [1, 65535] }])).success).toBe(true);
  });

  it('rejects unsupported protocols', () => {
    expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, proto: 'icmp' }])).success).toBe(false);
  });

  it.each(['a\u0000b', 'tab\there', 'bell\u0007', 'del\u007f'])('refuses a label with control characters %j', (label) => {
    expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, label }])).success).toBe(false);
  });

  it('trims labels and bounds them to 1..100 characters', () => {
    expect(containmentInlineSettingsSchema.parse(settings([{ ...entry, label: '  Relay  ' }])).extraAllow[0]?.label).toBe('Relay');
    expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, label: 'x'.repeat(100) }])).success).toBe(true);
    for (const label of ['', '  ', 'x'.repeat(101)]) {
      expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, label }])).success).toBe(false);
    }
  });

  it('reserves half the wire entry budget for server-built permits', () => {
    const cap = 32;
    expect(cap).toBeLessThan(NETWORK_ISOLATION_LIMITS.maxAllowEntries);
    expect(containmentInlineSettingsSchema.safeParse(settings(Array(cap).fill(entry))).success).toBe(true);
    expect(containmentInlineSettingsSchema.safeParse(settings(Array(cap + 1).fill(entry))).success).toBe(false);
  });

  it.each(Array.from({ length: 14 }, (_, i) => i + 1))('refuses deadManMinutes %i', (deadManMinutes) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, deadManMinutes }).success).toBe(false);
  });
  it.each([0, 15, 1440])('accepts deadManMinutes %i', (deadManMinutes) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, deadManMinutes }).success).toBe(true);
  });
  it.each([-1, 15.5, 1441])('refuses out-of-range deadManMinutes %s', (deadManMinutes) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, deadManMinutes }).success).toBe(false);
  });
  it.each([1, 720])('accepts defaultTtlHours %i', (defaultTtlHours) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, defaultTtlHours }).success).toBe(true);
  });
  it.each([0, 721, 1.5])('rejects defaultTtlHours %s', (defaultTtlHours) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, defaultTtlHours }).success).toBe(false);
  });
  it.each(['remoteRelay', 'requireSignedReleaseToken'])('requires boolean %s', (key) => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, [key]: 'true' }).success).toBe(false);
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, [key]: false }).success).toBe(true);
  });
  it('rejects unknown keys at both levels', () => {
    expect(containmentInlineSettingsSchema.safeParse({ version: 1, unknown: true }).success).toBe(false);
    expect(containmentInlineSettingsSchema.safeParse(settings([{ ...entry, scope: 'breeze' }])).success).toBe(false);
  });

  it('registers containment as a configuration-policy feature', () => {
    expect(addFeatureLinkSchema.safeParse({ featureType: 'containment', inlineSettings: { version: 1 } }).success).toBe(true);
  });
});

describe('containmentExtraAllowToEntries', () => {
  it('maps hosts and CIDRs to valid any-process permits, dropping labels without mutating inputs', () => {
    const { extraAllow } = containmentInlineSettingsSchema.parse(settings([
      entry,
      { cidr: '192.0.2.0/24', proto: 'udp', ports: [53], label: 'Resolver' },
      { cidr: '2001:db8::/32', proto: 'udp+tcp', ports: [443], label: 'IPv6 relay' },
    ]));
    const before = structuredClone(extraAllow);
    const mapped = containmentExtraAllowToEntries(extraAllow);
    expect(mapped).toEqual([
      { kind: 'host', host: 'relay.example.test', proto: 'tcp', ports: [443], scope: 'any' },
      { kind: 'cidr', cidr: '192.0.2.0/24', proto: 'udp', ports: [53], scope: 'any' },
      { kind: 'cidr', cidr: '2001:db8::/32', proto: 'udp+tcp', ports: [443], scope: 'any' },
    ]);
    for (const permit of mapped) expect(isolationAllowEntrySchema.safeParse(permit).success).toBe(true);
    expect(extraAllow).toEqual(before);
    expect(containmentExtraAllowToEntries([])).toEqual([]);
  });
});
