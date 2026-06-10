import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./sentinelOne/actions', () => ({
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
  getActiveS1IntegrationForOrg: vi.fn(async () => ({ id: 'integ-1' })),
}));
vi.mock('../jobs/s1Sync', () => ({ isThreatAction: () => true }));

import { db } from '../db';
import { registerSentinelOneTools } from './aiToolsSentinelOne';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerSentinelOneTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

describe('get_s1_threats — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive threats for a device in a forbidden site', async () => {
    let threatScanRan = false;
    const forbiddenThreat = { id: 't1', deviceId: 'd-siteB', threatName: 'SECRET-THREAT', deviceName: 'forbidden-host' };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      threatScanRan = true;
      // rows query (leftJoin) and count query share this implementation
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) };
      }
      return {
        from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([forbiddenThreat]) }) }) }) }),
      };
    });

    const r = await handlerFor('get_s1_threats')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.total).toBe(0);
    expect(parsed.threats).toEqual([]);
    expect(threatScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('SECRET-THREAT');
  });

  it('unrestricted caller reads threats normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) };
      }
      return {
        from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 't1', deviceId: 'd1', threatName: 'mal' }]) }) }) }) }),
      };
    });
    const r = await handlerFor('get_s1_threats')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(1);
    expect(parsed.threats.length).toBe(1);
  });
});
