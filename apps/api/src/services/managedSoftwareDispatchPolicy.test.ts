import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_NETWORK_POLICY_UPGRADE_REQUIRED,
  APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH,
  approvedOriginSchemeOrPortMismatch,
  evaluateManagedSoftwareDispatch,
  getManagedSoftwarePolicyMode,
  isPrivateSoftwareDestination,
} from './managedSoftwareDispatchPolicy';

// Direct unit suite for the Wave 6 Task 5 dispatch gate. The two dispatch
// suites (services/softwareDeployment.test.ts, routes/software.test.ts) prove
// the WIRING with three representative URLs; this file pins the classifier's
// full claim set, because a URL shape that classifies "public" by mistake
// hands a private destination to a capability-0 agent under the shipping
// default (compat).

describe('isPrivateSoftwareDestination', () => {
  const APPROVED = ['https://files.corp.internal', 'https://10.20.30.40:8443'];

  describe('apparently public destinations', () => {
    const publicUrls = [
      'https://cdn.example.com/pkg.exe',
      'https://cdn.example.com:8443/pkg.exe',
      'https://8.8.8.8/pkg.exe',
      'https://203.0.113.10/pkg.exe',
      'https://[2606:4700:4700::1111]/pkg.exe',
      // IPv4-mapped IPv6 carrying a PUBLIC payload: the destination genuinely
      // is public, so the gate classifies it public. (netpolicy separately
      // refuses every IPv4-mapped literal as ambiguous_ip_encoding — that is
      // the agent's call to make, not a reason to gate a capability-0 agent.)
      'https://[::ffff:8.8.8.8]/pkg.exe',
      // A host that merely resembles an approved one must not match.
      'https://notfiles.corp.internal/pkg.exe',
      'https://files.corp.internal.evil.example/pkg.exe',
    ];

    for (const url of publicUrls) {
      it(`classifies ${url} public`, () => {
        expect(isPrivateSoftwareDestination(url, APPROVED)).toBe(false);
      });
    }
  });

  describe('private and universally unsafe IP literals', () => {
    const privateUrls = [
      // RFC1918 / CGNAT
      'https://10.0.0.5/pkg.exe',
      'https://172.16.0.1/pkg.exe',
      'https://172.31.255.254/pkg.exe',
      'https://192.168.1.1/pkg.exe',
      'https://100.64.0.1/pkg.exe',
      'https://100.100.100.200/pkg.exe',
      // Loopback, including obfuscated spellings the WHATWG parser
      // canonicalizes before we ever see them.
      'https://127.0.0.1/pkg.exe',
      'https://2130706433/pkg.exe',
      'https://0177.0.0.1/pkg.exe',
      'https://0x7f000001/pkg.exe',
      'https://127.1/pkg.exe',
      // Short-form RFC1918
      'https://10.1/pkg.exe',
      // Link-local / metadata / unspecified / multicast / reserved
      'https://169.254.169.254/pkg.exe',
      'https://169.254.170.2/pkg.exe',
      'https://0.0.0.0/pkg.exe',
      'https://224.0.0.1/pkg.exe',
      'https://240.0.0.1/pkg.exe',
      'https://255.255.255.255/pkg.exe',
      'https://192.0.0.1/pkg.exe',
      'https://198.18.0.1/pkg.exe',
      // IPv6: unspecified, loopback, link-local, ULA, multicast
      'https://[::]/pkg.exe',
      'https://[::1]/pkg.exe',
      'https://[fe80::1]/pkg.exe',
      'https://[fd00::5]/pkg.exe',
      'https://[fc00::1]/pkg.exe',
      'https://[ff02::1]/pkg.exe',
      // IPv6 transition encodings wrapping a private/unsafe IPv4
      'https://[::ffff:10.0.0.1]/pkg.exe', // IPv4-mapped
      'https://[::ffff:0:10.0.0.1]/pkg.exe', // IPv4-translated
      'https://[::127.0.0.1]/pkg.exe', // IPv4-compatible
      'https://[2002:0a00:0005::]/pkg.exe', // 6to4 → 10.0.0.5
      'https://[2001:0:0:0:0:0:f5ff:fffa]/pkg.exe', // Teredo → 10.0.0.5
      'https://[64:ff9b::a00:5]/pkg.exe', // NAT64 → 10.0.0.5
      // userinfo cannot be used to disguise the real host
      'https://cdn.example.com@10.0.0.5/pkg.exe',
    ];

    for (const url of privateUrls) {
      it(`classifies ${url} private`, () => {
        expect(isPrivateSoftwareDestination(url, APPROVED)).toBe(true);
      });
    }
  });

  describe('operator-declared private origins', () => {
    it('matches the approved origin exactly', () => {
      expect(isPrivateSoftwareDestination('https://files.corp.internal/pkg.exe', APPROVED)).toBe(true);
    });

    // REGRESSION (fix round 1, Critical 1): a trailing dot is the same DNS
    // name to every resolver — and to the agent, which trims it — but the
    // stored allowlist is normalized without one. Comparing raw host text let
    // this spelling classify "public" and enqueue a LAN download to a
    // capability-0 agent under compat.
    it('matches when the destination host carries a trailing dot', () => {
      expect(isPrivateSoftwareDestination('https://files.corp.internal./pkg.exe', APPROVED)).toBe(true);
    });

    it('matches when the STORED origin carries a trailing dot', () => {
      expect(
        isPrivateSoftwareDestination('https://files.corp.internal/pkg.exe', ['https://files.corp.internal.']),
      ).toBe(true);
    });

    it('matches regardless of case', () => {
      expect(isPrivateSoftwareDestination('https://FILES.CORP.INTERNAL/pkg.exe', APPROVED)).toBe(true);
    });

    // A host the operator declared private is private however it is reached:
    // over cleartext, or on another port. Both spellings would otherwise let a
    // capability-0 agent be handed the same LAN host in compat mode.
    it('matches over cleartext', () => {
      expect(isPrivateSoftwareDestination('http://files.corp.internal/pkg.exe', APPROVED)).toBe(true);
    });

    it('matches on a different port', () => {
      expect(isPrivateSoftwareDestination('https://files.corp.internal:8080/pkg.exe', APPROVED)).toBe(true);
    });

    it('matches an approved origin that names a port', () => {
      expect(isPrivateSoftwareDestination('https://10.20.30.40:8443/pkg.exe', APPROVED)).toBe(true);
    });

    it('does not match when the allowlist is empty', () => {
      expect(isPrivateSoftwareDestination('https://files.corp.internal/pkg.exe', [])).toBe(false);
    });

    it('ignores an unparseable allowlist entry instead of throwing', () => {
      expect(
        isPrivateSoftwareDestination('https://cdn.example.com/pkg.exe', ['', 'not a url', '   ']),
      ).toBe(false);
    });
  });

  describe('loopback-ish and metadata hostnames', () => {
    const hostnames = [
      'https://localhost/pkg.exe',
      'https://LOCALHOST/pkg.exe',
      'https://foo.localhost/pkg.exe',
      'https://foo.LocalHost./pkg.exe',
      'https://metadata.google.internal/pkg.exe',
      'https://metadata.google.internal./pkg.exe',
    ];

    for (const url of hostnames) {
      it(`classifies ${url} private`, () => {
        expect(isPrivateSoftwareDestination(url, [])).toBe(true);
      });
    }
  });

  describe('fails closed on input it cannot classify', () => {
    const unclassifiable = ['', '   ', 'not a url', 'https://', 'pkg.exe', '/relative/pkg.exe'];

    for (const url of unclassifiable) {
      it(`classifies ${JSON.stringify(url)} private`, () => {
        expect(isPrivateSoftwareDestination(url, APPROVED)).toBe(true);
      });
    }

    it('classifies a malformed IPv6 literal private rather than falling through to the hostname branch', () => {
      expect(isPrivateSoftwareDestination('https://[::ffff:zz]/pkg.exe', APPROVED)).toBe(true);
    });
  });

  it('defaults the allowlist to empty when omitted', () => {
    expect(isPrivateSoftwareDestination('https://cdn.example.com/pkg.exe')).toBe(false);
    expect(isPrivateSoftwareDestination('https://10.0.0.5/pkg.exe')).toBe(true);
  });
});

