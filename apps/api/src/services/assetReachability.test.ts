import { describe, expect, it } from 'vitest';
import {
  deriveReachability,
  reachabilityToListStatus,
  type ReachabilityInput,
  type ReachabilityMonitorInput,
} from './assetReachability';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function input(overrides: Partial<ReachabilityInput> = {}): ReachabilityInput {
  return {
    asset: {
      isOnline: false,
      statusObservedAt: null,
      statusSource: null,
      lastSeenAt: null,
      lastProbeAt: null,
      lastProbeStatus: null,
      lastProbeResponseMs: null,
    },
    snmpDevice: null,
    networkMonitors: [],
    scanIntervalSeconds: null,
    ...overrides,
  };
}

function monitor(overrides: Partial<ReachabilityMonitorInput> = {}): ReachabilityMonitorInput {
  return {
    id: 'mon-1',
    monitorType: 'icmp_ping',
    isActive: true,
    lastStatus: 'online',
    lastChecked: ago(MIN),
    lastResponseMs: 4,
    pollingInterval: 60,
    ...overrides,
  };
}

describe('deriveReachability — each source alone', () => {
  it('a fresh network check says responding and names itself', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor()] }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('network_check');
    expect(r.observedAt).toBe(ago(MIN));
    expect(r.detail.networkCheck).toEqual({ state: 'online', observedAt: ago(MIN), responseMs: 4, monitorId: 'mon-1' });
  });

  it('a degraded network check is still a positive host observation', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'degraded' })] }), NOW);
    expect(r.state).toBe('responding');
    expect(r.detail.networkCheck!.state).toBe('degraded');
  });

  it('an offline network check says not_responding', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'offline', lastResponseMs: null })] }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('network_check');
  });

  it('a fresh SNMP success is a positive observation (an SNMP reply proves reachability)', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: 'online', lastPolled: ago(2 * MIN), lastPollAttemptedAt: ago(2 * MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('snmp');
    expect(r.detail.snmp).toEqual({ state: 'ok', observedAt: ago(2 * MIN), consecutiveFailures: 0 });
  });

  it('an ok probe is a positive observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 3 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('probe');
    expect(r.detail.probe).toEqual({ state: 'ok', observedAt: ago(MIN), responseMs: 3 });
  });

  it('a scan sighting is a positive observation dated by status_observed_at', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(HOUR), statusSource: 'scan', lastSeenAt: ago(HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(HOUR), source: 'scan' });
  });

  it('a UniFi sighting names unifi, not scan', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(10 * MIN), statusSource: 'unifi', lastSeenAt: ago(10 * MIN) },
    }), NOW);
    expect(r.source).toBe('unifi');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(10 * MIN), source: 'unifi' });
  });

  it('a dated disappeared-sweep verdict is a negative observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: false, statusObservedAt: ago(30 * MIN), statusSource: 'scan', lastSeenAt: ago(5 * HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'missed', observedAt: ago(30 * MIN), source: 'scan' });
  });
});

describe('deriveReachability — positive vs negative recency', () => {
  it('the more recent of a positive and a negative wins (positive newer)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(2 * MIN), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('probe');
  });

  it('the more recent of a positive and a negative wins (negative newer)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(3 * MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(MIN), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('network_check');
    // Both details are still reported — the UI explains the disagreement.
    expect(r.detail.probe!.state).toBe('ok');
    expect(r.detail.networkCheck!.state).toBe('offline');
  });
});

describe('deriveReachability — freshness windows', () => {
  it('a network check older than 2x its interval (min 5 min) stops counting', () => {
    const stale = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 60, lastChecked: ago(6 * MIN) })],
    }), NOW);
    expect(stale.state).toBe('unverified');
    expect(stale.lastKnown).toEqual({ state: 'responding', source: 'network_check', observedAt: ago(6 * MIN) });

    const fresh = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 60, lastChecked: ago(4 * MIN) })],
    }), NOW);
    expect(fresh.state).toBe('responding');
  });

  it('a 600 s network check uses 2x its interval, not the 5 min floor', () => {
    const r = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 600, lastChecked: ago(19 * MIN) })],
    }), NOW);
    expect(r.state).toBe('responding');
  });

  it('a probe older than 15 min stops counting', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(16 * MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.lastKnown!.source).toBe('probe');
  });

  it('a UniFi sighting older than 60 min stops counting', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(61 * MIN), statusSource: 'unifi', lastSeenAt: ago(61 * MIN) },
    }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('a scan uses 2x the profile interval when known, else 24 h', () => {
    const scoped = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(3 * HOUR), statusSource: 'scan', lastSeenAt: ago(3 * HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(scoped.state).toBe('unverified');

    const defaulted = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(3 * HOUR), statusSource: 'scan', lastSeenAt: ago(3 * HOUR) },
      scanIntervalSeconds: null,
    }), NOW);
    expect(defaulted.state).toBe('responding');
  });

  it('an SNMP success older than 2x its interval (min 10 min) stops counting', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: 'online', lastPolled: ago(11 * MIN), lastPollAttemptedAt: ago(11 * MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.lastKnown!.source).toBe('snmp');
  });
});

