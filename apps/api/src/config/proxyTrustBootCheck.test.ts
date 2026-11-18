import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { findTrustedProxyCidrMismatch, warnOnTrustedProxyCidrMismatch } from './proxyTrustBootCheck';

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function v4(cidr: string, internal = false): NetworkInterfaceInfo {
  return { address: cidr.split('/')[0]!, netmask: '', family: 'IPv4', mac: '', internal, cidr } as NetworkInterfaceInfo;
}
function v6(cidr: string, internal = false): NetworkInterfaceInfo {
  return { address: cidr.split('/')[0]!, netmask: '', family: 'IPv6', mac: '', internal, cidr, scopeid: 0 } as NetworkInterfaceInfo;
}

const ifaces: Ifaces = {
  lo: [v4('127.0.0.1/8', true)],
  eth0: [v4('192.0.2.5/24'), v6('2001:db8::5/64')],
};

describe('findTrustedProxyCidrMismatch', () => {
  it('returns null when a /32 sits inside an attached subnet', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '192.0.2.10/32', interfaces: ifaces })).toBeNull();
  });

  it('returns null when the configured CIDR is wider than an attached subnet', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '192.0.0.0/16', interfaces: ifaces })).toBeNull();
  });

  it('is satisfied if any one entry overlaps', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '198.51.100.7/32, 192.0.2.9', interfaces: ifaces })).toBeNull();
  });

  it('warns naming the configured CIDRs and detected subnets when nothing overlaps', () => {
    const msg = findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '198.51.100.7/32', interfaces: ifaces });
    expect(msg).toContain('[proxy-trust]');
    expect(msg).toContain('198.51.100.7/32');
    expect(msg).toContain('192.0.2.0/24');
    expect(msg).toContain('2001:db8::/64');
    expect(msg).not.toContain('127.0.0.0/8');
    expect(msg).toContain('TRUSTED_PROXY_CIDRS');
  });

  it('does not match across address families', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '2001:db9::1/128', interfaces: { eth0: [v4('192.0.2.5/24')] } })).not.toBeNull();
  });

  it('matches IPv6 containment', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '2001:db8::10/128', interfaces: ifaces })).toBeNull();
  });

  it('stays silent when proxy headers are not trusted', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: false, trustedProxyCidrs: '198.51.100.7/32', interfaces: ifaces })).toBeNull();
  });

  it('stays silent for unset or empty CIDR lists', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: undefined, interfaces: ifaces })).toBeNull();
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: ' , ', interfaces: ifaces })).toBeNull();
  });

  it('stays silent when no non-loopback subnet is detected (cannot judge)', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '198.51.100.7/32', interfaces: { lo: [v4('127.0.0.1/8', true)] } })).toBeNull();
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '198.51.100.7/32', interfaces: {} })).toBeNull();
  });

  it('ignores malformed entries without throwing', () => {
    expect(() => findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: 'not-a-cidr,192.0.2.1/99,198.51.100.7/32', interfaces: ifaces })).not.toThrow();
    // Only malformed entries: nothing usable to compare, so no warning.
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: 'not-a-cidr,192.0.2.1/99', interfaces: ifaces })).toBeNull();
  });
});

describe('non-aligned subnets', () => {
  const docker: Ifaces = { eth0: [v4('172.17.9.5/20')] };
  const base = { trustProxyHeaders: true, trustedProxyCidrs: '198.51.100.7/32' };
  it('masks host bits in the warning text', () => {
    const msg = findTrustedProxyCidrMismatch({ ...base, interfaces: docker });
    expect(msg).toContain('172.17.0.0/20');
    expect(msg).not.toContain('172.17.9.5');
    expect(findTrustedProxyCidrMismatch({ ...base, interfaces: { eth0: [v4('192.0.2.77/25')] } })).toContain('192.0.2.0/25');
    expect(findTrustedProxyCidrMismatch({ ...base, interfaces: { eth0: [v6('2001:db8:0:5::5/60')] } })).toContain('2001:db8::/60');
  });
  it('overlaps inside a /20 and not just outside it', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '172.17.15.9/32', interfaces: docker })).toBeNull();
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '172.17.16.1/32', interfaces: docker })).not.toBeNull();
  });
  it('lists a shared subnet once and keeps malformed entries out of the message', () => {
    const msg = findTrustedProxyCidrMismatch({
      trustProxyHeaders: true,
      trustedProxyCidrs: 'not-a-cidr,198.51.100.7/32',
      interfaces: { eth0: [v4('192.0.2.5/24')], eth1: [v4('192.0.2.6/24')] },
    })!;
    expect(msg.match(/192\.0\.2\.0\/24/g)).toHaveLength(1);
    expect(msg).not.toContain('not-a-cidr');
  });
});

describe('loopback proxy', () => {
  it('does not warn when the proxy is on loopback', () => {
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '127.0.0.1/32', interfaces: ifaces })).toBeNull();
    expect(findTrustedProxyCidrMismatch({ trustProxyHeaders: true, trustedProxyCidrs: '::1/128', interfaces: ifaces })).toBeNull();
  });
});

describe('warnOnTrustedProxyCidrMismatch', () => {
  it('treats unset TRUST_PROXY_HEADERS as auto: on outside production, off in production', () => {
    const warn = vi.fn();
    warnOnTrustedProxyCidrMismatch({ TRUSTED_PROXY_CIDRS: '198.51.100.7/32', NODE_ENV: 'development' }, { interfaces: ifaces, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    warnOnTrustedProxyCidrMismatch({ TRUSTED_PROXY_CIDRS: '198.51.100.7/32', NODE_ENV: 'production' }, { interfaces: ifaces, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs one warning and never throws', () => {
    const warn = vi.fn();
    warnOnTrustedProxyCidrMismatch({ TRUST_PROXY_HEADERS: 'true', TRUSTED_PROXY_CIDRS: '198.51.100.7/32' }, { interfaces: ifaces, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('swallows interface enumeration failures', () => {
    const warn = vi.fn();
    expect(() => warnOnTrustedProxyCidrMismatch(
      { TRUST_PROXY_HEADERS: 'true', TRUSTED_PROXY_CIDRS: '198.51.100.7/32' },
      { interfaces: () => { throw new Error('boom'); }, warn },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('check skipped');
    expect(warn.mock.calls[0]![0]).toContain('boom');
  });

  it('accepts the boolean spellings validate.ts accepts', () => {
    const warn = vi.fn();
    warnOnTrustedProxyCidrMismatch({ TRUST_PROXY_HEADERS: '1', TRUSTED_PROXY_CIDRS: '198.51.100.7/32' }, { interfaces: ifaces, warn });
    warnOnTrustedProxyCidrMismatch({ TRUST_PROXY_HEADERS: 'no', TRUSTED_PROXY_CIDRS: '198.51.100.7/32' }, { interfaces: ifaces, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
