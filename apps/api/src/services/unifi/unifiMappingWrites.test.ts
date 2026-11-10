import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../unassignedPool/protectedOrg', () => ({ isHoldingOrg: vi.fn(async () => false) }));

import { writeRouteAudit } from '../auditEvents';
import type { UnifiCollectorAuthority, UnifiMappingSnapshot } from '../topology/unifiAuthority';
import {
  diffUnifiCollectors,
  diffUnifiMappings,
  writeUnifiControllerAudits,
  writeUnifiMappingAudits,
  type UnifiMappingChange,
} from './unifiMappingWrites';

const INTEGRATION_ID = '44444444-4444-4444-4444-444444444444';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const SITE_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const SITE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ctx = {} as Parameters<typeof writeUnifiMappingAudits>[0];

function mapping(overrides: Partial<UnifiMappingSnapshot> & Pick<UnifiMappingSnapshot, 'unifiHostId' | 'unifiSiteId'>): UnifiMappingSnapshot {
  return { id: `m-${overrides.unifiHostId}-${overrides.unifiSiteId}`, integrationId: INTEGRATION_ID, orgId: ORG_A, siteId: SITE_A, ...overrides };
}

function collector(overrides: Partial<UnifiCollectorAuthority> = {}): UnifiCollectorAuthority {
  return {
    id: 'c1', integrationId: INTEGRATION_ID, orgId: ORG_A, siteId: SITE_A, unifiHostId: null,
    collectorDeviceId: 'd1', controllerUrl: 'https://controller.example:8443/network', isEnabled: true, topologyGeneration: 0,
    ...overrides,
  };
}

describe('diffUnifiMappings', () => {
  it('a new row is a map to its org and site', () => {
    const after = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1' })];
    expect(diffUnifiMappings([], after)).toEqual([{
      action: 'unifi.site.map', unifiHostId: 'h1', unifiSiteId: 's1',
      orgId: ORG_A, siteId: SITE_A, previousOrgId: null, previousSiteId: null,
    }]);
  });

  it('a changed site in the same org is a map carrying the previous site', () => {
    const before = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1' })];
    const after = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1', siteId: SITE_A2 })];
    expect(diffUnifiMappings(before, after)).toEqual([{
      action: 'unifi.site.map', unifiHostId: 'h1', unifiSiteId: 's1',
      orgId: ORG_A, siteId: SITE_A2, previousOrgId: ORG_A, previousSiteId: SITE_A,
    }]);
  });

  it('a changed org is a map filed under the new org', () => {
    const before = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1' })];
    const after = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1', orgId: ORG_B, siteId: SITE_B })];
    expect(diffUnifiMappings(before, after)).toEqual([{
      action: 'unifi.site.map', unifiHostId: 'h1', unifiSiteId: 's1',
      orgId: ORG_B, siteId: SITE_B, previousOrgId: ORG_A, previousSiteId: SITE_A,
    }]);
  });

  it('a removed row is an unmap filed under the previous org with no site', () => {
    const before = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1' })];
    expect(diffUnifiMappings(before, [])).toEqual([{
      action: 'unifi.site.unmap', unifiHostId: 'h1', unifiSiteId: 's1',
      orgId: ORG_A, siteId: null, previousOrgId: ORG_A, previousSiteId: SITE_A,
    }]);
  });

  it('an unchanged row gives no entry', () => {
    const rows = [mapping({ unifiHostId: 'h1', unifiSiteId: 's1' })];
    expect(diffUnifiMappings(rows, rows.map((r) => ({ ...r })))).toEqual([]);
  });

  it('keys by host and site, so the same site id under two hosts is two rows', () => {
    const before = [mapping({ unifiHostId: 'h1', unifiSiteId: 'default' })];
    const after = [
      mapping({ unifiHostId: 'h1', unifiSiteId: 'default' }),
      mapping({ unifiHostId: 'h2', unifiSiteId: 'default', orgId: ORG_B, siteId: SITE_B }),
    ];
    expect(diffUnifiMappings(before, after)).toEqual([expect.objectContaining({ action: 'unifi.site.map', unifiHostId: 'h2', orgId: ORG_B })]);
  });
});

