import { describe, it, expect } from 'vitest';
import {
  computeOriginIpSignals,
  networkPrefix,
  SUSPENDED_CONSOLE_IP_KEY,
  DEAD_ACCOUNT_PROBE_KEY,
  type OriginIpCorpus,
  type PartnerOriginAggregate,
} from './originIp';
import { SIGNAL_DEFAULTS, scoreToSeverity } from './config';

// Every address, name and mailbox below is invented for this file. IPv4
// fixtures use RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24) and IPv6 fixtures use the RFC 3849 documentation prefix
// (2001:db8::/32) so no real operator address is ever committed to a public
// repo — the same rule billingIdentity.test.ts applies to mailbox domains.

const cfg = SIGNAL_DEFAULTS;
const NOW = new Date('2026-08-31T15:30:00Z');

function agg(overrides: Partial<PartnerOriginAggregate> = {}): PartnerOriginAggregate {
  return {
    partnerId: 'p1',
    partnerName: 'Nordvane',
    partnerStatus: 'pending',
    originIps: [],
    ...overrides,
  };
}

function corpus(overrides: Partial<OriginIpCorpus> = {}): OriginIpCorpus {
  return {
    suspendedIps: new Map(),
    probes: [],
    ...overrides,
  };
}

const keys = (signals: ReturnType<typeof computeOriginIpSignals>) => signals.map((s) => s.signalKey);

describe('networkPrefix', () => {
  it('groups IPv4 by /24', () => {
    expect(networkPrefix('192.0.2.61')).toBe(networkPrefix('192.0.2.72'));
    expect(networkPrefix('192.0.2.61')).not.toBe(networkPrefix('192.0.3.61'));
  });

  it('groups IPv6 by /64 regardless of compression', () => {
    // The same /64 written compressed and expanded must collapse to one
    // prefix, or an operator hopping addresses inside a single assignment
    // reads as two unrelated networks.
    expect(networkPrefix('2001:db8:145:2002::1')).toBe(
      networkPrefix('2001:db8:0145:2002:64d5:59e4:bb86:ce4d'),
    );
    expect(networkPrefix('2001:db8:145:2002::1')).not.toBe(networkPrefix('2001:db8:145:2003::1'));
  });

  it('takes the client hop out of a legacy X-Forwarded-For chain', () => {
    // Production audit rows predating proxy reduction store the whole chain,
    // e.g. "198.51.100.9, 172.19.0.8" where the second hop is the
    // container-internal proxy. Parsing the raw string yields nothing, which
    // would drop that request's origin silently — the leftmost entry is the
    // client and the one that identifies the operator.
    expect(networkPrefix('198.51.100.9, 172.19.0.8')).toBe(networkPrefix('198.51.100.9'));
    expect(networkPrefix('198.51.100.9,172.19.0.8')).toBe(networkPrefix('198.51.100.9'));
  });

  it('returns null for junk the audit log actually stores', () => {
    // ip_address is a varchar and production contains the literal string
    // 'unknown' on rows written before the field was populated.
    for (const junk of ['unknown', '', '   ', 'not-an-ip', '999.1.1.1']) {
      expect(networkPrefix(junk)).toBeNull();
    }
  });
});

