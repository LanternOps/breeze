import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));

import { db } from '../db';
import { registerDeviceTools } from './aiToolsDevice';
import { createDeviceContext } from './brainDeviceContext';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
const createDeviceContextMock = createDeviceContext as unknown as ReturnType<typeof vi.fn>;
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDeviceTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

describe('query_devices — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty for a site-restricted caller with no in-scope devices, without enumerating', async () => {
    let listRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // resolveSiteAllowedDeviceIds selects { id, siteId }
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      listRan = true;
      return { from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) };
    });
    const r = await handlerFor('query_devices')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(0);
    expect(parsed.showing).toBe(0);
    expect(listRan).toBe(false);
  });

  it('unrestricted caller enumerates normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) };
      }
      return { from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'd1', hostname: 'h' }]) }) }) }) }) };
    });
    const r = await handlerFor('query_devices')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(1);
  });
});

describe('set_device_context — per-device site gating (write path)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies writing context for a device in a forbidden site, without calling createDeviceContext', async () => {
    // verifyDeviceAccess does db.select().from(devices)...; the device exists in
    // the org but lives in a forbidden site.
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN', status: 'online' }]) }) }) });
    const r = await handlerFor('set_device_context')(
      { deviceId: 'd1', contextType: 'issue', summary: 'note' },
      makeAuth(['site-A']),
    );
    expect(r).toContain('access denied');
    expect(createDeviceContextMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller writes context normally (no regression)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-Z', status: 'online' }]) }) }) });
    createDeviceContextMock.mockResolvedValue({ id: 'ctx-1' });
    const r = await handlerFor('set_device_context')(
      { deviceId: 'd1', contextType: 'issue', summary: 'note' },
      makeAuth(undefined),
    );
    expect(r).not.toContain('access denied');
    expect(createDeviceContextMock).toHaveBeenCalled();
  });
});

describe('manage_tags list — site narrowing (tag enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets no tags, without scanning all devices', async () => {
    let executed = false;
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) });
    mockDb.execute.mockImplementation(() => { executed = true; return Promise.resolve([]); });
    const r = await handlerFor('manage_tags')({ action: 'list' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(0);
    expect(executed).toBe(false);
  });
});
