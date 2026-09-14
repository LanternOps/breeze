import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #5289 — this file (`ruleRoutes`, mounted at /alert-templates) is a SECOND,
// separate writer of alert_rules alongside routes/alerts/rules.ts (mounted at
// /alerts/rules) — a gap the original plan's file list missed. A rule
// compiled from a monitor definition (managed_by_monitor_id set) must refuse
// PATCH, DELETE and the toggle route here too, or a side edit through this
// legacy surface would silently drift the row from its monitor definition
// until the next compile pass overwrote it.

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
const MONITOR_ID = '55555555-5555-4555-8555-666677778888';

function app() {
  const instance = new Hono();
  instance.route('/alert-templates', ruleRoutes);
  return instance;
}

function managedRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    orgId: ORG_ID,
    partnerId: null,
    templateId: 't-1',
    targetType: 'device',
    targetId: 'd-1',
    overrideSettings: null,
    isActive: true,
    name: 'Compiled rule',
    createdAt: new Date(),
    managedByMonitorId: MONITOR_ID,
    ...overrides,
  };
}

describe('legacy alert-template rules — managed-by-monitor guard (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null, allowedSiteIds: undefined,
      canAccessOrg: () => true, user: { id: 'user-1' },
    };
  });

  it('PATCH /alert-templates/rules/:id on a monitor-managed rule is 409 alert_rule_managed_by_monitor', async () => {
    selectQueue.push([{ partnerId: null }], [managedRule()]);
    const res = await app().request(`/alert-templates/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_rule_managed_by_monitor', monitorId: MONITOR_ID });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('DELETE /alert-templates/rules/:id on a monitor-managed rule is 409 alert_rule_managed_by_monitor', async () => {
    selectQueue.push([{ partnerId: null }], [managedRule()]);
    const res = await app().request(`/alert-templates/rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_rule_managed_by_monitor', monitorId: MONITOR_ID });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('POST /alert-templates/rules/:id/toggle on a monitor-managed rule is 409 alert_rule_managed_by_monitor', async () => {
    selectQueue.push([{ partnerId: null }], [managedRule()]);
    const res = await app().request(`/alert-templates/rules/${RULE_ID}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'alert_rule_managed_by_monitor', monitorId: MONITOR_ID });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
