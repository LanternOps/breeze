import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbSelectResult, serviceMocks, auditSpy } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  dbSelectResult: vi.fn(),
  serviceMocks: {
    getOrgTicketSettings: vi.fn(),
    upsertOrgTicketSettings: vi.fn(),
  },
  auditSpy: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectResult()),
        })),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'id', deletedAt: 'deletedAt' },
}));

vi.mock('../services/ticketConfigService', () => ({
  getOrgTicketSettings: (...args: unknown[]) => serviceMocks.getOrgTicketSettings(...args),
  upsertOrgTicketSettings: (...args: unknown[]) => serviceMocks.upsertOrgTicketSettings(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => auditSpy(...args),
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgTicketSettingsRoutes } from './orgTicketSettings';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean,
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgTicketSettingsRoutes(app);
  return app;
}

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

describe('GET /organizations/:id/ticket-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns the org ticket settings', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.getOrgTicketSettings.mockResolvedValue({
      orgId: ORG_ID, slaOverrides: { high: { responseMinutes: 30 } }, defaultHourlyRate: '125.00', defaultBillable: true,
    });
    const res = await makeApp().request(`/organizations/${ORG_ID}/ticket-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ orgId: ORG_ID, defaultHourlyRate: '125.00', defaultBillable: true });
    expect(serviceMocks.getOrgTicketSettings).toHaveBeenCalledWith(ORG_ID);
  });

  it('404 when the org does not exist (or is soft-deleted)', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/ticket-settings`);
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/organizations/${ORG_ID}/ticket-settings`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/organizations/${ORG_ID}/ticket-settings`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /organizations/:id/ticket-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const patch = (body: unknown) =>
    makeApp().request(`/organizations/${ORG_ID}/ticket-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('upserts and fires an audit event', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.upsertOrgTicketSettings.mockResolvedValue({
      orgId: ORG_ID, slaOverrides: {}, defaultHourlyRate: '90.00', defaultBillable: true,
    });
    const res = await patch({ defaultHourlyRate: 90, defaultBillable: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgId).toBe(ORG_ID);
    expect(serviceMocks.upsertOrgTicketSettings).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ defaultHourlyRate: 90, defaultBillable: true }));
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]?.[1];
    expect(event.action).toBe('organization.ticket_settings.update');
    expect(event.orgId).toBe(ORG_ID);
    expect(event.details.changedFields).toEqual(['defaultHourlyRate', 'defaultBillable']);
  });

  it('400 on an empty body (schema refine)', async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
  });

  it('404 when the org does not exist', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await patch({ defaultBillable: false });
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await patch({ defaultBillable: false });
    expect(res.status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await patch({ defaultBillable: true });
    expect(res.status).toBe(401);
  });
});
