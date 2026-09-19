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
import { describe, expect, it, afterEach } from 'vitest';
import { isSsrfSafe, type SsrfMode } from './ssrfGuard';
import {
  isPrivateIp,
  isAlwaysBlockedIp,
  isRfc1918OrUla,
  resolveSafeRecords,
  SsrfBlockedError,
  __setLookupForTests,
} from './urlSafety';

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

  // ---- Non-dotted-quad IPv4 literal forms (inet_aton) ------------------
  // getaddrinfo() accepts all of these spellings and they name 127.0.0.1 /
  // 169.254.169.254. Neither range table recognised them before this change.
  { label: 'decimal 2130706433 (=127.0.0.1)', host: '2130706433' },
  { label: 'decimal 2852039166 (=169.254.169.254)', host: '2852039166' },
  { label: 'octal 0177.0.0.1 (=127.0.0.1)', host: '0177.0.0.1' },
  { label: 'hex 0x7f.0.0.1 (=127.0.0.1)', host: '0x7f.0.0.1' },
  { label: 'two-part 127.1 (=127.0.0.1)', host: '127.1' },
  { label: 'three-part 169.254.43518 (=169.254.169.254)', host: '169.254.43518' },

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
const ALLOWED_ROWS: Array<{ label: string; host: string }> = [
  { label: 'public hostname', host: 'api.example.com' },
  { label: 'public IPv4', host: '93.184.216.34' },
  { label: 'public IPv6', host: '[2606:2800:220:1:248:1893:25c8:1946]' },
  { label: '172.15.0.1 just below RFC1918', host: '172.15.0.1' },
  { label: '172.32.0.1 just above RFC1918', host: '172.32.0.1' },
  { label: '100.63.255.254 just below CGNAT', host: '100.63.255.254' },
  { label: '100.128.0.1 just above CGNAT', host: '100.128.0.1' },
  { label: '1.0.0.1 leading octet 1, not 0', host: '1.0.0.1' },
  { label: 'hostname that merely starts with fd', host: 'fd-cdn.example.com' },
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
    if (row.host.includes('example.com')) continue; // hostnames, not IPs
    const bare = row.host.replace(/^\[|\]$/g, '');
    it(`isPrivateIp allows ${row.label}`, () => {
      expect(isPrivateIp(bare)).toBe(false);
    });
    it(`isAlwaysBlockedIp allows ${row.label}`, () => {
      expect(isAlwaysBlockedIp(bare)).toBe(false);
    });
  }
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

  it('canonicalises an inet_aton IPv4 literal instead of dialing it verbatim', async () => {
    // Passing '2130706433' through to the socket unchanged would hand
    // getaddrinfo an address the range table never inspected.
    await expect(resolveSafeRecords('2130706433')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
