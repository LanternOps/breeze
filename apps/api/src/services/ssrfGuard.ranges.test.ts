// Table-driven contract for the shared non-routable-address table.
//
// Every range the guards claim to cover is pinned here, for all three
// `ssrfGuard` modes, so a later edit to either `ssrfGuard.ts` or the shared
// classifiers in `urlSafety.ts` cannot narrow the table or let the two drift
// apart again. Drift was the defect being fixed: `checkSsrfSafe` carried its own
// hand-rolled string-prefix matchers while `urlSafety` carried a separate, more
// complete range table, so a URL could be accepted at config-save time and then
// refused at connect time — or accepted by both, when the spelling used
// (IPv4-mapped hex-pair, `inet_aton` decimal) matched neither prefix list.
//
// Note on layering: `new URL()` canonicalises a URL hostname itself, so a row
// driven through `isSsrfSafe` reaches the guard already normalised and does not,
// on its own, exercise `canonicalizeIpv4Literal` or the IPv6 group parse. That is
// why every row is ALSO asserted directly against the classifiers with its raw
// text (`bare`), and why `canonicalizeIpv4Literal` / `parseV6` have their own
// accept/reject tables below: the classifiers are exported and called with
// addresses that never passed through `URL` (`resolveSafeRecords`, DNS answers,
// the webhook and log-forwarding validators).
import { describe, expect, it, afterEach } from 'vitest';
import { checkSsrfSafe, isSsrfSafe, type SsrfMode } from './ssrfGuard';
import {
  canonicalizeIpv4Literal,
  classifyBlockedIp,
  isAlwaysBlockedIp,
  isBlockedForEgress,
  isCarrierNatAddress,
  isIpLiteralHost,
  isPrivateIp,
  isRfc1918OrUla,
  resolveSafeRecords,
  SsrfBlockedError,
  __setLookupForTests,
} from './urlSafety';
// The hostname classifier is not part of urlSafety's surface — it lives with the
// rest of the shared table.
import { classifyNonRoutableHostname } from './ipRanges';

const ALL_MODES: SsrfMode[] = ['strict-https', 'on-prem-http', 'on-prem-strict'];

/** URL host portion — IPv6 literals must arrive bracketed, as a real URL would. */
function urlFor(host: string, mode: SsrfMode): string {
  const scheme = mode === 'strict-https' ? 'https' : 'http';
  return `${scheme}://${host}/some/path`;
}

interface Row {
  label: string;
  /** Host as it appears in a URL (IPv6 bracketed). */
  host: string;
  /** Modes in which this host must be ACCEPTED. Everything else must be rejected. */
  allowedIn?: SsrfMode[];
  /** Expected `isPrivateIp` verdict for the bare (unbracketed) literal. */
  bare?: string;
  /** True when the address counts as a plain RFC1918/ULA appliance address. */
  rfc1918OrUla?: boolean;
}

// Every row is blocked in every mode unless `allowedIn` says otherwise.
// RFC1918 / ULA are the ONLY ranges an on-prem appliance integration may reach,
// and only in 'on-prem-http'.
const ONPREM: SsrfMode[] = ['on-prem-http'];