describe('getManagedSoftwarePolicyMode', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to compat when unset', () => {
    vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', undefined as unknown as string);
    expect(getManagedSoftwarePolicyMode()).toBe('compat');
  });

  it.each(['enforce', 'ENFORCE', '  Enforce  '])('reads %j as enforce', (value) => {
    vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', value);
    expect(getManagedSoftwarePolicyMode()).toBe('enforce');
  });

  it.each(['', 'compat', 'banana', 'enforce!', 'strict'])(
    'treats %j as compat — a misconfiguration must never silently tighten the fleet',
    (value) => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', value);
      expect(getManagedSoftwarePolicyMode()).toBe('compat');
    },
  );
});

describe('evaluateManagedSoftwareDispatch', () => {
  const base = { approvedPrivateOrigins: ['https://files.corp.internal'] };

  it.each([1, 2])('allows any destination to a capability-%i agent', (capability) => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://10.0.0.5/pkg.exe',
        outboundNetworkPolicyVersion: capability,
        mode: 'enforce',
      }),
    ).toEqual({ allowed: true });
  });

  it.each([0, null, undefined])('treats capability %j as no policy', (capability) => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://cdn.example.com/pkg.exe',
        outboundNetworkPolicyVersion: capability,
        mode: 'enforce',
      }),
    ).toEqual({ allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED });
  });

  it('compat allows a public destination to a capability-0 agent', () => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://cdn.example.com/pkg.exe',
        outboundNetworkPolicyVersion: 0,
        mode: 'compat',
      }),
    ).toEqual({ allowed: true });
  });

  it('compat denies a private destination to a capability-0 agent', () => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://files.corp.internal./pkg.exe',
        outboundNetworkPolicyVersion: 0,
        mode: 'compat',
      }),
    ).toEqual({ allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED });
  });

  it('falls back to the process mode when none is supplied', () => {
    vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://cdn.example.com/pkg.exe',
        outboundNetworkPolicyVersion: 0,
      }),
    ).toEqual({ allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED });
    vi.unstubAllEnvs();
  });
});

