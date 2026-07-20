import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectQueue, insertValuesMock, updateSetMock, deleteWhereMock, resolveTemplateMock, ruleRef } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  insertValuesMock: vi.fn(),
  updateSetMock: vi.fn(),
  deleteWhereMock: vi.fn(),
  resolveTemplateMock: vi.fn(),
  ruleRef: { current: null as Record<string, unknown> | null },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) => !allowed || (!!siteId && allowed.includes(siteId)),
}));

vi.mock('../../db/schema', () => ({
  alertRules: { id: 'rule.id', orgId: 'rule.orgId', partnerId: 'rule.partnerId', templateId: 'rule.templateId', targetType: 'rule.targetType', targetId: 'rule.targetId', isActive: 'rule.isActive', createdAt: 'rule.createdAt' },
  alertTemplates: { id: 'template.id' },
  alerts: { ruleId: 'alert.ruleId', status: 'alert.status' },
  devices: { id: 'device.id', orgId: 'device.orgId', siteId: 'device.siteId' },
  deviceGroups: { id: 'group.id', orgId: 'group.orgId', siteId: 'group.siteId' },
  sites: { id: 'site.id', orgId: 'site.orgId' },
  organizations: { id: 'org.id', partnerId: 'org.partnerId' },
}));

vi.mock('../../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  const makeMutation = (capture: (value: unknown) => unknown, result: unknown[]) => {
    const chain: any = {
      values: (value: unknown) => { capture(value); return chain; },
      set: (value: unknown) => { capture(value); return chain; },
      where: (value: unknown) => { capture(value); return chain; },
      returning: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => makeSelect()),
      insert: vi.fn(() => makeMutation(insertValuesMock, [{ id: 'rule-created', name: 'Scoped rule', isActive: true, targetType: 'device' }])),
      update: vi.fn(() => makeMutation(updateSetMock, [{ id: 'rule-existing', name: 'Updated', isActive: true }])),
      delete: vi.fn(() => makeMutation(deleteWhereMock, [])),
    },
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(() => false),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Partner-wide denied',
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 1, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertRuleWithOrgCheck: vi.fn(async () => ruleRef.current),
  isRecord: (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value),
  getOverrides: (value: unknown) => value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {},
  normalizeTargetsForRule: (data: { targets?: { type?: string; ids?: string[] }; targetType?: string; targetId?: string }, orgId: string) => {
    const targetType = data.targets?.type ?? data.targetType ?? 'all';
    const targetIds = data.targets?.ids ?? (data.targetId ? [data.targetId] : []);
    return {
      targetType,
      targetId: targetType === 'all' || targetType === 'org' ? orgId : targetIds[0],
      targetIds,
      targets: { type: targetType, ids: targetIds },
    };
  },
  getNotificationChannelIds: vi.fn(() => []),
  containsNotificationBindingOverride: vi.fn(() => false),
  validateAlertRuleNotificationBindings: vi.fn(async () => null),
  formatAlertRuleResponse: (rule: unknown) => rule,
  resolveAlertTemplate: resolveTemplateMock,
}));

import { rulesRoutes } from './rules';
import { db } from '../../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ALLOWED_SITE = '22222222-2222-4222-8222-222222222222';
const DENIED_SITE = '33333333-3333-4333-8333-333333333333';
const TARGET_A = '44444444-4444-4444-8444-444444444444';
const TARGET_B = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_ID = '66666666-6666-4666-8666-666666666666';
const RULE_ID = '77777777-7777-4777-8777-777777777777';

function app() {
  const instance = new Hono();
  instance.route('/alerts', rulesRoutes);
  return instance;
}

function createBody(type: 'site' | 'device' | 'group', ids: string[]) {
  return {
    name: 'Scoped rule', severity: 'high', conditions: { type: 'metric' },
    targets: { type, ids },
  };
}

