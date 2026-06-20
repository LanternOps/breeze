import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./pamRuleEngine', () => ({ evaluatePamRules: vi.fn() }));

import { db } from '../db';
import { registerPamTools } from './aiToolsPam';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPamTools(reg);
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
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

describe('get_elevation_history — site narrowing (no deviceId branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive elevation rows for a device in a forbidden site', async () => {
    let historyScanRan = false;
    const forbiddenRow = {
      id: 'er-1', deviceId: 'd-siteB', flowType: 'os', status: 'approved',
      subjectUsername: 'admin', reason: 'r', requestedAt: null, approvedAt: null,
      expiresAt: null, revokedAt: null, denialReason: null, revokedReason: null, metadata: null,
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      historyScanRan = true;
      return chain([forbiddenRow]);
    });

    const r = await handlerFor('get_elevation_history')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.results).toEqual([]);
    expect(historyScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('d-siteB');
  });

  it('unrestricted caller enumerates elevation history normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => chain([
      {
        id: 'er-1', deviceId: 'd1', flowType: 'os', status: 'approved',
        subjectUsername: 'admin', reason: 'r', requestedAt: null, approvedAt: null,
        expiresAt: null, revokedAt: null, denialReason: null, revokedReason: null, metadata: null,
      },
    ]));
    const r = await handlerFor('get_elevation_history')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });
});