describe('computeOriginIpSignals — quiet cases', () => {
  it('emits nothing with no partners and no corpus', () => {
    expect(computeOriginIpSignals([], corpus(), cfg, NOW)).toEqual([]);
  });

  it('emits nothing for a partner whose origins match nothing', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.10'] })],
      corpus({ suspendedIps: new Map([['198.51.100.5', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('ignores junk origin IPs instead of matching them against each other', () => {
    // Two partners both carrying 'unknown' must not correlate.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['unknown', ''] })],
      corpus({ suspendedIps: new Map([['unknown', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe('fraud.suspended_console_ip', () => {
  it('fires at alert on a single exact IP shared with a suspended partner', () => {
    // The Lagus / Fetching Post shape: the operator failed a login on the dead
    // account and signed up again from the same console IP four minutes later.
    // signup_ip alone caught this only because they happened to reuse it; the
    // console IP is what actually ties the accounts.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', ['Fetching Post']]]) }),
      cfg,
      NOW,
    );

    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
    expect(out[0]!.score).toBe(cfg['fraud.suspended_console_ip.base_score']);
    expect(out[0]!.severity).toBe('alert');
    expect(out[0]!.partnerId).toBe('p1');
    expect(out[0]!.evidence).toMatchObject({
      partnerName: 'Nordvane',
      matchedIps: ['203.0.113.7'],
      suspendedPartners: ['Fetching Post'],
    });
  });

  it('scores higher for each additional shared IP', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7', '203.0.113.8', '192.0.2.1'] })],
      corpus({
        suspendedIps: new Map([
          ['203.0.113.7', ['Fetching Post']],
          ['203.0.113.8', ['Lagus']],
        ]),
      }),
      cfg,
      NOW,
    );

    expect(out[0]!.score).toBe(
      cfg['fraud.suspended_console_ip.base_score'] + cfg['fraud.suspended_console_ip.per_extra_ip'],
    );
    // Only the matching addresses are cited — the partner's clean IPs are not
    // evidence and must not pad the report.
    expect(out[0]!.evidence.matchedIps).toEqual(['203.0.113.7', '203.0.113.8']);
  });

  it('clamps at 100 rather than overflowing on a long shared list', () => {
    const ips = Array.from({ length: 20 }, (_, i) => `203.0.113.${i + 1}`);
    const out = computeOriginIpSignals(
      [agg({ originIps: ips })],
      corpus({ suspendedIps: new Map(ips.map((ip) => [ip, ['Dead Co']])) }),
      cfg,
      NOW,
    );
    expect(out[0]!.score).toBe(100);
  });

  it('applies NO cardinality cap when many suspended partners share one IP', () => {
    // The 08-23 lesson: the signup gate silenced its equivalent check once an
    // IP reached three suspended accounts, on the theory that a busy IP is
    // shared egress. Every capped IP in production turned out to be an abuse
    // IP and the guard never once prevented a false positive. More suspended
    // neighbours must make this signal STRONGER, never silent.
    const many = ['Dead A', 'Dead B', 'Dead C', 'Dead D', 'Dead E'];
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', many]]) }),
      cfg,
      NOW,
    );

    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
    expect(out[0]!.severity).toBe('alert');
    expect(out[0]!.evidence.suspendedPartners).toEqual(many);
  });

  it('matches an exact address recorded as a forwarded-for chain', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7, 172.19.0.8'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
  });

  it('matches an IPv6 console address exactly', () => {
    const ip = '2001:db8:145:2002:64d5:59e4:bb86:ce4d';
    const out = computeOriginIpSignals(
      [agg({ originIps: [ip] })],
      corpus({ suspendedIps: new Map([[ip, ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
  });

  it('matches a compressed IPv6 literal against its expanded form exactly', () => {
    // The exact-match path is the alert-tier signal, so compression must not
    // defeat it any more than it defeats the /64 grouping.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['2001:db8:145:2002::1'] })],
      corpus({ suspendedIps: new Map([['2001:0db8:0145:2002:0000:0000:0000:0001', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
    expect(out[0]!.evidence.matchedIps).toEqual(['2001:db8:145:2002::1']);
  });

  it('matches an IPv4-mapped IPv6 address against itself and counts it once', () => {
    // ::ffff:203.0.113.7 exercises the embedded-v4-tail branch of expandIPv6.
    const mapped = '::ffff:203.0.113.7';
    const out = computeOriginIpSignals(
      [agg({ originIps: [mapped, '::ffff:cb00:7107'] })],
      corpus({ suspendedIps: new Map([[mapped, ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
    // The dotted-quad and hex spellings canonicalize to one address: one
    // match, base score only, no per_extra_ip inflation.
    expect(out[0]!.score).toBe(cfg['fraud.suspended_console_ip.base_score']);
    expect(out[0]!.evidence.matchedIps).toHaveLength(1);
  });

  it('counts two XFF spellings of one client address as ONE matched IP', () => {
    // Same real client behind two different legacy proxy second hops must not
    // earn the per_extra_ip bonus, and the evidence must cite the clean IP.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7, 172.19.0.8', '203.0.113.7, 172.19.0.5'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    expect(out[0]!.score).toBe(cfg['fraud.suspended_console_ip.base_score']);
    expect(out[0]!.evidence.matchedIps).toEqual(['203.0.113.7']);
  });
});

describe('fraud.dead_account_probe_origin', () => {
  const probe = (ip: string, minutesAgo: number) => ({
    ip,
    partnerName: 'Techlace',
    at: new Date(NOW.getTime() - minutesAgo * 60_000),
  });

  it('fires when the new account works from the same /24 the operator probed a dead account from', () => {
    // The 08-31 shape, and the reason this signal is a /24 rather than an
    // exact match: the operator probed the suspended account from .72 at 14:06
    // and ran the new one from .61 at 15:08. An exact-IP rule sees nothing.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('192.0.2.72', 84)] }),
      cfg,
      NOW,
    );

    expect(keys(out)).toEqual([DEAD_ACCOUNT_PROBE_KEY]);
    expect(out[0]!.score).toBe(cfg['fraud.dead_account_probe_origin.score']);
    // Deliberately BELOW alert: a /24 is a weaker tie than an exact address,
    // so this corroborates rather than pages on its own.
    expect(out[0]!.severity).toBe('watch');
    expect(scoreToSeverity(out[0]!.score, cfg)).toBe('watch');
    expect(out[0]!.evidence).toMatchObject({
      partnerName: 'Nordvane',
      probedPartners: ['Techlace'],
    });
  });

  it('does not fire for a probe outside the window', () => {
    const hours = cfg['fraud.dead_account_probe_origin.window_hours'];
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('192.0.2.72', hours * 60 + 1)] }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('still fires for a probe exactly window_hours old (inclusive boundary)', () => {
    // Pins the comparator to strict `>` — an accidental `>=` would silently
    // shave the boundary and no other test would notice.
    const hours = cfg['fraud.dead_account_probe_origin.window_hours'];
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('192.0.2.72', hours * 60)] }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([DEAD_ACCOUNT_PROBE_KEY]);
  });

  it('ignores a probe timestamped in the future (clock skew, not evidence)', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('192.0.2.72', -5)] }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('does not fire for a probe from a different /24', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('198.51.100.72', 10)] }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('matches an IPv6 probe on the /64', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['2001:db8:145:2002:aaaa::9'] })],
      corpus({ probes: [probe('2001:db8:145:2002:64d5:59e4:bb86:ce4d', 10)] }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([DEAD_ACCOUNT_PROBE_KEY]);
  });

  it('does not fire for a different IPv6 /64', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['2001:db8:145:2003:aaaa::9'] })],
      corpus({ probes: [probe('2001:db8:145:2002:64d5:59e4:bb86:ce4d', 10)] }),
      cfg,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('is suppressed when the exact-IP signal already fired for that partner', () => {
    // The exact match strictly dominates the /24 match and they share an axis,
    // so emitting both would add a row that can never change an outcome.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({
        suspendedIps: new Map([['192.0.2.61', ['Dead Co']]]),
        probes: [probe('192.0.2.72', 10)],
      }),
      cfg,
      NOW,
    );
    expect(keys(out)).toEqual([SUSPENDED_CONSOLE_IP_KEY]);
  });

  it('deduplicates the probed-partner list', () => {
    const out = computeOriginIpSignals(
      [agg({ originIps: ['192.0.2.61'] })],
      corpus({ probes: [probe('192.0.2.72', 10), probe('192.0.2.90', 20)] }),
      cfg,
      NOW,
    );
    expect(out[0]!.evidence.probedPartners).toEqual(['Techlace']);
  });
});

describe('scoring is independent of account age', () => {
  it('does not decay — the aggregate carries no created-at for the scorer to weight', () => {
    // Sibling rule to the billing-identity and script-content detectors: an IP
    // shared with a suspended operator is evidence about infrastructure, not
    // about how recently the account was created. A six-week-old pre-position
    // account (firstsocialcircle sat dormant for six) must score the same as
    // one signed up minutes ago.
    const out = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', ['Dead Co']]]) }),
      cfg,
      NOW,
    );
    const later = computeOriginIpSignals(
      [agg({ originIps: ['203.0.113.7'] })],
      corpus({ suspendedIps: new Map([['203.0.113.7', ['Dead Co']]]) }),
      cfg,
      new Date(NOW.getTime() + 365 * 86_400_000),
    );
    expect(later[0]!.score).toBe(out[0]!.score);
  });
});

describe('multiple partners', () => {
  it('scores each partner independently', () => {
    const out = computeOriginIpSignals(
      [
        agg({ partnerId: 'p1', originIps: ['203.0.113.7'] }),
        // Deliberately in a DIFFERENT /24 from the probe below — 192.0.2.x
        // would have made this partner a match, not a control.
        agg({ partnerId: 'p2', partnerName: 'Bellmoor', originIps: ['198.51.100.10'] }),
        agg({ partnerId: 'p3', partnerName: 'Quillon', originIps: ['192.0.2.61'] }),
      ],
      corpus({
        suspendedIps: new Map([['203.0.113.7', ['Dead Co']]]),
        probes: [{ ip: '192.0.2.72', partnerName: 'Techlace', at: NOW }],
      }),
      cfg,
      NOW,
    );

    expect(out.map((s) => [s.partnerId, s.signalKey])).toEqual([
      ['p1', SUSPENDED_CONSOLE_IP_KEY],
      ['p3', DEAD_ACCOUNT_PROBE_KEY],
    ]);
  });
});