describe('deriveReachability — sources that never contribute', () => {
  it.each([['http_check'], ['dns_check']] as const)('%s monitors are ignored entirely', (monitorType) => {
    const r = deriveReachability(input({
      networkMonitors: [monitor({ monitorType, lastStatus: 'offline', lastChecked: ago(MIN), lastResponseMs: null })],
    }), NOW);
    // A TLS or DNS failure is not host evidence (spec §4.1).
    expect(r.state).toBe('unverified');
    expect(r.detail.networkCheck).toBeUndefined();
  });

  it('an inactive monitor is ignored', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ isActive: false })] }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('an unknown monitor status is ignored', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'unknown' })] }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('an inactive SNMP device contributes nothing at all (pausing is not a device fact)', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: false, lastStatus: 'online', lastPolled: ago(MIN), lastPollAttemptedAt: ago(MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.detail.snmp).toBeUndefined();
  });

  it('an undated is_online=false is NOT a negative observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: false, statusObservedAt: null, statusSource: null, lastSeenAt: ago(19 * HOUR) },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.lastKnown).toBeNull();
    expect(r.detail.scan).toBeUndefined();
  });

  it('an undated is_online=true falls back to last_seen_at and is labelled scan', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: null, statusSource: null, lastSeenAt: ago(2 * HOUR) },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(2 * HOUR), source: 'scan' });
  });
});

describe('deriveReachability — SNMP failures never say not_responding on their own', () => {
  it.each([
    ['offline', 'failing'],
    ['warning', 'failing'],
    ['no_template', 'no_template'],
    ['no_agent_in_site', 'no_agent'],
    ['asset_missing', 'asset_moved'],
    ['asset_no_site', 'asset_moved'],
  ] as const)('last_status %s reports detail.snmp %s and leaves state unverified', (lastStatus, detailState) => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus, lastPolled: null, lastPollAttemptedAt: ago(MIN), pollingInterval: 300, consecutiveFailures: 3 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.detail.snmp).toEqual({ state: detailState, observedAt: ago(MIN), consecutiveFailures: 3 });
  });

  it('a never-polled SNMP device reports never_polled', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: null, lastPolled: null, lastPollAttemptedAt: null, pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.detail.snmp).toEqual({ state: 'never_polled', observedAt: null, consecutiveFailures: 0 });
    expect(r.state).toBe('unverified');
  });

  it('an SNMP failure does not veto a fresh positive from another source', () => {
    const r = deriveReachability(input({
      networkMonitors: [monitor()],
      snmpDevice: { isActive: true, lastStatus: 'offline', lastPolled: null, lastPollAttemptedAt: ago(30_000), pollingInterval: 300, consecutiveFailures: 5 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('network_check');
    expect(r.detail.snmp!.state).toBe('failing');
  });
});

describe('deriveReachability — probe pending', () => {
  it('a young pending probe reports pending and makes no claim', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(30_000), lastProbeStatus: 'pending', lastProbeResponseMs: null },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.detail.probe).toEqual({ state: 'pending', observedAt: ago(30_000), responseMs: null });
  });

  it('a pending probe older than 2 min is treated as failed (the agent never answered)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(3 * MIN), lastProbeStatus: 'pending', lastProbeResponseMs: null },
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('probe');
    expect(r.detail.probe!.state).toBe('failed');
  });
});

describe('deriveReachability — unverified carries lastKnown of any age', () => {
  it('picks the freshest observation of any age', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(19 * HOUR), statusSource: 'scan', lastSeenAt: ago(19 * HOUR) },
      scanIntervalSeconds: 3600,
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(30 * HOUR), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.observedAt).toBeNull();
    expect(r.lastKnown).toEqual({ state: 'responding', source: 'scan', observedAt: ago(19 * HOUR) });
  });

  it('nothing at all is unverified with a null lastKnown', () => {
    const r = deriveReachability(input(), NOW);
    expect(r).toEqual({ state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} });
  });
});

describe('reachabilityToListStatus', () => {
  it.each([
    ['responding', 'online'],
    ['not_responding', 'offline'],
    ['unverified', 'unknown'],
  ] as const)('%s maps to %s', (state, expected) => {
    expect(reachabilityToListStatus({ state, source: null, observedAt: null, lastKnown: null, detail: {} })).toBe(expected);
  });
});
