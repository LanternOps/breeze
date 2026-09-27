import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Retired write endpoints keep authentication and return the shared migration guidance.

const { authRef, selectQueue, updateMock, deleteMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
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
    insert: vi.fn(() => mutation(vi.fn(), [])),
    update: vi.fn(() => mutation(updateMock, [{ id: 'rule-1', name: 'Rule', isActive: true }])),
    delete: vi.fn(() => mutation(deleteMock, [])),
  } };
});
vi.mock('./siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./siteScope')>();
  return { ...actual, canAccessAlertRuleTargets: vi.fn(async () => true) };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../alerts/helpers', () => ({ retiredConditionReactivationError: vi.fn(async () => null) }));

import { ruleRoutes } from './rules';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const RULE_ID = '33333333-3333-4333-8333-444455556666';

function app() {
  const instance = new Hono();
  instance.route('/alert-templates', ruleRoutes);
  return instance;
}

describe('legacy alert-template rules — retired writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null, allowedSiteIds: undefined,
      canAccessOrg: () => true, user: { id: 'user-1' },
    };
  });

  it.each([
    ['POST', `/alert-templates/rules`],
    ['PATCH', `/alert-templates/rules/${RULE_ID}`],
    ['DELETE', `/alert-templates/rules/${RULE_ID}`],
    ['POST', `/alert-templates/rules/${RULE_ID}/toggle`],
  ].flatMap(([method, path]) => ['{}', '{invalid'].map(body => [method!, path!, body])))('%s %s is retired (body %s)', async (method, path, body) => {
    const response = await app().request(path, { method,
      headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : body });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(LEGACY_ALERTING_GONE);
  });
});