const BLOCKED_ROWS: Row[] = [
  // ---- IPv4 private (RFC1918) -------------------------------------------
  { label: '10.0.0.0/8', host: '10.0.0.5', allowedIn: ONPREM, rfc1918OrUla: true },
  { label: '172.16.0.0/12 low edge', host: '172.16.0.1', allowedIn: ONPREM, rfc1918OrUla: true },
  { label: '172.16.0.0/12 high edge', host: '172.31.255.254', allowedIn: ONPREM, rfc1918OrUla: true },
  { label: '192.168.0.0/16', host: '192.168.1.50', allowedIn: ONPREM, rfc1918OrUla: true },

  // ---- IPv4 loopback ----------------------------------------------------
  { label: '127.0.0.0/8', host: '127.0.0.1' },
  { label: '127.0.0.0/8 non-.1', host: '127.99.12.3' },

  // ---- IPv4 link-local + cloud metadata --------------------------------
  { label: '169.254.0.0/16', host: '169.254.1.1' },
  { label: 'AWS/OpenStack metadata 169.254.169.254', host: '169.254.169.254' },
  { label: 'ECS task metadata 169.254.170.2', host: '169.254.170.2' },

  // ---- IPv4 "this network" ---------------------------------------------
  { label: '0.0.0.0/8 unspecified', host: '0.0.0.0' },
  // The whole /8 is unroutable, not just the all-zeroes address: on Linux
  // 0.x.y.z is treated as the local host, which the previous
  // `addr === '0.0.0.0'` equality check let through.
  { label: '0.0.0.0/8 non-zero host part', host: '0.1.2.3' },

  // ---- IPv4 CGNAT ------------------------------------------------------
  { label: '100.64.0.0/10 low edge', host: '100.64.0.5' },
  { label: '100.64.0.0/10 high edge', host: '100.127.255.254' },

  // ---- IPv6 ------------------------------------------------------------
  { label: 'IPv6 loopback ::1', host: '[::1]', bare: '::1' },
  { label: 'IPv6 unspecified ::', host: '[::]', bare: '::' },
  { label: 'IPv6 ULA fc00::/7 (fc)', host: '[fc00::1]', bare: 'fc00::1', allowedIn: ONPREM, rfc1918OrUla: true },
  { label: 'IPv6 ULA fc00::/7 (fd)', host: '[fd12:3456:789a::1]', bare: 'fd12:3456:789a::1', allowedIn: ONPREM, rfc1918OrUla: true },
  { label: 'IPv6 link-local fe80::/10 low', host: '[fe80::1]', bare: 'fe80::1' },
  { label: 'IPv6 link-local fe80::/10 high', host: '[febf::1]', bare: 'febf::1' },
  { label: 'IPv6 multicast ff00::/8', host: '[ff02::1]', bare: 'ff02::1' },

  // ---- IPv6 alternative spellings of the same addresses -----------------
  // Classification runs on the parsed groups, so an uncompressed or zero-padded
  // spelling must reach the same verdict as the canonical one.
  { label: 'uncompressed ::1', host: '[0:0:0:0:0:0:0:1]', bare: '0:0:0:0:0:0:0:1' },
  {
    label: 'zero-padded ::1',
    host: '[0000:0000:0000:0000:0000:0000:0000:0001]',
    bare: '0000:0000:0000:0000:0000:0000:0000:0001',
  },
  { label: 'uncompressed ::', host: '[0:0:0:0:0:0:0:0]', bare: '0:0:0:0:0:0:0:0' },
  {
    label: 'zero-padded fe80::1',
    host: '[fe80:0000:0000:0000:0000:0000:0000:0001]',
    bare: 'fe80:0000:0000:0000:0000:0000:0000:0001',
  },
  {
    label: 'uncompressed mapped metadata',
    host: '[0:0:0:0:0:ffff:169.254.169.254]',
    bare: '0:0:0:0:0:ffff:169.254.169.254',
  },
  {
    label: 'uncompressed mapped loopback hex-pair',
    host: '[0:0:0:0:0:ffff:7f00:1]',
    bare: '0:0:0:0:0:ffff:7f00:1',
  },
  {
    label: 'uncompressed mapped RFC1918',
    host: '[0:0:0:0:0:ffff:10.0.0.5]',
    bare: '0:0:0:0:0:ffff:10.0.0.5',
    allowedIn: ONPREM,
    rfc1918OrUla: true,
  },
  { label: 'fd00::/8 ULA zero-padded', host: '[fd00:0000::0001]', bare: 'fd00:0000::0001', allowedIn: ONPREM, rfc1918OrUla: true },

  // ---- IPv6 prefixes that carry an IPv4 destination ---------------------
  // Each of these reaches an IPv4 address on a host with the matching
  // transition mechanism, so the IPv4 destination is what must be classified.
  // None of them is a plain appliance address, so none counts as RFC1918 —
  // an embedded private address stays blocked even with the on-prem opt-in.
  {
    label: 'NAT64 well-known prefix embedding loopback',
    host: '[64:ff9b::7f00:1]',
    bare: '64:ff9b::7f00:1',
  },
  {
    label: 'NAT64 well-known prefix embedding metadata',
    host: '[64:ff9b::a9fe:a9fe]',
    bare: '64:ff9b::a9fe:a9fe',
  },
  {
    label: 'NAT64 well-known prefix embedding RFC1918',
    host: '[64:ff9b::10.0.0.5]',
    bare: '64:ff9b::10.0.0.5',
  },
  { label: '6to4 embedding loopback', host: '[2002:7f00:1::]', bare: '2002:7f00:1::' },
  { label: '6to4 embedding metadata', host: '[2002:a9fe:a9fe::]', bare: '2002:a9fe:a9fe::' },
  { label: '6to4 embedding RFC1918', host: '[2002:a00:5::]', bare: '2002:a00:5::' },
  {
    label: 'IPv4-translated ::ffff:0:a.b.c.d embedding loopback',
    host: '[::ffff:0:127.0.0.1]',
    bare: '::ffff:0:127.0.0.1',
  },
  {
    label: 'IPv4-compatible ::a.b.c.d embedding loopback',
    host: '[::127.0.0.1]',
    bare: '::127.0.0.1',
  },

  // ---- IPv4-mapped IPv6, dotted form -----------------------------------
  { label: 'mapped loopback ::ffff:127.0.0.1', host: '[::ffff:127.0.0.1]', bare: '::ffff:127.0.0.1' },
  {
    label: 'mapped metadata ::ffff:169.254.169.254',
    host: '[::ffff:169.254.169.254]',
    bare: '::ffff:169.254.169.254',
  },
  {
    label: 'mapped RFC1918 ::ffff:10.0.0.5',
    host: '[::ffff:10.0.0.5]',
    bare: '::ffff:10.0.0.5',
    allowedIn: ONPREM,
    rfc1918OrUla: true,
  },
  { label: 'mapped CGNAT ::ffff:100.64.0.5', host: '[::ffff:100.64.0.5]', bare: '::ffff:100.64.0.5' },

  // ---- IPv4-mapped IPv6, hex-pair form (easy to miss) -----------------
  // ::ffff:a9fe:a9fe decodes to 169.254.169.254 but still contains a ':' after
  // the prefix, so a branch that asks only "does it look like IPv6" never
  // reaches the IPv4 table.
  { label: 'mapped metadata hex-pair ::ffff:a9fe:a9fe', host: '[::ffff:a9fe:a9fe]', bare: '::ffff:a9fe:a9fe' },
  { label: 'mapped loopback hex-pair ::ffff:7f00:1', host: '[::ffff:7f00:1]', bare: '::ffff:7f00:1' },
  {
    label: 'mapped RFC1918 hex-pair ::ffff:0a00:5',
    host: '[::ffff:0a00:5]',
    bare: '::ffff:0a00:5',
    allowedIn: ONPREM,
    rfc1918OrUla: true,
  },
  {
    // The spelling `new URL()` produces for a mapped RFC1918 address: the
    // leading zero of the group is stripped, so `0a00` becomes `a00`.
    label: 'mapped RFC1918 hex-pair, URL-canonical ::ffff:a00:5',
    host: '[::ffff:a00:5]',
    bare: '::ffff:a00:5',
    allowedIn: ONPREM,
    rfc1918OrUla: true,
  },

  // ---- Non-dotted-quad IPv4 literal forms (inet_aton) ------------------
  // getaddrinfo() accepts all of these spellings and they name 127.0.0.1 /
  // 169.254.169.254. Neither range table recognised them before this change.
  { label: 'decimal 2130706433 (=127.0.0.1)', host: '2130706433' },
  { label: 'decimal 2852039166 (=169.254.169.254)', host: '2852039166' },
  { label: 'octal 0177.0.0.1 (=127.0.0.1)', host: '0177.0.0.1' },
  { label: 'hex 0x7f.0.0.1 (=127.0.0.1)', host: '0x7f.0.0.1' },
  { label: 'two-part 127.1 (=127.0.0.1)', host: '127.1' },
  { label: 'three-part 169.254.43518 (=169.254.169.254)', host: '169.254.43518' },
  { label: 'octal two-part 0177.1 (=127.0.0.1)', host: '0177.1' },

  // ---- Documentation / benchmarking / multicast / reserved -------------
  { label: '192.0.0.0/24 IETF protocol assignments', host: '192.0.0.1' },
  { label: '192.0.2.0/24 TEST-NET-1', host: '192.0.2.5' },
  { label: '198.18.0.0/15 benchmarking', host: '198.19.0.1' },
  { label: '198.51.100.0/24 TEST-NET-2', host: '198.51.100.7' },
  { label: '203.0.113.0/24 TEST-NET-3', host: '203.0.113.7' },
  { label: '224.0.0.0/4 multicast', host: '224.0.0.1' },
  { label: '240.0.0.0/4 reserved', host: '240.0.0.1' },
];

