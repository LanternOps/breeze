import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectQueue, insertMock, updateMock, deleteMock, accessMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  accessMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));
vi.mock('../../db/schema', () => ({
  organizations: { id: 'org.id', partnerId: 'org.partnerId' },
  alertTemplates: { id: 'template.id', orgId: 'template.orgId', isBuiltIn: 'template.isBuiltIn' },
  alertRules: {
    id: 'rule.id', orgId: 'rule.orgId', partnerId: 'rule.partnerId', templateId: 'rule.templateId',
    targetType: 'rule.targetType', targetId: 'rule.targetId', overrideSettings: 'rule.overrideSettings',
    isActive: 'rule.isActive', name: 'rule.name', createdAt: 'rule.createdAt',
  },
}));
vi.mock('../../db', () => {
  const select = () => {
    const chain: any = {
      from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  const mutation = (spy: ReturnType<typeof vi.fn>, result: unknown[]) => {
    const chain: any = {
      values: (value: unknown) => { (spy as any)(value); return chain; },
      set: (value: unknown) => { (spy as any)(value); return chain; },
      where: () => chain,
      returning: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };
  return { db: {
    select: vi.fn(select),
    insert: vi.fn(() => mutation(insertMock, [{ id: 'rule-new', name: 'Rule', isActive: true }])),
    update: vi.fn(() => mutation(updateMock, [{ id: 'rule-1', name: 'Rule', isActive: true }])),
    delete: vi.fn(() => mutation(deleteMock, [])),
  } };
});
vi.mock('./siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./siteScope')>();
  return { ...actual, canAccessAlertRuleTargets: (...args: unknown[]) => accessMock(...args) };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../alerts/helpers', () => ({ retiredConditionReactivationError: vi.fn(async () => null) }));

import { ruleRoutes } from './rules';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';
const RULE_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

function app() {
  const instance = new Hono();
  instance.route('/alert-templates', ruleRoutes);
  return instance;
}

describe('legacy alert rule site boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    accessMock.mockResolvedValue(false);
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null, allowedSiteIds: ['site-allowed'],
      canAccessOrg: () => true, user: { id: 'user-1' },
    };
  });

  it('rejects default all-org creation before template lookup or insertion', async () => {
    const res = await app().request('/alert-templates/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: TEMPLATE_ID, name: 'Rule' }),
    });
    expect(res.status).toBe(403);
    expect(selectQueue).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('allows a validated device target and persists only that target', async () => {
    accessMock.mockResolvedValue(true);
    selectQueue.push([{ id: TEMPLATE_ID, name: 'Template' }]);
    const res = await app().request('/alert-templates/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: TEMPLATE_ID, name: 'Rule', targets: { deviceIds: [DEVICE_ID] } }),
    });
    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'device', targetId: DEVICE_ID }));
  });

  it.each([
    ['PATCH', `/alert-templates/rules/${RULE_ID}`, { name: 'Changed' }],
    ['DELETE', `/alert-templates/rules/${RULE_ID}`, undefined],
    ['POST', `/alert-templates/rules/${RULE_ID}/toggle`, { enabled: false }],
  ] as const)('denies %s of a hidden persisted target before mutation', async (method, path, body) => {
    selectQueue.push(
      [{ partnerId: null }],
      [{ id: RULE_ID, orgId: ORG_ID, name: 'Hidden', targetType: 'device', targetId: DEVICE_ID, isActive: true }],
    );
    const res = await app().request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
