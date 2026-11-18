import { describe, expect, it } from 'vitest';
import { ECH_DOH_ENDPOINT_URLS, NETWORK_ISOLATION_LIMITS, isolationAllowEntrySchema, type IsolationAllowEntry } from '@breeze/shared';
import { IsolationAllowlistError, buildIsolationAllowlist } from './allowlist';

const SERVER = 'https://control.example.test';
const noEnv = {} as Record<string, string | undefined>;

function hostEntries(list: IsolationAllowEntry[]) {
  return list.filter((e): e is Extract<IsolationAllowEntry, { kind: 'host' }> => e.kind === 'host');
}

describe('buildIsolationAllowlist — control plane', () => {
  it('always includes the server URL host on its port (443 by default)', () => {
    const list = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: noEnv });
    expect(list).toContainEqual({ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze' });
  });

  it('keeps an explicit port, and http defaults to 80', () => {
    expect(buildIsolationAllowlist({ serverUrl: 'https://control.example.test:8443/api', remoteRelay: false, env: noEnv }))
      .toContainEqual({ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [8443], scope: 'breeze' });
    expect(buildIsolationAllowlist({ serverUrl: 'http://control.example.test', remoteRelay: false, env: noEnv }))
      .toContainEqual({ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [80], scope: 'breeze' });
  });

  it('emits a server URL that is an address literal as a single-address cidr', () => {
    expect(buildIsolationAllowlist({ serverUrl: 'https://192.0.2.10', remoteRelay: false, env: noEnv }))
      .toContainEqual({ kind: 'cidr', cidr: '192.0.2.10/32', proto: 'tcp', ports: [443], scope: 'breeze' });
    expect(buildIsolationAllowlist({ serverUrl: 'https://[2001:db8::10]:8443', remoteRelay: false, env: noEnv }))
      .toContainEqual({ kind: 'cidr', cidr: '2001:db8::10/128', proto: 'tcp', ports: [8443], scope: 'breeze' });
  });

  it('refuses a server URL it cannot parse rather than emitting an allowlist without the control plane', () => {
    expect(() => buildIsolationAllowlist({ serverUrl: 'not a url', remoteRelay: false, env: noEnv })).toThrow(/serverUrl/);
    expect(() => buildIsolationAllowlist({ serverUrl: 'ftp://control.example.test', remoteRelay: false, env: noEnv })).toThrow(/serverUrl/);
  });
});

describe('buildIsolationAllowlist — backup server', () => {
  it('includes AGENT_BACKUP_SERVER_URL when set, and nothing when unset or blank', () => {
    const env = { AGENT_BACKUP_SERVER_URL: 'https://backup.example.test' };
    expect(buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env }))
      .toContainEqual({ kind: 'host', host: 'backup.example.test', proto: 'tcp', ports: [443], scope: 'breeze' });
    for (const blank of [noEnv, { AGENT_BACKUP_SERVER_URL: '   ' }]) {
      const hosts = hostEntries(buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: blank })).map((e) => e.host);
      expect(hosts).not.toContain('backup.example.test');
    }
  });

  it('refuses an unparseable AGENT_BACKUP_SERVER_URL rather than silently dropping the failover path', () => {
    expect(() => buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: { AGENT_BACKUP_SERVER_URL: 'backup' } }))
      .toThrow(/AGENT_BACKUP_SERVER_URL/);
  });
});

describe('buildIsolationAllowlist — TURN relay', () => {
  const env = { TURN_HOST: '198.51.100.20', TURN_TLS_HOST: 'relay.example.test' };

  it('includes TURN_HOST and TURN_TLS_HOST (udp+tcp, 3478/5349) only when remoteRelay', () => {
    const on = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: true, env });
    expect(on).toContainEqual({ kind: 'cidr', cidr: '198.51.100.20/32', proto: 'udp+tcp', ports: [3478, 5349], scope: 'breeze' });
    expect(on).toContainEqual({ kind: 'host', host: 'relay.example.test', proto: 'udp+tcp', ports: [3478, 5349], scope: 'breeze' });

    const off = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env });
    expect(off.some((e) => (e.kind === 'cidr' && e.cidr.startsWith('198.51.100.20')) || (e.kind === 'host' && e.host === 'relay.example.test')))
      .toBe(false);
  });

  it('honours TURN_PORT / TURN_TLS_PORT', () => {
    const list = buildIsolationAllowlist({
      serverUrl: SERVER, remoteRelay: true, env: { TURN_HOST: 'relay.example.test', TURN_PORT: '3479', TURN_TLS_PORT: '443' },
    });
    expect(list).toContainEqual({ kind: 'host', host: 'relay.example.test', proto: 'udp+tcp', ports: [443, 3479], scope: 'breeze' });
  });

  it('adds nothing for the relay when no TURN host is configured', () => {
    const list = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: true, env: noEnv });
    expect(list.every((e) => e.proto === 'tcp')).toBe(true);
  });
});