// Public addresses / hostnames that must stay reachable in every mode, so the
// table above cannot be satisfied by a guard that simply blocks everything.
const ALLOWED_ROWS: Array<{ label: string; host: string; hostname?: boolean }> = [
  { label: 'public hostname', host: 'api.example.com', hostname: true },
  { label: 'public IPv4', host: '93.184.216.34' },
  { label: 'public IPv6', host: '[2606:2800:220:1:248:1893:25c8:1946]' },
  { label: '172.15.0.1 just below RFC1918', host: '172.15.0.1' },
  { label: '172.32.0.1 just above RFC1918', host: '172.32.0.1' },
  { label: '100.63.255.254 just below CGNAT', host: '100.63.255.254' },
  { label: '100.128.0.1 just above CGNAT', host: '100.128.0.1' },
  { label: '1.0.0.1 leading octet 1, not 0', host: '1.0.0.1' },
  { label: 'hostname that merely starts with fd', host: 'fd-cdn.example.com', hostname: true },
  { label: 'public IPv6 uncompressed', host: '[2606:2800:0220:0001:0248:1893:25c8:1946]' },
  { label: 'fec0:: (site-local, outside fe80::/10)', host: '[fec0::1]' },
  { label: 'fb00:: (outside fc00::/7)', host: '[fb00::1]' },
  { label: '6to4 embedding a public IPv4', host: '[2002:5db8:d822::]' },
  { label: 'NAT64 prefix embedding a public IPv4', host: '[64:ff9b::5db8:d822]' },
  // One adjacent-public address per remaining range, so widening any single
  // octet test in the table fails here. Without these, broadening (say)
  // 192.0.0.0/24 to all of 192.0.x.x, or 198.18.0.0/15 to 198.16.0.0/12,
  // would pass every other row in this file.
  { label: '126.255.255.255 just below loopback', host: '126.255.255.255' },
  { label: '128.0.0.1 just above loopback', host: '128.0.0.1' },
  { label: '1.0.0.0 just above 0.0.0.0/8', host: '1.0.0.0' },
  { label: '169.253.255.255 just below link-local', host: '169.253.255.255' },
  { label: '169.255.0.1 just above link-local', host: '169.255.0.1' },
  { label: '192.0.1.1 just above 192.0.0.0/24', host: '192.0.1.1' },
  { label: '192.0.3.1 just above 192.0.2.0/24', host: '192.0.3.1' },
  { label: '198.17.255.255 just below 198.18.0.0/15', host: '198.17.255.255' },
  { label: '198.20.0.1 just above 198.18.0.0/15', host: '198.20.0.1' },
  { label: '198.51.99.1 just below 198.51.100.0/24', host: '198.51.99.1' },
  { label: '198.51.101.1 just above 198.51.100.0/24', host: '198.51.101.1' },
  { label: '203.0.112.1 just below 203.0.113.0/24', host: '203.0.112.1' },
  { label: '203.0.114.1 just above 203.0.113.0/24', host: '203.0.114.1' },
  { label: '223.255.255.255 just below multicast', host: '223.255.255.255' },
];

