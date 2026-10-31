import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../jobs/dnsSyncJob', () => ({ schedulePolicySync: vi.fn() }));

import { db } from '../db';
import { registerDnsTools } from './aiToolsDns';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDnsTools(reg);
  return reg.get('get_dns_security')!.handler;
}

const auth = {
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
  accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
  canAccessSite: () => true,
} as unknown as AuthContext;

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

function mockStats(integrationConfigs: Array<Record<string, unknown>>) {
  mockDb.select.mockImplementation((cols?: unknown) => {
    const keys = cols && typeof cols === 'object' ? Object.keys(cols as object) : [];
    if (keys.length === 1 && keys[0] === 'config') {
      return chain(integrationConfigs.map((config) => ({ config })));
    }
    if (keys.includes('totalQueries')) {
      return chain([{ totalQueries: 120, blockedQueries: 100, allowedQueries: 0, redirectedQueries: 20 }]);
    }
    return chain([]);
  });
}

// 1-day window keeps the handler on the raw-events path.
const RAW_RANGE = { timeRange: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' } };

// #10054 — allowed traffic is stored only for integrations that opted in, so
// the AI tool must not present a zero allowed count (or a ~100% blocked rate)
// as fact when nothing stores allowed queries.
describe('get_dns_security — allowed traffic coverage (#10054)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says allowed traffic is not stored instead of reporting zero', async () => {
    mockStats([{}]);

    const parsed = JSON.parse(await handler()(RAW_RANGE, auth));

    expect(parsed.allowedTraffic).toBe('none');
    expect(parsed.summary.allowedQueries).toBeNull();
    expect(parsed.summary.blockedRate).toBeNull();
    expect(parsed.allowedTrafficNote).toMatch(/not stored/i);
  });

  it('reports the numbers when every integration stores allowed traffic', async () => {
    mockStats([{ storeAllowedTraffic: true }]);

    const parsed = JSON.parse(await handler()(RAW_RANGE, auth));

    expect(parsed.allowedTraffic).toBe('all');
    expect(parsed.summary.allowedQueries).toBe(0);
    expect(parsed.allowedTrafficNote).toBeUndefined();
  });

  it('flags a partial count when only some integrations store allowed traffic', async () => {
    mockStats([{ storeAllowedTraffic: true }, {}]);

    const parsed = JSON.parse(await handler()(RAW_RANGE, auth));

    expect(parsed.allowedTraffic).toBe('some');
    expect(parsed.allowedTrafficNote).toMatch(/some/i);
  });
});