describe('buildIsolationAllowlist — DoH and scope', () => {
  it('includes every ECH DoH endpoint host on tcp/443', () => {
    const list = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: noEnv });
    for (const url of ECH_DOH_ENDPOINT_URLS) {
      expect(list).toContainEqual({ kind: 'host', host: new URL(url).hostname, proto: 'tcp', ports: [443], scope: 'breeze' });
    }
  });

  it("gives every server-built entry scope 'breeze'; scope 'any' only ever comes from policyExtras", () => {
    const extra: IsolationAllowEntry = { kind: 'cidr', cidr: '203.0.113.0/24', proto: 'tcp', ports: [443], scope: 'any' };
    const env = { AGENT_BACKUP_SERVER_URL: 'https://backup.example.test', TURN_HOST: 'relay.example.test' };
    const bare = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: true, env });
    expect(bare.every((e) => e.scope === 'breeze')).toBe(true);
    const withExtra = buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: true, env, policyExtras: [extra] });
    expect(withExtra.filter((e) => e.scope === 'any')).toEqual([extra]);
  });

  it('refuses a malformed policy extra instead of sending it', () => {
    const bad = { kind: 'cidr', cidr: '0.0.0.0/0', proto: 'tcp', ports: [443], scope: 'any' } as unknown as IsolationAllowEntry;
    expect(() => buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: noEnv, policyExtras: [bad] })).toThrow(/policyExtras/);
  });

  it('throws a typed error that names the misconfigured source', () => {
    const attempt = (env: Record<string, string>, remoteRelay = true) => {
      try {
        buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay, env });
        return null;
      } catch (err) {
        return err;
      }
    };
    const bad = attempt({ TURN_HOST: 'turn:relay.example.test:3478' });
    expect(bad).toBeInstanceOf(IsolationAllowlistError);
    expect(bad).toMatchObject({ source: 'TURN_HOST' });
    expect(attempt({ TURN_HOST: 'relay.example.test', TURN_PORT: 'abc' })).toMatchObject({ source: 'TURN_PORT' });
    expect(attempt({ AGENT_BACKUP_SERVER_URL: 'nope' }, false)).toMatchObject({ source: 'AGENT_BACKUP_SERVER_URL' });
  });

  it(`refuses more than ${NETWORK_ISOLATION_LIMITS.maxAllowEntries} entries rather than emit a block the agent schema rejects`, () => {
    const extras: IsolationAllowEntry[] = Array.from({ length: NETWORK_ISOLATION_LIMITS.maxAllowEntries }, (_, i) => ({
      kind: 'host', host: `extra${i}.example.test`, proto: 'tcp', ports: [443], scope: 'any',
    }));
    expect(() => buildIsolationAllowlist({ serverUrl: SERVER, remoteRelay: false, env: noEnv, policyExtras: extras }))
      .toThrow(IsolationAllowlistError);
  });

  it('merges duplicate destinations and every entry passes the wire schema', () => {
    const list = buildIsolationAllowlist({
      serverUrl: SERVER, remoteRelay: false, env: { AGENT_BACKUP_SERVER_URL: 'https://control.example.test:8443' },
    });
    expect(hostEntries(list).filter((e) => e.host === 'control.example.test')).toEqual([
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443, 8443], scope: 'breeze' },
    ]);
    for (const entry of list) expect(isolationAllowEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(true);
  });
});