describe('ssrfGuard blocklist ranges', () => {
  for (const row of BLOCKED_ROWS) {
    const allowed = new Set<SsrfMode>(row.allowedIn ?? []);
    for (const mode of ALL_MODES) {
      const shouldPass = allowed.has(mode);
      it(`${mode}: ${shouldPass ? 'accepts' : 'rejects'} ${row.label} (${row.host})`, () => {
        expect(isSsrfSafe(urlFor(row.host, mode), { mode })).toBe(shouldPass);
      });
    }
  }

  for (const row of ALLOWED_ROWS) {
    for (const mode of ALL_MODES) {
      it(`${mode}: accepts ${row.label} (${row.host})`, () => {
        expect(isSsrfSafe(urlFor(row.host, mode), { mode })).toBe(true);
      });
    }
  }
});

describe('urlSafety classifiers agree with ssrfGuard (one guard)', () => {
  for (const row of BLOCKED_ROWS) {
    const bare = row.bare ?? row.host;
    it(`isPrivateIp blocks ${row.label}`, () => {
      expect(isPrivateIp(bare)).toBe(true);
    });

    it(`isRfc1918OrUla(${row.label}) === ${row.rfc1918OrUla === true}`, () => {
      expect(isRfc1918OrUla(bare)).toBe(row.rfc1918OrUla === true);
    });

    it(`isAlwaysBlockedIp(${row.label}) === ${row.rfc1918OrUla !== true}`, () => {
      // Anything that is NOT a plain RFC1918/ULA appliance address must stay
      // blocked even for integrations that opt into private networking.
      expect(isAlwaysBlockedIp(bare)).toBe(row.rfc1918OrUla !== true);
    });
  }

  for (const row of ALLOWED_ROWS) {
    if (row.hostname) continue; // DNS names, not IP literals — classified only after resolution
    const bare = row.host.replace(/^\[|\]$/g, '');
    it(`isPrivateIp allows ${row.label}`, () => {
      expect(isPrivateIp(bare)).toBe(false);
    });
    it(`isAlwaysBlockedIp allows ${row.label}`, () => {
      expect(isAlwaysBlockedIp(bare)).toBe(false);
    });
  }
});

