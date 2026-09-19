import { describe, expect, it } from 'vitest';
import { describePort, defaultSchemeForPort, isWebPort, sortPorts } from './portCatalog';

describe('describePort', () => {
  it('labels well-known ports from the catalog', () => {
    expect(describePort(22)).toEqual({ label: 'SSH', kind: 'remote', risky: false });
    expect(describePort(443)).toEqual({ label: 'HTTPS', kind: 'web', risky: false });
    expect(describePort(3389)).toEqual({ label: 'RDP', kind: 'remote', risky: false });
    expect(describePort(445)).toEqual({ label: 'SMB', kind: 'file', risky: false });
    expect(describePort(631)).toEqual({ label: 'IPP', kind: 'print', risky: false });
    expect(describePort(161)).toEqual({ label: 'SNMP', kind: 'mgmt', risky: false });
  });

  it('flags insecure/plaintext services as risky', () => {
    expect(describePort(21)).toEqual({ label: 'FTP', kind: 'insecure', risky: true });
    expect(describePort(23)).toEqual({ label: 'Telnet', kind: 'insecure', risky: true });
    expect(describePort(110)).toEqual({ label: 'POP3', kind: 'insecure', risky: true });
  });

  it('ignores a supplied service string when the port is already catalogued', () => {
    expect(describePort(22, 'ssh')).toEqual({ label: 'SSH', kind: 'remote', risky: false });
  });

  it('falls back to the service string and infers a kind for an uncatalogued port', () => {
    expect(describePort(9999, 'http-alt')).toEqual({ label: 'http-alt', kind: 'web', risky: false });
    expect(describePort(9999, 'https-mgmt')).toEqual({ label: 'https-mgmt', kind: 'web', risky: false });
    expect(describePort(2222, 'custom-ssh')).toEqual({ label: 'custom-ssh', kind: 'remote', risky: false });
    expect(describePort(6000, 'vendor-vnc')).toEqual({ label: 'vendor-vnc', kind: 'remote', risky: false });
    expect(describePort(7000, 'vendor-rdp')).toEqual({ label: 'vendor-rdp', kind: 'remote', risky: false });
    expect(describePort(6631, 'ipp-print')).toEqual({ label: 'ipp-print', kind: 'print', risky: false });
    expect(describePort(6632, 'lpd-queue')).toEqual({ label: 'lpd-queue', kind: 'print', risky: false });
    expect(describePort(6633, 'jetdirect-x')).toEqual({ label: 'jetdirect-x', kind: 'print', risky: false });
    expect(describePort(6445, 'smb-share')).toEqual({ label: 'smb-share', kind: 'file', risky: false });
    expect(describePort(6446, 'nfs-export')).toEqual({ label: 'nfs-export', kind: 'file', risky: false });
    expect(describePort(6447, 'afp-share')).toEqual({ label: 'afp-share', kind: 'file', risky: false });
    expect(describePort(6636, 'ldap-alt')).toEqual({ label: 'ldap-alt', kind: 'mgmt', risky: false });
    expect(describePort(6161, 'snmp-alt')).toEqual({ label: 'snmp-alt', kind: 'mgmt', risky: false });
    expect(describePort(6985, 'winrm-alt')).toEqual({ label: 'winrm-alt', kind: 'mgmt', risky: false });
    expect(describePort(9998, 'some-daemon')).toEqual({ label: 'some-daemon', kind: 'other', risky: false });
  });

  it('falls back to the port number as the label with no service and no catalog entry', () => {
    expect(describePort(54321)).toEqual({ label: '54321', kind: 'other', risky: false });
  });
});

describe('sortPorts', () => {
  it('sorts ascending by port number', () => {
    const input = [{ port: 443 }, { port: 22 }, { port: 8080 }];
    expect(sortPorts(input).map((p) => p.port)).toEqual([22, 443, 8080]);
  });

  it('does not mutate the input array', () => {
    const input = [{ port: 443 }, { port: 22 }];
    const result = sortPorts(input);
    expect(input.map((p) => p.port)).toEqual([443, 22]);
    expect(result).not.toBe(input);
  });

  it('keeps equal-port entries in their original relative order', () => {
    const input = [
      { port: 443, tag: 'a' },
      { port: 22, tag: 'b' },
      { port: 443, tag: 'c' },
    ];
    expect(sortPorts(input).map((p) => p.tag)).toEqual(['b', 'a', 'c']);
  });
});

// Locks in the exact old behavior of the page's former local helpers so the
// catalog-backed replacements can never quietly diverge from what shipped.
describe('isWebPort (old page behavior preserved)', () => {
  it('treats the well-known web ports as web regardless of service', () => {
    for (const port of [80, 443, 8080, 8443, 8006, 9443]) {
      expect(isWebPort(port)).toBe(true);
      expect(isWebPort(port, 'something-else')).toBe(true);
    }
  });

  it('treats any http/https service string on an unlisted port as web', () => {
    expect(isWebPort(9999, 'http')).toBe(true);
    expect(isWebPort(9999, 'https')).toBe(true);
    expect(isWebPort(9999, 'HTTP-management')).toBe(true);
  });

  it('is false for a non-web port with no web-ish service', () => {
    expect(isWebPort(22, 'ssh')).toBe(false);
    expect(isWebPort(22)).toBe(false);
  });
});

describe('defaultSchemeForPort (old page behavior preserved)', () => {
  it('defaults 443, 8443 and 9443 to https', () => {
    expect(defaultSchemeForPort(443)).toBe('https');
    expect(defaultSchemeForPort(8443)).toBe('https');
    expect(defaultSchemeForPort(9443)).toBe('https');
  });

  it('defaults a service string containing https to https', () => {
    expect(defaultSchemeForPort(9999, 'https-alt')).toBe('https');
  });

  it('defaults everything else to http', () => {
    expect(defaultSchemeForPort(80)).toBe('http');
    expect(defaultSchemeForPort(8080)).toBe('http');
    expect(defaultSchemeForPort(8006)).toBe('http');
    expect(defaultSchemeForPort(9999, 'http')).toBe('http');
    expect(defaultSchemeForPort(9999)).toBe('http');
  });
});
