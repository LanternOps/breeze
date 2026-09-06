import { describe, it, expect } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';
import type { Device } from './DeviceList';
import {
  evaluateNetworkAssetFilter,
  matchesMergedListFilters,
  summarizeHiddenNetworkDevices,
  sortByDisplayName,
} from './mergedListFilter';

// The server-side filter engine (`POST /filters/preview`) only knows the agent
// `devices` table, so a network row's id can never be in the resolved id set.
// Network rows are evaluated client-side against the same condition group
// for the fields a discovered asset actually has; conditions on agent-only
// fields (patches, alerts, metrics, OS…) mark the row "hidden by an agent-only
// filter" so the page can say so instead of silently dropping it.

const net = (extra: Partial<Device> = {}): Device => ({
  id: 'b0000000-0000-0000-0000-000000000001',
  deviceClass: 'network',
  assetType: 'switch',
  hostname: 'core-sw',
  os: '' as Device['os'],
  osVersion: '',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: '',
  siteId: 'site-1',
  siteName: '',
  agentVersion: '',
  tags: [],
  lanIp: '10.20.0.2',
  ...extra,
});

const agent = (extra: Partial<Device> = {}): Device => ({
  id: 'a0000000-0000-0000-0000-000000000001',
  deviceClass: 'agent',
  hostname: 'win-box',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 40,
  ramPercent: 50,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.70.0',
  tags: ['x'],
  ...extra,
});

const and = (...conditions: FilterConditionGroup['conditions']): FilterConditionGroup => ({ operator: 'AND', conditions });
const or = (...conditions: FilterConditionGroup['conditions']): FilterConditionGroup => ({ operator: 'OR', conditions });

describe('evaluateNetworkAssetFilter', () => {
  it('matches the Online chip for an online network device and rejects it for Offline', () => {
    expect(evaluateNetworkAssetFilter(and({ field: 'status', operator: 'equals', value: 'online' }), net())).toEqual({ matches: true, inapplicableFields: [] });
    expect(evaluateNetworkAssetFilter(and({ field: 'status', operator: 'equals', value: 'offline' }), net()).matches).toBe(false);
  });

  it('treats the Servers chip as an asset-type question for network rows', () => {
    const servers = and({ field: 'deviceRole', operator: 'equals', value: 'server' });
    expect(evaluateNetworkAssetFilter(servers, net({ assetType: 'server' })).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(servers, net({ assetType: 'switch' })).matches).toBe(false);
  });

  it('reports agent-only fields as inapplicable instead of silently failing', () => {
    const v = evaluateNetworkAssetFilter(and({ field: 'patches.pending', operator: 'equals', value: 'yes' }), net());
    expect(v.matches).toBe(false);
    expect(v.inapplicableFields).toEqual(['patches.pending']);
  });

  it('AND with one applicable match and one agent-only condition is hidden-by-agent-only', () => {
    const v = evaluateNetworkAssetFilter(
      and({ field: 'status', operator: 'equals', value: 'online' }, { field: 'metrics.diskPercent', operator: 'greaterThan', value: 90 }),
      net(),
    );
    expect(v.matches).toBe(false);
    expect(v.inapplicableFields).toEqual(['metrics.diskPercent']);
  });

  it('OR matches on any applicable branch and only reports agent-only fields when nothing matched', () => {
    const group = or({ field: 'alerts.critical', operator: 'equals', value: 'yes' }, { field: 'status', operator: 'equals', value: 'online' });
    expect(evaluateNetworkAssetFilter(group, net())).toEqual({ matches: true, inapplicableFields: [] });
    expect(evaluateNetworkAssetFilter(group, net({ status: 'offline' }))).toEqual({ matches: false, inapplicableFields: ['alerts.critical'] });
  });

  it('evaluates tags, hostname, site, IP and days-since-last-seen client-side', () => {
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'isEmpty', value: '' }), net()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'isEmpty', value: '' }), net({ tags: ['a'] })).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'contains', value: 'CORE' }), net()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'siteId', operator: 'in', value: ['site-1', 'site-9'] }), net()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'network.ipAddress', operator: 'startsWith', value: '10.20' }), net()).matches).toBe(true);
    const stale = net({ lastSeen: new Date(Date.now() - 10 * 86400_000).toISOString() });
    expect(evaluateNetworkAssetFilter(and({ field: 'daysSinceLastSeen', operator: 'greaterThan', value: 7 }), stale).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'daysSinceLastSeen', operator: 'greaterThan', value: 7 }), net()).matches).toBe(false);
  });

  it('a null group matches everything', () => {
    expect(evaluateNetworkAssetFilter(null, net())).toEqual({ matches: true, inapplicableFields: [] });
  });
});

describe('matchesMergedListFilters', () => {
  const online = and({ field: 'status', operator: 'equals', value: 'online' });

  it('keeps agent rows on the server id set and network rows on the client evaluator', () => {
    const ctx = { serverFilterIds: new Set([agent().id]), advancedFilter: online, includeDecommissioned: false, query: '' };
    expect(matchesMergedListFilters(agent(), ctx)).toBe(true);
    expect(matchesMergedListFilters(agent({ id: 'a0000000-0000-0000-0000-000000000009' }), ctx)).toBe(false);
    expect(matchesMergedListFilters(net(), ctx)).toBe(true);
    expect(matchesMergedListFilters(net({ status: 'offline' }), ctx)).toBe(false);
  });

  it('search matches hostname, display name and IP for both classes', () => {
    const base = { serverFilterIds: null, advancedFilter: null, includeDecommissioned: false };
    expect(matchesMergedListFilters(net(), { ...base, query: '10.20.0' })).toBe(true);
    expect(matchesMergedListFilters(agent(), { ...base, query: '10.20.0' })).toBe(false);
    expect(matchesMergedListFilters(agent({ displayName: 'Front Desk' }), { ...base, query: 'front' })).toBe(true);
  });

  it('hides decommissioned rows unless asked for', () => {
    const base = { serverFilterIds: null, advancedFilter: null, query: '' };
    expect(matchesMergedListFilters(agent({ status: 'decommissioned' }), { ...base, includeDecommissioned: false })).toBe(false);
    expect(matchesMergedListFilters(agent({ status: 'decommissioned' }), { ...base, includeDecommissioned: true })).toBe(true);
  });
});

describe('summarizeHiddenNetworkDevices', () => {
  it('counts network rows dropped only because the filter uses agent-only fields, with the field list', () => {
    const group = and({ field: 'status', operator: 'equals', value: 'online' }, { field: 'patches.pending', operator: 'equals', value: 'yes' });
    const s = summarizeHiddenNetworkDevices([net(), net({ id: 'b2', status: 'offline' }), agent()], group);
    // The offline one fails on status (an applicable field), so it is not "hidden by agent-only".
    expect(s).toEqual({ count: 1, fields: ['patches.pending'] });
  });

  it('is empty with no filter', () => {
    expect(summarizeHiddenNetworkDevices([net()], null)).toEqual({ count: 0, fields: [] });
  });
});

describe('sortByDisplayName', () => {
  it('sorts by display name with numeric collation, blanks last, id tiebreak', () => {
    const rows = [
      net({ id: 'z', hostname: 'node-10' }),
      agent({ id: 'y', hostname: 'node-2' }),
      net({ id: 'b', hostname: '' }),
      net({ id: 'a', hostname: '' }),
      agent({ id: 'x', hostname: 'zzz', displayName: 'alpha' }),
    ];
    expect(sortByDisplayName(rows).map((d) => d.id)).toEqual(['x', 'y', 'z', 'a', 'b']);
  });
});
