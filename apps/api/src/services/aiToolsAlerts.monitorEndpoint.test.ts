import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Network-monitor alerts created before the monitor worker reduced targets to
 * scheme + host still hold the full HTTP check URL in their message and
 * context. manage_alerts shows those as scheme + host.
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

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAlertTools(reg);
  return reg.get(name)!.handler;
}

function unrestrictedAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' } as any,
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null as any, partnerId: 'p1', orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
  } as AuthContext;
}

const SECRET_URL = 'https://ops:hunter2@status.example.com/hooks/T1/B1/abc123?token=xyz789';
const FRAGMENTS = ['hunter2', '/hooks/', 'abc123', 'xyz789'];

describe('manage_alerts — network monitor endpoints', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get shows the stored target as scheme + host in message and context', async () => {
    const alert = {
      id: 'a1', orgId: 'org-1', deviceId: null, title: 'Status page offline', status: 'active',
      message: `Monitor Status page is offline. Target: ${SECRET_URL}. Status: offline.`,
      context: { source: 'network_monitor', target: SECRET_URL, error: `Get "${SECRET_URL}": EOF` },
    };
    mockDb.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([alert]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });

    const raw = await handlerFor('manage_alerts')({ action: 'get', alertId: 'a1' }, unrestrictedAuth());
    for (const f of FRAGMENTS) expect(raw).not.toContain(f);
    const out = JSON.parse(raw);
    expect(out.alert.message).toBe('Monitor Status page is offline. Target: https://status.example.com. Status: offline.');
    expect(out.alert.context.target).toBe('https://status.example.com');
    expect(out.alert.context.error).toBe('Get "https://status.example.com": EOF');
  });

  it('get leaves alerts from other sources unchanged', async () => {
    const alert = {
      id: 'a2', orgId: 'org-1', deviceId: null, title: 'T', status: 'active',
      message: 'See https://docs.example.com/runbooks/cpu for steps.',
      context: { source: 'alert_rule' },
    };
    mockDb.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([alert]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });

    const out = JSON.parse(await handlerFor('manage_alerts')({ action: 'get', alertId: 'a2' }, unrestrictedAuth()));
    expect(out.alert.message).toBe('See https://docs.example.com/runbooks/cpu for steps.');
  });

  it('list shows network monitor alert messages with URLs reduced to scheme + host', async () => {
    const rows = [
      {
        id: 'a1', status: 'active', severity: 'high', title: 'Status page offline', deviceId: null,
        message: `Monitor Status page is offline. Target: ${SECRET_URL}. Status: offline.`,
        contextSource: 'network_monitor',
        triggeredAt: new Date('2026-10-01T00:00:00Z'), triggeredAtText: '2026-10-01 00:00:00.000001',
        acknowledgedAt: null, resolvedAt: null, suppressedUntil: null,
      },
      {
        id: 'a2', status: 'active', severity: 'low', title: 'CPU', deviceId: null,
        message: 'See https://docs.example.com/runbooks/cpu for steps.',
        contextSource: 'alert_rule',
        triggeredAt: new Date('2026-10-01T00:00:00Z'), triggeredAtText: '2026-10-01 00:00:00.000000',
        acknowledgedAt: null, resolvedAt: null, suppressedUntil: null,
      },
    ];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols && 'count' in cols && Object.keys(cols).length === 1) {
        return { from: () => ({ where: () => Promise.resolve([{ count: rows.length }]) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }) };
    });

    const raw = await handlerFor('manage_alerts')({ action: 'list' }, unrestrictedAuth());
    for (const f of FRAGMENTS) expect(raw).not.toContain(f);
    const out = JSON.parse(raw);
    const items = out.alerts ?? out.items;
    expect(items[0].message).toBe('Monitor Status page is offline. Target: https://status.example.com. Status: offline.');
    expect(items[1].message).toBe('See https://docs.example.com/runbooks/cpu for steps.');
    expect(items[0]).not.toHaveProperty('contextSource');
  });
});
