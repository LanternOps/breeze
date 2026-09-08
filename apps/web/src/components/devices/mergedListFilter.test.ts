import { describe, it, expect } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';
import type { Device } from './DeviceList';
import {
  evaluateNetworkAssetFilter,
  matchesMergedListFilters,
  summarizeHiddenNonAgentDevices,
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

const manual = (extra: Partial<Device> = {}): Device => ({
  id: 'c0000000-0000-0000-0000-000000000001',
  deviceClass: 'manual',
  assetType: 'printer',
  hostname: 'spare-printer',
  os: '' as Device['os'],
  osVersion: '',
  status: 'unknown',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '',
  orgId: 'org-1',
  orgName: '',
  siteId: 'site-1',
  siteName: '',
  agentVersion: '',
  tags: [],
  serialNumber: 'SN-123',
  assetTag: 'TAG-9',
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

  it('search matches serial number and asset tag (manual assets)', () => {
    const base = { serverFilterIds: null, advancedFilter: null, includeDecommissioned: false };
    expect(matchesMergedListFilters(manual(), { ...base, query: 'sn-123' })).toBe(true);
    expect(matchesMergedListFilters(manual(), { ...base, query: 'tag-9' })).toBe(true);
    expect(matchesMergedListFilters(manual(), { ...base, query: 'no-match' })).toBe(false);
  });

  it('hides decommissioned rows unless asked for', () => {
    const base = { serverFilterIds: null, advancedFilter: null, query: '' };
    expect(matchesMergedListFilters(agent({ status: 'decommissioned' }), { ...base, includeDecommissioned: false })).toBe(false);
    expect(matchesMergedListFilters(agent({ status: 'decommissioned' }), { ...base, includeDecommissioned: true })).toBe(true);
  });
});

describe('summarizeHiddenNonAgentDevices', () => {
  it('counts network rows dropped only because the filter uses agent-only fields, with the field list', () => {
    const group = and({ field: 'status', operator: 'equals', value: 'online' }, { field: 'patches.pending', operator: 'equals', value: 'yes' });
    const s = summarizeHiddenNonAgentDevices([net(), net({ id: 'b2', status: 'offline' }), agent()], { serverFilterIds: null, advancedFilter: group, includeDecommissioned: false, query: '', vpn: 'all' });
    // The offline one fails on status (an applicable field), so it is not "hidden by agent-only".
    expect(s).toEqual({ count: 1, fields: ['patches.pending'], classes: ['network'] });
  });

  it('is empty with no filter', () => {
    expect(summarizeHiddenNonAgentDevices([net()], { serverFilterIds: null, advancedFilter: null, includeDecommissioned: false, query: '', vpn: 'all' })).toEqual({ count: 0, fields: [], classes: [] });
  });

  it('counts and names a manual row hidden by an agent-only filter — never silently dropped', () => {
    const group = and({ field: 'agentVersion', operator: 'equals', value: '0.70.0' });
    const s = summarizeHiddenNonAgentDevices([manual()], { serverFilterIds: null, advancedFilter: group, includeDecommissioned: false, query: '', vpn: 'all' });
    expect(s).toEqual({ count: 1, fields: ['agentVersion'], classes: ['manual'] });
  });

  it('names both classes when both network and manual rows are hidden by the same agent-only filter', () => {
    const group = and({ field: 'agentVersion', operator: 'equals', value: '0.70.0' });
    const s = summarizeHiddenNonAgentDevices([net(), manual()], { serverFilterIds: null, advancedFilter: group, includeDecommissioned: false, query: '', vpn: 'all' });
    expect(s.count).toBe(2);
    expect(s.classes.sort()).toEqual(['manual', 'network']);
  });
});

describe('evaluateNetworkAssetFilter — manual asset field dispatch', () => {
  it('matches on the fields a manual asset can answer', () => {
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'contains', value: 'printer' }), manual()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'isEmpty', value: '' }), manual()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'deviceRole', operator: 'equals', value: 'printer' }), manual()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'orgId', operator: 'equals', value: 'org-1' }), manual()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'siteId', operator: 'equals', value: 'site-1' }), manual()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'hardware.manufacturer', operator: 'equals', value: 'HP' }), manual({ manufacturer: 'HP' })).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'hardware.model', operator: 'equals', value: 'LJ-100' }), manual({ model: 'LJ-100' })).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'hardware.serialNumber', operator: 'equals', value: 'SN-123' }), manual()).matches).toBe(true);
  });

  it('reports status, network.*, daysSinceLastSeen, lastSeenAt, osType and agentVersion as inapplicable for a manual asset — never a fabricated match or rejection', () => {
    const inapplicable = ['status', 'network.ipAddress', 'network.macAddress', 'daysSinceLastSeen', 'lastSeenAt', 'osType', 'agentVersion'];
    for (const field of inapplicable) {
      const v = evaluateNetworkAssetFilter(and({ field, operator: 'equals', value: 'x' }), manual());
      expect(v).toEqual({ matches: false, inapplicableFields: [field] });
    }
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

// Review round (2026-09-06): operator names must match the shared FilterOperator
// union, datetime fields need the date operators the UI offers, MAC must be
// mapped, nested groups must recurse, VPN is an agent-only facet that the
// predicate and the hidden-notice both understand.
describe('evaluateNetworkAssetFilter — operator coverage', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

  it('uses the canonical *OrEquals operator names', () => {
    const stale = net({ lastSeen: daysAgo(7.5) });
    expect(evaluateNetworkAssetFilter(and({ field: 'daysSinceLastSeen', operator: 'greaterThanOrEquals', value: 7 }), stale).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'daysSinceLastSeen', operator: 'lessThanOrEquals', value: 7 }), stale).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'daysSinceLastSeen', operator: 'between', value: { from: 7, to: 8 } }), stale).matches).toBe(true);
  });

  it('supports the datetime operators on lastSeenAt', () => {
    const fresh = net();
    const stale = net({ lastSeen: daysAgo(10) });
    const within1d = and({ field: 'lastSeenAt', operator: 'withinLast', value: { amount: 1, unit: 'days' } });
    expect(evaluateNetworkAssetFilter(within1d, fresh).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(within1d, stale).matches).toBe(false);
    const notWithin = and({ field: 'lastSeenAt', operator: 'notWithinLast', value: { amount: 1, unit: 'weeks' } });
    expect(evaluateNetworkAssetFilter(notWithin, stale).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(notWithin, fresh).matches).toBe(false);
    const between = and({ field: 'lastSeenAt', operator: 'between', value: { from: new Date(daysAgo(11)), to: new Date(daysAgo(9)) } });
    expect(evaluateNetworkAssetFilter(between, stale).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(between, fresh).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'lastSeenAt', operator: 'before', value: daysAgo(5) }), stale).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'lastSeenAt', operator: 'after', value: daysAgo(5) }), fresh).matches).toBe(true);
  });

  it('matches MAC address for network rows', () => {
    const sw = net({ macAddress: '00:1C:73:AB:12:01' });
    expect(evaluateNetworkAssetFilter(and({ field: 'network.macAddress', operator: 'startsWith', value: '00:1c:73' }), sw).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'network.macAddress', operator: 'equals', value: 'ff:ff' }), sw).matches).toBe(false);
  });

  it('covers the array, string and regex operators', () => {
    const tagged = net({ tags: ['core', 'idf-1'] });
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'hasAny', value: ['idf-1', 'x'] }), tagged).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'hasAll', value: ['idf-1', 'x'] }), tagged).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'tags', operator: 'notContains', value: 'core' }), tagged).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'endsWith', value: '-SW' }), net()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'notEquals', value: 'core-sw' }), net()).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'matches', value: '^core-' }), net()).matches).toBe(true);
    expect(evaluateNetworkAssetFilter(and({ field: 'hostname', operator: 'matches', value: '(' }), net()).matches).toBe(false);
    expect(evaluateNetworkAssetFilter(and({ field: 'siteId', operator: 'notIn', value: ['site-1'] }), net()).matches).toBe(false);
  });

  it('recurses into nested groups and bubbles agent-only fields out of them', () => {
    const inner = or({ field: 'status', operator: 'equals', value: 'offline' }, { field: 'alerts.critical', operator: 'equals', value: 'yes' });
    const outer = and(inner, { field: 'hostname', operator: 'contains', value: 'core' });
    expect(evaluateNetworkAssetFilter(outer, net())).toEqual({ matches: false, inapplicableFields: ['alerts.critical'] });
    expect(evaluateNetworkAssetFilter(outer, net({ status: 'offline' })).matches).toBe(true);
  });

  it('does not blame agent-only fields when an applicable condition already rejects the row', () => {
    const v = evaluateNetworkAssetFilter(
      and({ field: 'status', operator: 'equals', value: 'offline' }, { field: 'patches.pending', operator: 'equals', value: 'yes' }),
      net(),
    );
    expect(v).toEqual({ matches: false, inapplicableFields: [] });
  });
});

