import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Retired write endpoints keep authentication and return the shared migration guidance.

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

describe('alert templates — retired writes', () => {
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

  it.each([
    ['POST', `/alert-templates/templates`],
    ['PATCH', `/alert-templates/templates/${TEMPLATE_ID}`],
    ['DELETE', `/alert-templates/templates/${TEMPLATE_ID}`],
  ].flatMap(([method, path]) => ['{}', '{invalid'].map(body => [method!, path!, body])))('%s %s is retired (body %s)', async (method, path, body) => {
    const response = await app().request(path, { method,
      headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : body });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(LEGACY_ALERTING_GONE);
  });
});
