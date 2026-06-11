import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDistribution: vi.fn(async () => {}) }));

import { db } from '../db';
import { registerPeripheralTools } from './aiToolsPeripherals';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPeripheralTools(reg);
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

describe('get_peripheral_activity — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive events from a device in a forbidden site', async () => {
    let eventScanRan = false;
    const forbiddenEvent = { id: 'ev1', deviceId: 'd-siteB', eventType: 'connected', vendor: 'SECRET-VENDOR' };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      // bare .select() (no projection) → peripheralEvents read
      eventScanRan = true;
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([forbiddenEvent]) }) }) }) };
    });

    const r = await handlerFor('get_peripheral_activity')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.summary.count).toBe(0);
    expect(parsed.events).toEqual([]);
    expect(eventScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('SECRET-VENDOR');
  });

  it('unrestricted caller enumerates events normally (no regression)', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'ev1', deviceId: 'd1', eventType: 'connected' }]) }) }) }),
    });
    const r = await handlerFor('get_peripheral_activity')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.summary.count).toBe(1);
  });
});
