import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSiteAllowedDeviceIds: vi.fn(async () => ['device-before-move']),
  searchFleetLogs: vi.fn(async () => ({
    results: [], total: 0, totalMode: 'exact', limit: 50, offset: 0,
    hasMore: false, nextCursor: null,
  })),
  getLogTrends: vi.fn(async () => ({
    start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z',
    minLevel: 'info', levelDistribution: [], topSources: [], topDevices: [],
    errorTimeline: [], spikes: [], spikeThreshold: 3,
  })),
  getLogAggregation: vi.fn(async () => ({ groupBy: 'device', totals: [], series: [] })),
  detectPatternCorrelation: vi.fn(async () => null),
}));

vi.mock('./aiToolsSiteScope', () => ({
  resolveSiteAllowedDeviceIds: mocks.resolveSiteAllowedDeviceIds,
  SITE_SCOPE_EMPTY_NOTE: 'restricted',
}));
vi.mock('./logSearch', () => ({
  searchFleetLogs: mocks.searchFleetLogs,
  getLogTrends: mocks.getLogTrends,
  getLogAggregation: mocks.getLogAggregation,
  detectPatternCorrelation: mocks.detectPatternCorrelation,
  resolveSingleOrgId: vi.fn(() => 'org-1'),
}));

import { registerEventLogTools } from './aiToolsEventLogs';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

function tools() {
  const registry = new Map<string, AiTool>();
  registerEventLogTools(registry);
  return registry;
}

const auth = {
  user: { id: 'user-1', email: 'u@example.test', name: 'User', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: 'org-1', scope: 'organization',
  accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
  allowedSiteIds: ['site-visible'], canAccessSite: (siteId: string) => siteId === 'site-visible',
} as unknown as AuthContext;

describe('AI event-log tools preserve the live site predicate after device resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes both the stale device snapshot and current site ceiling to every data service', async () => {
    const registry = tools();
    await registry.get('search_logs')!.handler({}, auth);
    await registry.get('get_log_trends')!.handler({ groupBy: 'device' }, auth);
    await registry.get('detect_log_correlations')!.handler({ pattern: 'synthetic' }, auth);

    const ceiling = {
      allowedDeviceIds: ['device-before-move'],
      allowedSiteIds: ['site-visible'],
    };
    expect(mocks.searchFleetLogs).toHaveBeenCalledWith(auth, expect.objectContaining(ceiling));
    expect(mocks.getLogTrends).toHaveBeenCalledWith(auth, expect.objectContaining(ceiling));
    expect(mocks.getLogAggregation).toHaveBeenCalledWith(auth, expect.objectContaining(ceiling));
    expect(mocks.detectPatternCorrelation).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      ...ceiling,
    }));
  });
});
