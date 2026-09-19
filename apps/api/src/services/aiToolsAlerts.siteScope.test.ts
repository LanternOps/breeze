import { describe, it, expect, vi, beforeEach } from 'vitest';

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
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

describe('manage_alerts — per-alert site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolve denies an alert whose device is in a forbidden site (no update)', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      // 1: findAlertWithAccess -> alert row; 2: deviceIdSiteDenied -> { siteId }
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'a1', orgId: 'org-1', deviceId: 'd1', title: 'T' }]) }) }) };
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: 'site-B' }]) }) }) };
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    const r = await handlerFor('manage_alerts')({ action: 'resolve', alertId: 'a1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('get denies an alert whose device is in a forbidden site', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'a1', orgId: 'org-1', deviceId: 'd1', title: 'T' }]) }) }) };
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: 'site-B' }]) }) }) };
    });
    const r = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('resolve unrestricted caller is unaffected', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'a1', orgId: 'org-1', deviceId: 'd1', title: 'T' }]) }) }) });
    // `resolve` is a compare-and-swap since #4094 and chains `.returning({id})`;
    // a non-empty result is the winner. This suite is about the SITE axis, so it
    // always plays the winner — the CAS outcome itself is covered in
    // aiToolsAlerts.resolveCas.test.ts.
    mockDb.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'a1' }]) }) }),
    });
    const r = await handlerFor('manage_alerts')({ action: 'resolve', alertId: 'a1' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('manage_alerts list — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty for a site-restricted caller with no in-scope devices', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    });
    const r = await handlerFor('manage_alerts')({ action: 'list' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(0);
    expect(parsed.total).toBe(0);
  });
});

describe('manage_notification_channels — site-ceiling gate (contract-site-ceiling-gate §2/§7A)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['test', 'create', 'update', 'delete'])(
    'action=%s: site-restricted caller is denied before any DB access',
    async (action) => {
      const result = JSON.parse(await handlerFor('manage_notification_channels')({
        action,
        channelId: 'chan-1',
        name: 'Slack',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/x' },
      }, makeAuth(['s1'])));

      expect(result.error).toMatch(/site-restricted/i);
      expect(mockDb.select).not.toHaveBeenCalled();
    }
  );

  it('empty allowedSiteIds ([]) is also denied', async () => {
    const result = JSON.parse(await handlerFor('manage_notification_channels')({
      action: 'create', name: 'Slack', type: 'slack', config: {},
    }, makeAuth([])));
    expect(result.error).toMatch(/site-restricted/i);
  });

  it('"list" action is a read and NOT gated for a site-restricted caller', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) });
    const result = JSON.parse(await handlerFor('manage_notification_channels')({ action: 'list' }, makeAuth(['s1'])));
    expect(result.error).toBeUndefined();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected', async () => {
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'chan-1', orgId: 'org-1', name: 'Slack', type: 'slack' }])) })),
    });
    const result = JSON.parse(await handlerFor('manage_notification_channels')({
      action: 'create', name: 'Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' },
    }, makeAuth(undefined)));
    expect(result.error).toBeUndefined();
  });
});
