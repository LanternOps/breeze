import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

import { db } from '../db';
import { registerAuditTools } from './aiToolsAudit';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAuditTools(reg);
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

describe('query_change_log — site narrowing (no deviceId branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive change-log rows for a device in a forbidden site', async () => {
    let changeScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      changeScanRan = true;
      return chain([
        { timestamp: null, changeType: 'software', changeAction: 'added', subject: 's', beforeValue: null, afterValue: null, details: null, hostname: 'forbidden-host', deviceId: 'd-siteB' },
      ]);
    });

    const r = await handlerFor('query_change_log')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.changes).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.showing).toBe(0);
    expect(changeScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller enumerates change log normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object) && Object.keys(cols as object).length === 1) {
        return chain([{ count: 1 }]);
      }
      return chain([
        { timestamp: null, changeType: 'software', changeAction: 'added', subject: 's', beforeValue: null, afterValue: null, details: null, hostname: 'h1', deviceId: 'd1' },
      ]);
    });
    const r = await handlerFor('query_change_log')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
    expect(parsed.total).toBe(1);
  });
});