describe('approvedOriginSchemeOrPortMismatch', () => {
  const APPROVED = ['https://files.corp.internal', 'https://10.20.30.40:8443'];

  it.each([
    ['https://files.corp.internal/pkg.exe', 'exact match, default port implied'],
    ['https://files.corp.internal:443/pkg.exe', 'exact match, port written out'],
    ['https://FILES.CORP.INTERNAL./pkg.exe', 'case + trailing dot normalize to a match'],
    ['https://10.20.30.40:8443/pkg.exe', 'IP literal with the approved port'],
  ])('reports no mismatch for %s (%s)', (url) => {
    expect(approvedOriginSchemeOrPortMismatch(url, APPROVED)).toBe(false);
  });

  it.each([
    ['https://files.corp.internal:8443/pkg.exe', 'wrong port'],
    ['http://files.corp.internal/pkg.exe', 'wrong scheme'],
    ['https://10.20.30.40/pkg.exe', 'IP literal missing the approved port'],
    ['https://10.20.30.40:9443/pkg.exe', 'IP literal, wrong port'],
  ])('reports a mismatch for %s (%s)', (url) => {
    expect(approvedOriginSchemeOrPortMismatch(url, APPROVED)).toBe(true);
  });

  it.each([
    ['https://cdn.example.com/pkg.exe', 'host not on the allowlist at all'],
    ['https://10.0.0.5/pkg.exe', 'private IP that no entry names'],
    ['not a url', 'unparseable'],
  ])('reports no mismatch for %s (%s) — nothing to diagnose', (url) => {
    expect(approvedOriginSchemeOrPortMismatch(url, APPROVED)).toBe(false);
  });

  it('defaults the allowlist to empty when omitted', () => {
    expect(approvedOriginSchemeOrPortMismatch('https://files.corp.internal/pkg.exe')).toBe(false);
  });
});

describe('evaluateManagedSoftwareDispatch origin-mismatch reason', () => {
  const base = { approvedPrivateOrigins: ['https://files.corp.internal'] };

  it('substitutes the mismatch reason for the upgrade reason in compat', () => {
    // The host IS allowlisted, so the destination classifies private and a
    // capability-0 device is denied either way. Reporting "upgrade required"
    // would be actively misleading: no agent version accepts :8443 here.
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://files.corp.internal:8443/pkg.exe',
        outboundNetworkPolicyVersion: 0,
        mode: 'compat',
      }),
    ).toEqual({ allowed: false, reason: APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH });
  });

  it('substitutes the mismatch reason in enforce too', () => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'http://files.corp.internal/pkg.exe',
        outboundNetworkPolicyVersion: 0,
        mode: 'enforce',
      }),
    ).toEqual({ allowed: false, reason: APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH });
  });

  it('keeps the upgrade reason when the host is not allowlisted', () => {
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://10.0.0.5:8443/pkg.exe',
        outboundNetworkPolicyVersion: 0,
        mode: 'compat',
      }),
    ).toEqual({ allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED });
  });

  it('never denies a capability-1 device on an origin mismatch', () => {
    // The API cannot resolve DNS: an allowlisted host may answer public and
    // download fine. Denying here would break working deployments.
    expect(
      evaluateManagedSoftwareDispatch({
        ...base,
        downloadUrl: 'https://files.corp.internal:8443/pkg.exe',
        outboundNetworkPolicyVersion: 1,
        mode: 'enforce',
      }),
    ).toEqual({ allowed: true });
  });
});