describe('writeUnifiMappingAudits', () => {
  beforeEach(() => vi.mocked(writeRouteAudit).mockClear());

  it('writes one audit per change with the host/site name, every change field, the integration and the meta', () => {
    const changes: UnifiMappingChange[] = [
      { action: 'unifi.site.map', unifiHostId: 'h1', unifiSiteId: 's1', orgId: ORG_B, siteId: SITE_B, previousOrgId: ORG_A, previousSiteId: SITE_A },
      { action: 'unifi.site.unmap', unifiHostId: 'h1', unifiSiteId: 's2', orgId: ORG_A, siteId: null, previousOrgId: ORG_A, previousSiteId: SITE_A },
    ];
    writeUnifiMappingAudits(ctx, INTEGRATION_ID, changes, () => ({ source: 'manual', sourceVerified: true, matchTier: null, matchKey: null }));

    expect(writeRouteAudit).toHaveBeenCalledTimes(2);
    expect(writeRouteAudit).toHaveBeenNthCalledWith(1, ctx, {
      orgId: ORG_B,
      action: 'unifi.site.map',
      resourceType: 'unifi_site_mapping',
      resourceName: 'h1/s1',
      details: {
        integrationId: INTEGRATION_ID,
        unifiHostId: 'h1', unifiSiteId: 's1', orgId: ORG_B, siteId: SITE_B, previousOrgId: ORG_A, previousSiteId: SITE_A,
        source: 'manual', sourceVerified: true, matchTier: null, matchKey: null,
      },
    });
    expect(writeRouteAudit).toHaveBeenNthCalledWith(2, ctx, expect.objectContaining({
      orgId: ORG_A, action: 'unifi.site.unmap', resourceName: 'h1/s2',
    }));
  });

  it('writes nothing for no changes', () => {
    writeUnifiMappingAudits(ctx, INTEGRATION_ID, [], () => ({ source: 'manual', sourceVerified: true, matchTier: null, matchKey: null }));
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('diffUnifiCollectors', () => {
  it('new → register, re-pointed → register, removed → remove, unchanged → nothing', () => {
    const kept = collector({ id: 'keep' });
    const moved = collector({ id: 'moved' });
    const gone = collector({ id: 'gone' });
    const added = collector({ id: 'added' });
    const diff = diffUnifiCollectors([kept, moved, gone], [{ ...kept }, { ...moved, siteId: SITE_A2 }, added]);
    expect(diff.map((d) => [d.action, d.collector.id])).toEqual([
      ['unifi.controller.register', 'moved'],
      ['unifi.controller.register', 'added'],
      ['unifi.controller.remove', 'gone'],
    ]);
    expect(diff.find((d) => d.collector.id === 'moved')?.collector.siteId).toBe(SITE_A2);
  });
});

describe('writeUnifiControllerAudits', () => {
  beforeEach(() => vi.mocked(writeRouteAudit).mockClear());

  it('audits a register with the controller host only, filed under the collector org', () => {
    const c = collector({ controllerUrl: 'https://controller.example:8443/network?x=1' });
    writeUnifiControllerAudits(ctx, INTEGRATION_ID, [], [c]);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(ctx, {
      orgId: ORG_A,
      action: 'unifi.controller.register',
      resourceType: 'unifi_collector',
      resourceId: 'c1',
      resourceName: 'controller.example:8443',
      details: {
        integrationId: INTEGRATION_ID, collectorId: 'c1', transport: 'agent',
        controllerHost: 'controller.example:8443', siteId: SITE_A, collectorDeviceId: 'd1', unifiHostId: null,
      },
    });
  });

  it('audits a remove under the org the collector had', () => {
    writeUnifiControllerAudits(ctx, INTEGRATION_ID, [collector({ orgId: ORG_B })], []);
    expect(writeRouteAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ orgId: ORG_B, action: 'unifi.controller.remove' }));
  });

  it('a re-register that changes no column is still audited: the PUT rewrote its API key', () => {
    const c = collector();
    writeUnifiControllerAudits(ctx, INTEGRATION_ID, [c], [{ ...c }], c.id);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: 'unifi.controller.register', resourceId: 'c1' }));
  });

  it('an unparseable stored URL records a null host rather than throwing', () => {
    writeUnifiControllerAudits(ctx, INTEGRATION_ID, [], [collector({ controllerUrl: 'not a url' })]);
    expect(writeRouteAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      resourceName: null,
      details: expect.objectContaining({ controllerHost: null }),
    }));
  });

  it('no change and no rewritten collector writes nothing', () => {
    const c = collector();
    writeUnifiControllerAudits(ctx, INTEGRATION_ID, [c], [{ ...c }]);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
