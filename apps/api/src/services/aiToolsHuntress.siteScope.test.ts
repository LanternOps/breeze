import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../jobs/huntressSync', () => ({ scheduleHuntressSync: vi.fn() }));

import { db } from '../db';
import { registerHuntressTools } from './aiToolsHuntress';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerHuntressTools(reg);
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
/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

describe('get_huntress_incidents — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive incidents/hostnames for a device in a forbidden site', async () => {
    let incidentScanRan = false;
    const forbiddenIncident = {
      id: 'i1', orgId: 'org-1', deviceId: 'd-siteB',
      title: 'SECRET cross-site incident', deviceHostname: 'forbidden-host',
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      incidentScanRan = true;
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return chain([{ count: 1 }]);
      }
      return chain([forbiddenIncident]);
    });

    const r = await handlerFor('get_huntress_incidents')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.total).toBe(0);
    expect(parsed.incidents).toEqual([]);
    expect(incidentScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
    expect(JSON.stringify(parsed)).not.toContain('SECRET cross-site incident');
  });

  it('unrestricted caller enumerates incidents normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return chain([{ count: 1 }]);
      }
      return chain([{ id: 'i1', orgId: 'org-1', deviceId: 'd1', title: 'Incident', deviceHostname: 'h1' }]);
    });
    const r = await handlerFor('get_huntress_incidents')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.total).toBe(1);
    expect(parsed.incidents).toHaveLength(1);
  });
});
