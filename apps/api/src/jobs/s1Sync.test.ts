import { describe, expect, it } from 'vitest';
import {
  applyPollFailure,
  dedupeThreatDetections,
  normalizeSeverity,
  normalizeThreatStatus,
  normalizeS1SiteName,
  resolveAgentSyncTarget,
  resolveOrgIdForAgentSite,
  resolveThreatSyncTarget,
  resolveDeviceIdForAgent
} from './s1Sync';

describe('s1Sync helpers', () => {
  it('deduplicates threat detections by SentinelOne threat ID', () => {
    const deduped = dedupeThreatDetections([
      { s1ThreatId: 'threat-a', severity: 'high' },
      { s1ThreatId: 'threat-a', severity: 'high' },
      { s1ThreatId: 'threat-b', severity: 'low' },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.map((row) => row.s1ThreatId)).toEqual(['threat-a', 'threat-b']);
  });

  it('maps provider mitigation statuses to normalized threat states', () => {
    expect(normalizeThreatStatus('resolved')).toBe('resolved');
    expect(normalizeThreatStatus('quarantine_pending')).toBe('quarantined');
    expect(normalizeThreatStatus('in_progress')).toBe('in_progress');
    expect(normalizeThreatStatus('new')).toBe('active');
  });

  it('transitions action polling failures to terminal failure at threshold', () => {
    const first = applyPollFailure({}, new Error('timeout'), 3);
    expect(first.failureCount).toBe(1);
    expect(first.shouldFail).toBe(false);

    const second = applyPollFailure(first.payload, new Error('timeout'), 3);
    expect(second.failureCount).toBe(2);
    expect(second.shouldFail).toBe(false);

    const third = applyPollFailure(second.payload, new Error('timeout'), 3);
    expect(third.failureCount).toBe(3);
    expect(third.shouldFail).toBe(true);
    expect(third.error).toContain('timeout');
  });
});

describe('normalizeSeverity', () => {
  it('maps standard severity strings to canonical values', () => {
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('high')).toBe('high');
    expect(normalizeSeverity('medium')).toBe('medium');
    expect(normalizeSeverity('low')).toBe('low');
  });

  it('handles case-insensitive and compound strings', () => {
    expect(normalizeSeverity('Critical')).toBe('critical');
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity(' Medium ')).toBe('medium');
    expect(normalizeSeverity('High Severity')).toBe('high');
    expect(normalizeSeverity('critical_severity')).toBe('critical');
  });

  it('returns unknown for non-string, empty, or unrecognized inputs', () => {
    expect(normalizeSeverity('')).toBe('unknown');
    expect(normalizeSeverity(null)).toBe('unknown');
    expect(normalizeSeverity(undefined)).toBe('unknown');
    expect(normalizeSeverity(42)).toBe('unknown');
    expect(normalizeSeverity('garbage')).toBe('unknown');
  });
});

describe('resolveDeviceIdForAgent', () => {
  const candidates = {
    byHostname: new Map([
      ['desktop-1', 'device-aaa'],
      ['server-web', 'device-bbb'],
    ]),
    byIp: new Map([
      ['10.0.0.5', 'device-ccc'],
      ['192.168.1.100', 'device-ddd'],
    ]),
  };

  it('matches by hostname (case-insensitive, trimmed)', () => {
    expect(resolveDeviceIdForAgent({ computerName: 'DESKTOP-1' }, candidates)).toBe('device-aaa');
    expect(resolveDeviceIdForAgent({ computerName: ' Server-Web ' }, candidates)).toBe('device-bbb');
  });

  it('matches by IP from network interfaces when hostname does not match', () => {
    const agent = {
      computerName: 'unknown-host',
      networkInterfaces: [
        { inet: ['10.0.0.5'] },
      ],
    };
    expect(resolveDeviceIdForAgent(agent, candidates)).toBe('device-ccc');
  });

  it('searches multiple interfaces and IPs', () => {
    const agent = {
      computerName: 'no-match',
      networkInterfaces: [
        { inet: ['172.16.0.1'] },
        { inet: ['10.99.99.99', '192.168.1.100'] },
      ],
    };
    expect(resolveDeviceIdForAgent(agent, candidates)).toBe('device-ddd');
  });

  it('returns null when no match found', () => {
    const agent = {
      computerName: 'no-match',
      networkInterfaces: [{ inet: ['172.16.0.1'] }],
    };
    expect(resolveDeviceIdForAgent(agent, candidates)).toBeNull();
  });

  it('returns null for agent with no computerName and no networkInterfaces', () => {
    expect(resolveDeviceIdForAgent({}, candidates)).toBeNull();
  });

  it('handles malformed networkInterfaces gracefully', () => {
    const agent = {
      computerName: 'no-match',
      networkInterfaces: [null, 'not-an-object', { inet: 'not-an-array' }, { noInet: true }],
    };
    expect(resolveDeviceIdForAgent(agent, candidates)).toBeNull();
  });

  it('prioritizes hostname match over IP match', () => {
    // Agent hostname matches device-aaa, but IP would match device-ccc
    const agent = {
      computerName: 'desktop-1',
      networkInterfaces: [{ inet: ['10.0.0.5'] }],
    };
    expect(resolveDeviceIdForAgent(agent, candidates)).toBe('device-aaa');
  });
});

describe('SentinelOne site-to-org mapping helpers', () => {
  it('normalizes provider site names for case-insensitive lookup', () => {
    expect(normalizeS1SiteName('  Denver Site  ')).toBe('denver site');
    expect(normalizeS1SiteName('')).toBeNull();
    expect(normalizeS1SiteName(null)).toBeNull();
  });

  it('resolves mapped sites to their target org and falls back to the integration org', () => {
    const mappings = new Map([
      ['denver site', 'org-denver'],
      ['nyc', 'org-nyc'],
    ]);

    expect(resolveOrgIdForAgentSite('Denver Site', 'org-default', mappings)).toBe('org-denver');
    expect(resolveOrgIdForAgentSite('unknown', 'org-default', mappings)).toBe('org-default');
    expect(resolveOrgIdForAgentSite(null, 'org-default', mappings)).toBe('org-default');
  });

  it('uses the mapped org device candidates when resolving an agent', () => {
    const target = resolveAgentSyncTarget(
      { siteName: 'Denver Site', computerName: 'server-1' },
      'org-default',
      new Map([['denver site', 'org-denver']]),
      new Map([
        ['org-default', {
          byHostname: new Map([['server-1', 'device-default']]),
          byIp: new Map(),
        }],
        ['org-denver', {
          byHostname: new Map([['server-1', 'device-denver']]),
          byIp: new Map(),
        }],
      ])
    );

    expect(target).toEqual({ orgId: 'org-denver', deviceId: 'device-denver' });
  });

  it('uses the integration org and null device for unmapped threat agents', () => {
    const mapped = resolveThreatSyncTarget(
      'agent-denver',
      'org-default',
      new Map([['agent-denver', { orgId: 'org-denver', deviceId: 'device-denver' }]])
    );
    const unmapped = resolveThreatSyncTarget(
      'missing-agent',
      'org-default',
      new Map([['agent-denver', { orgId: 'org-denver', deviceId: 'device-denver' }]])
    );

    expect(mapped).toEqual({ orgId: 'org-denver', deviceId: 'device-denver' });
    expect(unmapped).toEqual({ orgId: 'org-default', deviceId: null });
  });
});