describe('canonicalizeIpv4Literal follows inet_aton, not "looks numeric"', () => {
  it.each([
    ['2130706433', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['0177.1', '127.0.0.1'],
    ['0x7f.0.0.1', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['169.254.43518', '169.254.169.254'],
    ['010.010.010.010', '8.8.8.8'],
    ['1', '0.0.0.1'],
  ])('canonicalises %s to %s', (input, expected) => {
    expect(canonicalizeIpv4Literal(input)).toBe(expected);
  });

  it.each([
    // An out-of-base octal digit makes inet_aton reject the whole address, so
    // this is a DNS hostname — classifying it as 9.0.0.1 would skip resolution.
    '09.0.0.1',
    '08',
    // Out of range / malformed — the resolver treats each as a hostname.
    '4294967296',
    '0x100.0.0.1',
    // A part other than the last must fit in one byte.
    '300.1.2',
    '1.300.2.3',
    // The last part fills the remaining bytes and must fit in them.
    '1.2.3.256',
    '256.256',
    '1.2.65536',
    '1.2.3.4.5',
    '127.0.0.256',
    '172.16.0.1.',
    '1e3',
    '-1',
    'example.com',
    'fd-cdn.example.com',
    '',
    '::1',
  ])('does not treat %s as an IPv4 literal', (input) => {
    expect(canonicalizeIpv4Literal(input)).toBeNull();
    expect(isIpLiteralHost(input)).toBe(input.includes(':'));
  });
});

describe('parseV6 rejects malformed IPv6 rather than guessing', () => {
  it.each(['1::2::3', '1:2:3:4:5:6:7:8:9', 'gggg::1', '::ffff:1.2.3.4.5', '1:2:3:4:5:6:7'])(
    'classifies %s as unknown (null), not blocked and not allowed by accident',
    (input) => {
      expect(classifyBlockedIp(input)).toBeNull();
    }
  );

  it('honours a zone id', () => {
    expect(classifyBlockedIp('fe80::1%eth0')).toBe('link-local');
  });
});

describe('embedded-IPv4 IPv6 prefixes are never plain appliance addresses', () => {
  // A mapped address IS an ordinary IPv4 host reached over IPv6, so embedded
  // RFC1918 counts as RFC1918 there. The transition prefixes are not, so an
  // embedded private address must stay blocked even under the private opt-in.
  const transitionPrivate = ['64:ff9b::10.0.0.5', '2002:a00:5::', '::ffff:0:10.0.0.5', '::10.0.0.5'];
  for (const ip of transitionPrivate) {
    it(`isRfc1918OrUla(${ip}) is false`, () => {
      expect(isRfc1918OrUla(ip)).toBe(false);
    });
    it(`isAlwaysBlockedIp(${ip}) is true`, () => {
      expect(isAlwaysBlockedIp(ip)).toBe(true);
    });
  }

  it('the mapped form, by contrast, IS a plain RFC1918 appliance address', () => {
    expect(isRfc1918OrUla('::ffff:10.0.0.5')).toBe(true);
    expect(isAlwaysBlockedIp('::ffff:10.0.0.5')).toBe(false);
  });
});

describe('non-routable hostnames, per mode', () => {
  // Loopback aliases and instance-metadata names are refused in every mode. The
  // local-network naming suffixes are refused only for a cloud-only vendor
  // endpoint ('strict-https'); the on-prem modes exist to reach appliances that
  // may legitimately carry one.
  const ALWAYS_REFUSED = [
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'db.localhost',
    'metadata.google.internal',
    'metadata.azure.com',
    '100.100.100.200',
  ];

  for (const host of ALWAYS_REFUSED) {
    for (const mode of ALL_MODES) {
      it(`${mode}: rejects ${host}`, () => {
        expect(isSsrfSafe(urlFor(host, mode), { mode })).toBe(false);
      });
    }
  }

  // `.local` / `.internal` names are NOT refused by this guard, in any mode: a
  // self-hosted PSA or appliance legitimately lives on such a domain, the guard
  // never rejected them, and the connect-time policy classifies whatever they
  // resolve to. (`webhookSender` keeps its own `.local` rejection for webhook
  // targets — that is a webhook-specific rule, exercised in its own suite.)
  const LOCAL_NETWORK_NAMES = ['nas.local', 'pihole.local', 'es.corp.internal', 'jira.acme.internal'];

  for (const host of LOCAL_NETWORK_NAMES) {
    for (const mode of ALL_MODES) {
      it(`${mode}: accepts ${host}`, () => {
        expect(isSsrfSafe(urlFor(host, mode), { mode })).toBe(true);
      });
    }
  }

  it('classifies each hostname kind', () => {
    expect(classifyNonRoutableHostname('localhost')).toBe('loopback');
    expect(classifyNonRoutableHostname('db.localhost')).toBe('loopback');
    expect(classifyNonRoutableHostname('ip6-loopback')).toBe('loopback');
    expect(classifyNonRoutableHostname('metadata.google.internal')).toBe('metadata');
    expect(classifyNonRoutableHostname('metadata.azure.com')).toBe('metadata');
    expect(classifyNonRoutableHostname('100.100.100.200')).toBe('metadata');
    expect(classifyNonRoutableHostname('nas.local')).toBe('mdns-local');
    expect(classifyNonRoutableHostname('es.corp.internal')).toBe('internal-tld');
    expect(classifyNonRoutableHostname('api.example.com')).toBeNull();
    // `.localhost` is a suffix rule, not a substring one.
    expect(classifyNonRoutableHostname('localhost.example.com')).toBeNull();
    expect(classifyNonRoutableHostname('notlocal.example.com')).toBeNull();
  });

  it('a metadata name is refused ahead of the more generic suffix rules', () => {
    // `metadata.google.internal` ends with `.internal`, but the specific reason
    // is the useful one and it must be refused in every mode, not just strict.
    expect(classifyNonRoutableHostname('metadata.google.internal')).toBe('metadata');
    expect(checkSsrfSafe('http://metadata.google.internal/', { mode: 'on-prem-http' })).toEqual({
      ok: false,
      reason: 'hostname metadata.google.internal is an instance-metadata endpoint',
    });
  });
});

describe('CGNAT is refused in every mode, including on-prem', () => {
  // Behaviour change, and a deliberate one: the config-time guard used to run its
  // private-range check only in the strict modes, so an 'on-prem-http' endpoint on
  // 100.64/10 was accepted at save time — and then refused at request time, since
  // `isAlwaysBlockedIp` (what `safeFetch` applies under `allowPrivateNetwork`) has
  // always blocked CGNAT. Accepting it was the drift; the two now agree and the
  // user gets an actionable error at save time instead of a failing sync.
  it('is blocked by the connect-time policy under the private-network opt-in', () => {
    expect(isAlwaysBlockedIp('100.64.0.5')).toBe(true);
  });

  for (const mode of ALL_MODES) {
    it(`${mode}: rejects 100.64.0.5`, () => {
      expect(isSsrfSafe(urlFor('100.64.0.5', mode), { mode })).toBe(false);
    });
  }
});

describe('carrier-NAT opt-in (100.64.0.0/10, e.g. Tailscale)', () => {
  const CGNAT = '100.100.5.6';
  const CGNAT_MAPPED = '::ffff:100.100.5.6';
  const CGNAT_TRANSITION = '64:ff9b::6464:506'; // 100.100.5.6 embedded in NAT64

  it('isCarrierNatAddress: true for a plain CGNAT literal and its mapped form only', () => {
    expect(isCarrierNatAddress(CGNAT)).toBe(true);
    expect(isCarrierNatAddress('100.64.0.0')).toBe(true);
    expect(isCarrierNatAddress('100.127.255.255')).toBe(true);
    expect(isCarrierNatAddress(CGNAT_MAPPED)).toBe(true);
    // Just outside 100.64/10 — never CGNAT.
    expect(isCarrierNatAddress('100.63.255.255')).toBe(false);
    expect(isCarrierNatAddress('100.128.0.0')).toBe(false);
    // RFC1918 / public / loopback are not CGNAT.
    expect(isCarrierNatAddress('10.0.0.5')).toBe(false);
    expect(isCarrierNatAddress('93.184.216.34')).toBe(false);
    // A transition prefix that merely embeds a CGNAT destination does NOT count.
    expect(isCarrierNatAddress(CGNAT_TRANSITION)).toBe(false);
  });

  it('isBlockedForEgress: CGNAT stays blocked by default and with private-network alone', () => {
    expect(isBlockedForEgress(CGNAT)).toBe(true);
    expect(isBlockedForEgress(CGNAT, {})).toBe(true);
    expect(isBlockedForEgress(CGNAT, { allowPrivateNetwork: true })).toBe(true);
  });

  it('isBlockedForEgress: the carrier-NAT opt-in is INERT without the private-network opt-in', () => {
    // This is the hosted-safety guarantee: allowPrivateNetwork is self-host-only,
    // so allowCarrierNat cannot widen egress on the hosted platform.
    expect(isBlockedForEgress(CGNAT, { allowCarrierNat: true })).toBe(true);
    expect(isBlockedForEgress(CGNAT_MAPPED, { allowCarrierNat: true })).toBe(true);
  });

  it('isBlockedForEgress: CGNAT is reachable only with BOTH opt-ins', () => {
    const both = { allowPrivateNetwork: true, allowCarrierNat: true };
    expect(isBlockedForEgress(CGNAT, both)).toBe(false);
    expect(isBlockedForEgress(CGNAT_MAPPED, both)).toBe(false);
    // The opt-in is scoped to CGNAT: it does not unblock anything else.
    expect(isBlockedForEgress('127.0.0.1', both)).toBe(true);
    expect(isBlockedForEgress('169.254.169.254', both)).toBe(true);
    expect(isBlockedForEgress('::1', both)).toBe(true);
    // A transition prefix embedding CGNAT is NOT a plain overlay address.
    expect(isBlockedForEgress(CGNAT_TRANSITION, both)).toBe(true);
    // RFC1918/ULA remain reachable (private opt-in), public always reachable.
    expect(isBlockedForEgress('10.0.0.5', both)).toBe(false);
    expect(isBlockedForEgress('93.184.216.34', both)).toBe(false);
  });

  describe('checkSsrfSafe honours the opt-in only in on-prem-http mode', () => {
    it('rejects a CGNAT literal by default in every mode', () => {
      for (const mode of ALL_MODES) {
        expect(isSsrfSafe(urlFor(CGNAT, mode), { mode })).toBe(false);
      }
    });

    it('accepts a CGNAT literal in on-prem-http with allowCarrierNat', () => {
      expect(isSsrfSafe(urlFor(CGNAT, 'on-prem-http'), { mode: 'on-prem-http', allowCarrierNat: true })).toBe(true);
    });

    it('still rejects CGNAT with allowCarrierNat in the strict modes', () => {
      expect(isSsrfSafe(urlFor(CGNAT, 'strict-https'), { mode: 'strict-https', allowCarrierNat: true })).toBe(false);
      expect(isSsrfSafe(urlFor(CGNAT, 'on-prem-strict'), { mode: 'on-prem-strict', allowCarrierNat: true })).toBe(false);
    });

    it('the opt-in does not widen anything but CGNAT', () => {
      const opts = { mode: 'on-prem-http' as const, allowCarrierNat: true };
      expect(isSsrfSafe(urlFor('169.254.169.254', 'on-prem-http'), opts)).toBe(false);
      expect(isSsrfSafe(urlFor('127.0.0.1', 'on-prem-http'), opts)).toBe(false);
      // RFC1918 is allowed in on-prem-http regardless of the CGNAT opt-in.
      expect(isSsrfSafe(urlFor('10.0.0.5', 'on-prem-http'), opts)).toBe(true);
    });
  });
});

describe('resolve-then-check', () => {
  afterEach(() => {
    __setLookupForTests(null);
  });

  it('rejects a public hostname whose only A record is a private address', async () => {
    __setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(resolveSafeRecords('rebind.example.com')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects a public hostname whose only AAAA record is IPv4-mapped metadata', async () => {
    __setLookupForTests(async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }]);
    await expect(resolveSafeRecords('rebind6.example.com')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('drops the blocked records from a mixed answer and keeps the public ones', async () => {
    __setLookupForTests(async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const { safe, allIps } = await resolveSafeRecords('mixed.example.com');
    expect(safe.map((r) => r.address)).toEqual(['93.184.216.34']);
    expect(allIps).toHaveLength(3);
  });

  it('still blocks metadata for an integration that opted into private networking', async () => {
    __setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(
      resolveSafeRecords('rebind.example.com', { allowPrivateNetwork: true })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows an RFC1918 record when private networking is opted into', async () => {
    __setLookupForTests(async () => [{ address: '192.168.1.50', family: 4 }]);
    const { safe } = await resolveSafeRecords('appliance.example.com', { allowPrivateNetwork: true });
    expect(safe.map((r) => r.address)).toEqual(['192.168.1.50']);
  });

  it('resolveSafeRecords blocks a CGNAT literal unless BOTH opt-ins are set', async () => {
    await expect(resolveSafeRecords('100.100.5.6')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      resolveSafeRecords('100.100.5.6', { allowPrivateNetwork: true })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      resolveSafeRecords('100.100.5.6', { allowCarrierNat: true })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    const { safe } = await resolveSafeRecords('100.100.5.6', {
      allowPrivateNetwork: true,
      allowCarrierNat: true,
    });
    expect(safe.map((r) => r.address)).toEqual(['100.100.5.6']);
  });

  it('resolveSafeRecords drops a CGNAT DNS answer unless both opt-ins are set', async () => {
    __setLookupForTests(async () => [{ address: '100.100.5.6', family: 4 }]);
    await expect(resolveSafeRecords('overlay.example.com')).rejects.toBeInstanceOf(SsrfBlockedError);
    const { safe } = await resolveSafeRecords('overlay.example.com', {
      allowPrivateNetwork: true,
      allowCarrierNat: true,
    });
    expect(safe.map((r) => r.address)).toEqual(['100.100.5.6']);
  });

  it('canonicalises an inet_aton IPv4 literal instead of dialing it verbatim', async () => {
    // Passing '2130706433' through to the socket unchanged would hand
    // getaddrinfo an address the range table never inspected.
    await expect(resolveSafeRecords('2130706433')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