describe('VPN facet in the shared predicate', () => {
  const base = { serverFilterIds: null, advancedFilter: null, includeDecommissioned: false, query: '' };
  const vpnAgent = agent({ activeVpns: [{ provider: 'tailscale', active: true }] as Device['activeVpns'] });

  it('agent rows match by active VPN and provider; network rows never match a VPN facet', () => {
    expect(matchesMergedListFilters(vpnAgent, { ...base, vpn: 'any' })).toBe(true);
    expect(matchesMergedListFilters(vpnAgent, { ...base, vpn: 'tailscale' })).toBe(true);
    expect(matchesMergedListFilters(vpnAgent, { ...base, vpn: 'wireguard' })).toBe(false);
    expect(matchesMergedListFilters(agent(), { ...base, vpn: 'any' })).toBe(false);
    expect(matchesMergedListFilters(net(), { ...base, vpn: 'any' })).toBe(false);
    expect(matchesMergedListFilters(net(), { ...base, vpn: 'all' })).toBe(true);
    // A manual asset has no VPN client either — same rule as network.
    expect(matchesMergedListFilters(manual(), { ...base, vpn: 'any' })).toBe(false);
    expect(matchesMergedListFilters(manual(), { ...base, vpn: 'all' })).toBe(true);
  });

  it('the hidden-network summary names the VPN facet and skips rows hidden by search or decommission', () => {
    const rows = [net(), net({ id: 'b2', hostname: 'other' }), net({ id: 'b3', status: 'decommissioned' })];
    // The decommissioned row is hidden by an ordinary rule, so it is not blamed on the VPN facet.
    expect(summarizeHiddenNonAgentDevices(rows, { ...base, vpn: 'any' })).toEqual({ count: 2, fields: ['vpn'], classes: ['network'] });
    expect(summarizeHiddenNonAgentDevices(rows, { ...base, vpn: 'any', query: 'core' })).toEqual({ count: 1, fields: ['vpn'], classes: ['network'] });
    const patches = and({ field: 'patches.pending', operator: 'equals', value: 'yes' });
    expect(summarizeHiddenNonAgentDevices(rows, { ...base, advancedFilter: patches, vpn: 'all' })).toEqual({ count: 2, fields: ['patches.pending'], classes: ['network'] });
  });
});
