import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Exact-device axis for manage_alerts (#6096).
 *
 * A device-bound preconfigured agent run carries `allowedDeviceIds` (and, when
 * the run has a device, a one-site `allowedSiteIds`). A device-LESS analysis
 * run carries `allowedDeviceIds` and NO site axis at all, so every guard
 * written `if (auth.allowedSiteIds && …)` silently no-ops for it.
 *
 * Two holes are covered here:
 *  - `findAlertWithAccess` gated the site check on `alert.deviceId &&`, so an
 *    org-wide (device-LESS) alert was readable and actionable by a run bound to
 *    one device — the alert is not attributable to that device.
 *  - `manage_alerts` list narrowed only when `auth.allowedSiteIds` was set.
 */
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => {}) }));

import { db } from '../db';
import { registerAlertTools } from './aiToolsAlerts';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAlertTools(reg);
  return reg.get(name)!.handler;
}

/** The device-bound run shape: one site, one device. */
function deviceBoundAuth(): AuthContext {
  return {
    principal: { kind: 'ai_agent', agentId: 'ag-1', runId: 'run-1' } as any,
    user: { id: 'ag-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null as any, partnerId: 'p1', orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: ['site-1'], canAccessSite: () => true,
    allowedDeviceIds: ['dev-1'],
  } as AuthContext;
}

/** The device-LESS analysis run shape: frozen device set, NO site axis. */
function deviceLessRunAuth(): AuthContext {
  const auth = deviceBoundAuth() as any;
  delete auth.allowedSiteIds;
  delete auth.canAccessSite;
  return auth as AuthContext;
}

function unrestrictedAuth(): AuthContext {
  const auth = deviceBoundAuth() as any;
  delete auth.allowedSiteIds;
  delete auth.canAccessSite;
  delete auth.allowedDeviceIds;
  return auth as AuthContext;
}

const ORG_WIDE_ALERT = { id: 'a1', orgId: 'org-1', deviceId: null, title: 'T', status: 'active' };
const SIBLING_ALERT = { id: 'a2', orgId: 'org-1', deviceId: 'dev-2', title: 'T', status: 'active' };
const OWN_ALERT = { id: 'a3', orgId: 'org-1', deviceId: 'dev-1', title: 'T', status: 'active' };

function mockAlertLookup(alert: Record<string, unknown>, deviceSiteId: string | null = 'site-1') {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([alert]) }) }) };
    }
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: deviceSiteId }]) }) }) };
  });
}

describe('manage_alerts — exact-device axis (#6096)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get denies a device-LESS org-wide alert for a device-bound run', async () => {
    mockAlertLookup(ORG_WIDE_ALERT);
    const r = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a1' }, deviceBoundAuth());
    expect(r).toContain('access denied');
  });

  it('resolve denies a device-LESS org-wide alert for a device-bound run (no update)', async () => {
    mockAlertLookup(ORG_WIDE_ALERT);
    mockDb.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'a1' }]) }) }) });
    const r = await handlerFor('manage_alerts')({ action: 'resolve', alertId: 'a1' }, deviceBoundAuth());
    expect(r).toContain('access denied');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('acknowledge denies a sibling device alert in the same site', async () => {
    mockAlertLookup(SIBLING_ALERT, 'site-1');
    mockDb.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'a2' }]) }) }) });
    const r = await handlerFor('manage_alerts')({ action: 'acknowledge', alertId: 'a2' }, deviceBoundAuth());
    expect(r).toContain('access denied');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('get still returns the run device\'s own alert', async () => {
    mockAlertLookup(OWN_ALERT, 'site-1');
    const r = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a3' }, deviceBoundAuth());
    expect(r).not.toContain('access denied');
    expect(JSON.parse(r).alert.id).toBe('a3');
  });

  it('get allows a device-LESS alert for an unrestricted caller (no regression)', async () => {
    mockAlertLookup(ORG_WIDE_ALERT);
    const r = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a1' }, unrestrictedAuth());
    expect(r).not.toContain('access denied');
  });

  it('get denies a device-LESS alert for a device-LESS analysis run (no site axis)', async () => {
    mockAlertLookup(ORG_WIDE_ALERT);
    const r = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a1' }, deviceLessRunAuth());
    expect(r).toContain('access denied');
  });
});

describe('manage_alerts list — exact-device narrowing without a site axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('narrows the list for a device-LESS analysis run (allowedDeviceIds, no allowedSiteIds)', async () => {
    let listWhere: SQL | undefined;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
        // resolveSiteAllowedDeviceIds: the org's devices.
        return { from: () => ({ where: () => Promise.resolve([
          { id: 'dev-1', siteId: 'site-1' },
          { id: 'dev-2', siteId: 'site-1' },
        ]) }) };
      }
      return { from: () => ({ where: (cond: SQL) => { listWhere = cond; return {
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
        then: (res: any) => res([{ count: 0 }]),
      }; } }) };
    });
    await handlerFor('manage_alerts')({ action: 'list' }, deviceLessRunAuth());
    expect(listWhere, 'list must narrow on the device axis even with no site axis').toBeDefined();
    const rendered = new PgDialect().sqlToQuery(listWhere!);
    expect(rendered.params).toContain('dev-1');
    expect(rendered.params).not.toContain('dev-2');
  });

  it('returns nothing for a device-bound run when the requested deviceId is a sibling', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([
          { id: 'dev-1', siteId: 'site-1' },
          { id: 'dev-2', siteId: 'site-1' },
        ]) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'x' }]) }) }) }) };
    });
    const r = await handlerFor('manage_alerts')({ action: 'list', deviceId: 'dev-2' }, deviceBoundAuth());
    expect(JSON.parse(r).showing).toBe(0);
  });
});
