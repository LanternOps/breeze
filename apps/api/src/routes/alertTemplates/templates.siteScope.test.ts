import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, updateMock, deleteMock, dependentAccessMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  dependentAccessMock: vi.fn(),
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
  const existing = {
    id: '22222222-2222-4222-8222-222222222222',
    orgId: '11111111-1111-4111-8111-111111111111', partnerId: null, isBuiltIn: false, name: 'Shared',
  };
  const selectChain: any = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = () => Promise.resolve([existing]);
  const mutation = (spy: ReturnType<typeof vi.fn>) => {
    const chain: any = {
      set: (value: unknown) => { (spy as any)(value); return chain; },
      where: () => chain,
      returning: () => Promise.resolve([existing]),
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
  canAccessTemplateDependents: (...args: unknown[]) => dependentAccessMock(...args),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { templateRoutes } from './templates';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const instance = new Hono();
  instance.route('/alert-templates', templateRoutes);
  return instance;
}

describe('alert template dependent-rule site boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependentAccessMock.mockResolvedValue(false);
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null, allowedSiteIds: ['site-allowed'],
      canAccessOrg: (id: string) => id === ORG_ID, user: { id: 'user-1' },
    };
  });

  it('rejects editing a template consumed by a hidden rule before update', async () => {
    const res = await app().request(`/alert-templates/templates/${TEMPLATE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: { threshold: 99 } }),
    });
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects deleting a template consumed by a hidden rule before delete', async () => {
    const res = await app().request(`/alert-templates/templates/${TEMPLATE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('allows an update when every dependent rule remains visible', async () => {
    dependentAccessMock.mockResolvedValue(true);
    const res = await app().request(`/alert-templates/templates/${TEMPLATE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: 'high' }),
    });
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalled();
  });
});
