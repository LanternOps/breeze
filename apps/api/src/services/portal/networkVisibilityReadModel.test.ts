import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  byTable: {} as Record<string, unknown[]>,
  queried: [] as string[],
  reachability: new Map<string, unknown>(),
  reachabilityError: null as Error | null,
}));

vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    let table = '';
    chain.from = vi.fn((t: Table) => {
      table = getTableName(t);
      state.queried.push(table);
      return chain;
    });
    for (const method of ['innerJoin', 'where', 'orderBy']) chain[method] = vi.fn(() => chain);
    chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(state.byTable[table] ?? []).then(resolve, reject);
    return chain;
  };
  return { db: { select: vi.fn(makeChain), selectDistinctOn: vi.fn(makeChain) } };
});

vi.mock('../assetReachabilityLoader', () => ({
  loadReachability: vi.fn(async () => {
    if (state.reachabilityError) throw state.reachabilityError;
    return state.reachability;
  }),
}));

import { networkSiteHealth } from './networkVisibilityReadModel';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const ORG = '22222222-2222-2222-2222-222222222222';
const SITE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function asset(id: string, siteId: string, siteName: string, approvalStatus = 'approved') {
  return { id, siteId, siteName, approvalStatus };
}

function reach(state_: 'responding' | 'not_responding' | 'unverified', snmp?: 'ok' | 'stale') {
  return { state: state_, detail: snmp ? { snmp: { state: snmp } } : {} };
}

function offlineResult(monitorId: string, siteId: string | null, assetId: string | null, ageMs = 60_000) {
  return {
    monitorId,
    status: 'offline',
    timestamp: new Date(NOW.getTime() - ageMs),
    pollingInterval: 60,
    siteId,
    assetId,
  };
}

describe('networkSiteHealth (CPEV-W2)', () => {
  beforeEach(() => {
    state.byTable = {};
    state.queried = [];
    state.reachability = new Map();
    state.reachabilityError = null;
  });

  it('returns no_data when the org has no non-dismissed asset', async () => {
    state.byTable.discovered_assets = [asset('d1', SITE_A, 'HQ', 'dismissed')];
    expect(await networkSiteHealth(ORG, false, NOW)).toEqual({ dataStatus: 'no_data', data: [] });
    expect(state.queried).not.toContain('network_monitors');
  });

  it('propagates a reachability failure instead of returning ok with zeros', async () => {
    state.byTable.discovered_assets = [asset('a1', SITE_A, 'HQ')];
    state.reachabilityError = new Error('reachability down');
    await expect(networkSiteHealth(ORG, false, NOW)).rejects.toThrow('reachability down');
  });

  it('aggregates per site, excludes dismissed assets and omits alert fields when alerts are off', async () => {
    state.byTable.discovered_assets = [
      asset('a1', SITE_A, 'Alpha'),
      asset('a2', SITE_A, 'Alpha'),
      asset('a3', SITE_A, 'Alpha'),
      asset('a4', SITE_A, 'Alpha', 'dismissed'),
      asset('b1', SITE_B, 'Beta'),
    ];
    state.reachability = new Map<string, unknown>([
      ['a1', reach('responding', 'ok')],
      ['a2', reach('not_responding', 'stale')],
      ['a4', reach('responding', 'ok')],
      ['b1', reach('responding')],
    ]);
    // Seed an attributable monitor and an active alert so the alerts query is
    // reachable: only the includeAlerts flag keeps it from running.
    state.byTable.network_monitors = [{ id: 'm-site', siteId: SITE_A, assetId: null }];
    state.byTable.alerts = [{ severity: 'critical', monitorId: 'm-site' }];

    const result = await networkSiteHealth(ORG, false, NOW);

    expect(result.dataStatus).toBe('ok');
    expect(result.data).toEqual([
      {
        siteId: SITE_A,
        siteName: 'Alpha',
        totalAssets: 3,
        onlineAssets: 1,
        offlineAssets: 1,
        unverifiedAssets: 1,
        snmpDevicesPolling: 1,
        monitorsDown: 0,
      },
      {
        siteId: SITE_B,
        siteName: 'Beta',
        totalAssets: 1,
        onlineAssets: 1,
        offlineAssets: 0,
        unverifiedAssets: 0,
        snmpDevicesPolling: 0,
        monitorsDown: 0,
      },
    ]);
    for (const row of result.data) {
      expect(Object.keys(row)).not.toContain('activeAlertCount');
      expect(Object.keys(row)).not.toContain('highestAlertSeverity');
    }
    expect(state.queried).not.toContain('alerts');
  });

  it('attributes down monitors by site_id, else asset site, and drops unattributable ones', async () => {
    state.byTable.discovered_assets = [
      asset('a1', SITE_A, 'Alpha'),
      asset('b1', SITE_B, 'Beta'),
      asset('dismissed-asset', SITE_A, 'Alpha', 'dismissed'),
    ];
    state.byTable.network_monitor_results = [
      offlineResult('m-site', SITE_A, null),
      offlineResult('m-asset-only', null, 'b1'),
      offlineResult('m-none', null, null),
      offlineResult('m-dismissed', SITE_A, 'dismissed-asset'),
      offlineResult('m-stale', SITE_A, null, 3_600_000),
      { ...offlineResult('m-online', SITE_A, null), status: 'online' },
    ];

    const result = await networkSiteHealth(ORG, false, NOW);

    expect(result.data.map((r) => [r.siteId, r.monitorsDown])).toEqual([
      [SITE_A, 1],
      [SITE_B, 1],
    ]);
  });

  it('counts alerts per site, including site-level monitors, and skips dismissed-asset monitors', async () => {
    state.byTable.discovered_assets = [
      asset('a1', SITE_A, 'Alpha'),
      asset('a2', SITE_A, 'Alpha', 'dismissed'),
      asset('b1', SITE_B, 'Beta'),
    ];
    state.byTable.network_monitors = [
      { id: 'm-site', siteId: SITE_A, assetId: null },
      { id: 'm-asset', siteId: null, assetId: 'a1' },
      { id: 'm-dismissed', siteId: null, assetId: 'a2' },
      { id: 'm-dismissed-site', siteId: SITE_A, assetId: 'a2' },
      { id: 'm-none', siteId: null, assetId: null },
    ];
    state.byTable.alerts = [
      { severity: 'low', monitorId: 'm-site' },
      { severity: 'critical', monitorId: 'm-asset' },
      { severity: 'high', monitorId: 'm-dismissed' },
      { severity: 'high', monitorId: 'm-dismissed-site' },
      { severity: 'weird', monitorId: 'm-site' },
    ];

    const result = await networkSiteHealth(ORG, true, NOW);

    expect(result.data).toEqual([
      expect.objectContaining({ siteId: SITE_A, activeAlertCount: 3, highestAlertSeverity: 'critical' }),
      expect.objectContaining({ siteId: SITE_B, activeAlertCount: 0, highestAlertSeverity: null }),
    ]);
  });
});
