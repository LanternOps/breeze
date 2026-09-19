import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #5289 — an alert template compiled from a monitor definition
// (managed_by_monitor_id set) must refuse PATCH and DELETE. Side editing a
// compiled row would silently drift from its monitor definition until the
// next compile overwrote it.

const { authRef, existingRef, updateMock, deleteMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  existingRef: { current: {} as any },
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));
vi.mock('../../db/schema', () => ({ alertTemplates: {
  id: 'template.id', orgId: 'template.orgId', partnerId: 'template.partnerId', isBuiltIn: 'template.isBuiltIn',
} }));
vi.mock('../../db', () => {
  const selectChain: any = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = () => Promise.resolve([existingRef.current]);
  const mutation = (spy: ReturnType<typeof vi.fn>) => {
    const chain: any = {
      set: (value: unknown) => { (spy as any)(value); return chain; },
      where: () => chain,
      returning: () => Promise.resolve([existingRef.current]),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };
  return { db: {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => mutation(updateMock)),
    delete: vi.fn(() => mutation(deleteMock)),
  } };
});
vi.mock('./siteScope', () => ({
  canAccessTemplateDependents: vi.fn(async () => true),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { templateRoutes } from './templates';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';
const MONITOR_ID = '33333333-3333-4333-8333-333333333333';

function app() {
  const instance = new Hono();
  instance.route('/alert-templates', templateRoutes);
  return instance;
}

describe('alert templates — managed-by-monitor guard (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null, allowedSiteIds: undefined,
      canAccessOrg: (id: string) => id === ORG_ID, user: { id: 'user-1' },
    };
    existingRef.current = {
      id: TEMPLATE_ID,
      orgId: ORG_ID,
      partnerId: null,
      isBuiltIn: false,
      name: 'Compiled template',
      managedByMonitorId: MONITOR_ID,
    };
  });

  it('PATCH /alert-templates/templates/:id on a monitor-managed template is 409 alert_template_managed_by_monitor', async () => {
    const res = await app().request(`/alert-templates/templates/${TEMPLATE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: 'high' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_template_managed_by_monitor', monitorId: MONITOR_ID });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('DELETE /alert-templates/templates/:id on a monitor-managed template is 409 alert_template_managed_by_monitor', async () => {
    const res = await app().request(`/alert-templates/templates/${TEMPLATE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_template_managed_by_monitor', monitorId: MONITOR_ID });
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
