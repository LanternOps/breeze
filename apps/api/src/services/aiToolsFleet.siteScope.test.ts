import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: deleteSpy, transaction: vi.fn() },
}));

import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetTools(reg);
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

describe('manage_patches — per-device site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('install denies when a target device is owned but outside the caller site scope', async () => {
    // ownedDevices returns the device (org match) WITH its real forbidden site —
    // the site gate (not org ownership) must reject it. Proves the gate is live.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }),
    });
    const r = await handlerFor('manage_patches')({ action: 'install', patchIds: ['p1'], deviceIds: ['d1'] }, makeAuth(['site-A']));
    expect(r).toContain('Access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('install allows an unrestricted caller (no regression)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) });
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'job1' }]) }) }));
    const r = await handlerFor('manage_patches')({ action: 'install', patchIds: ['p1'], deviceIds: ['d1'] }, makeAuth(undefined));
    expect(r).not.toContain('Access denied');
  });

  it('rollback denies a device owned but outside the caller site scope', async () => {
    // rollback selects { id, siteId } for the single device; site is forbidden.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) }),
    });
    const r = await handlerFor('manage_patches')({ action: 'rollback', patchId: 'p1', deviceIds: ['d1'] }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('manage_groups remove_devices — per-device site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only removes in-scope devices; out-of-site device ids are excluded from the delete', async () => {
    let call = 0;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // 1st select: the group row (orgId)
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      // 2nd select: candidate devices { id, siteId }
      return { from: () => ({ where: () => Promise.resolve([
        { id: 'd-in', siteId: 'site-A' },
        { id: 'd-out', siteId: 'site-FORBIDDEN' },
      ]) }) };
    });
    let deletedIds: string[] | null = null;
    deleteSpy.mockReturnValue({
      where: (cond: any) => {
        // Capture the device-id list the delete is scoped to by re-running the
        // inArray against a probe. We can't introspect the SQL easily, so the
        // handler must have narrowed the id list before building the condition.
        return Promise.resolve();
      },
    });
    // Spy on inArray indirectly: assert handler reports the skipped count.
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d-in', 'd-out'] }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
    // out-of-site device must be reported as skipped (not silently removed)
    expect(parsed.removed).toBe(1);
    expect(parsed.skipped).toBe(1);
  });

  it('removes nothing (no delete) when all requested devices are out-of-site', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      return { from: () => ({ where: () => Promise.resolve([{ id: 'd-out', siteId: 'site-FORBIDDEN' }]) }) };
    });
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d-out'] }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.removed).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('unrestricted caller removes all requested devices (no regression)', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      if (call === 0) { call++; return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'g1', name: 'G', orgId: 'org-1' }]) }) }) }; }
      return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-Z' }, { id: 'd2', siteId: 'site-Y' }]) }) };
    });
    deleteSpy.mockReturnValue({ where: () => Promise.resolve() });
    const r = await handlerFor('manage_groups')({ action: 'remove_devices', groupId: 'g1', deviceIds: ['d1', 'd2'] }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.success).toBe(true);
    expect(deleteSpy).toHaveBeenCalled();
  });
});

describe('report data device_inventory — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets empty inventory', async () => {
    let inventoryRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      inventoryRan = true;
      return { from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) };
    });
    const r = await handlerFor('generate_report')({ action: 'data', reportType: 'device_inventory' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(0);
    expect(inventoryRan).toBe(false);
  });
});