describe('alert rule site target authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    ruleRef.current = null;
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null,
      allowedSiteIds: [ALLOWED_SITE], canAccessOrg: () => true,
      user: { id: 'user-1' },
    };
    resolveTemplateMock.mockResolvedValue({
      template: { id: TEMPLATE_ID, orgId: ORG_ID, partnerId: null, isBuiltIn: false, name: 'Scoped rule' },
      created: false,
    });
  });

  it.each([
    ['site', [{ id: TARGET_A, orgId: ORG_ID }]],
    ['device', [{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]],
    ['group', [{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]],
  ] as const)('rejects a denied %s target before template or rule writes', async (type, rows) => {
    selectQueue.push(rows as unknown as unknown[]);
    const res = await app().request('/alerts/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody(type, [TARGET_A])),
    });
    expect(res.status).toBe(403);
    expect(resolveTemplateMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects mixed allowed/denied device targets atomically before writes', async () => {
    selectQueue.push([
      { id: TARGET_A, orgId: ORG_ID, siteId: ALLOWED_SITE },
      { id: TARGET_B, orgId: ORG_ID, siteId: DENIED_SITE },
    ]);
    const res = await app().request('/alerts/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody('device', [TARGET_A, TARGET_B])),
    });
    expect(res.status).toBe(403);
    expect(resolveTemplateMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows a matching-site target', async () => {
    selectQueue.push([{ id: TARGET_A, orgId: ORG_ID, siteId: ALLOWED_SITE }]);
    const res = await app().request('/alerts/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody('device', [TARGET_A])),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('preserves unrestricted target creation behavior', async () => {
    authRef.current.allowedSiteIds = undefined;
    selectQueue.push([{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]);
    const res = await app().request('/alerts/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody('device', [TARGET_A])),
    });
    expect(res.status).toBe(201);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('hides a persisted denied device target on detail reads', async () => {
    ruleRef.current = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'device', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push([{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]);
    const res = await app().request(`/alerts/rules/${RULE_ID}`);
    expect(res.status).toBe(404);
  });

  it('filters persisted denied targets from list reads', async () => {
    const rule = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'device', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push([{ rule, template: null }], [{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]);
    const res = await app().request('/alerts/rules');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [], pagination: { total: 0 } });
  });

  it('filters before pagination so denied rules do not hide later accessible rules', async () => {
    const deniedRule = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'device', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    const allowedRule = {
      ...deniedRule,
      id: '88888888-8888-4888-8888-888888888888',
      targetId: TARGET_B,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_B] }, targetIds: [TARGET_B] },
    };
    selectQueue.push(
      [{ rule: deniedRule, template: null }, { rule: allowedRule, template: null }],
      [{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }],
      [{ id: TARGET_B, orgId: ORG_ID, siteId: ALLOWED_SITE }],
    );

    const res = await app().request('/alerts/rules');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: [{ id: allowedRule.id }],
      pagination: { page: 1, limit: 1, total: 1 },
    });
  });

  it('rejects updating a persisted denied group target before any write', async () => {
    ruleRef.current = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'group', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'group', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push([{ id: TARGET_A, orgId: ORG_ID, siteId: DENIED_SITE }]);
    const res = await app().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects changing an allowed rule to a denied target before any write', async () => {
    ruleRef.current = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'device', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push(
      [{ id: TARGET_A, orgId: ORG_ID, siteId: ALLOWED_SITE }],
      [{ id: TARGET_B, orgId: ORG_ID, siteId: DENIED_SITE }],
    );
    const res = await app().request(`/alerts/rules/${RULE_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: { type: 'device', ids: [TARGET_B] } }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects deleting a persisted denied site target before reads or deletes with side effects', async () => {
    ruleRef.current = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'site', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'site', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push([{ id: TARGET_A, orgId: ORG_ID }]);
    const res = await app().request(`/alerts/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('hides a denied requested device from rule test simulation', async () => {
    ruleRef.current = {
      id: RULE_ID, orgId: ORG_ID, templateId: TEMPLATE_ID, targetType: 'device', targetId: TARGET_A,
      overrideSettings: { targets: { type: 'device', ids: [TARGET_A] }, targetIds: [TARGET_A] },
    };
    selectQueue.push(
      [{ id: TARGET_A, orgId: ORG_ID, siteId: ALLOWED_SITE }],
      [{ id: TARGET_B, orgId: ORG_ID, siteId: DENIED_SITE, hostname: 'denied-device', osType: 'linux' }],
    );
    const res = await app().request(`/alerts/rules/${RULE_ID}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: TARGET_B }),
    });
    expect(res.status).toBe(404);
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
