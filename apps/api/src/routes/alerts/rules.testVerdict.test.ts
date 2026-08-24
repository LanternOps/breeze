import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #3752: POST /alerts/rules/:id/test never evaluated anything. It pushed
// `result: false` for every top-level key of `template.conditions`, so
// `wouldTrigger` was a function of key count rather than of device state — no
// rule carrying a condition could report that it would fire, and no rule
// without one could report that it would not. It also read the template
// conditions directly (the firing path prefers overrideSettings.conditions),
// and evaluated `targetMatch` only for targetType 'device' so every other
// target type reported a match it had never checked.

const { authRef, selectQueue, ruleRef, evaluateConditionsMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  ruleRef: { current: null as Record<string, unknown> | null },
  evaluateConditionsMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
}));

vi.mock('../../db/schema', () => ({
  alertRules: { id: 'rule.id', orgId: 'rule.orgId', partnerId: 'rule.partnerId', templateId: 'rule.templateId', targetType: 'rule.targetType', targetId: 'rule.targetId', isActive: 'rule.isActive', createdAt: 'rule.createdAt' },
  alertTemplates: { id: 'template.id' },
  alerts: { ruleId: 'alert.ruleId', status: 'alert.status' },
  devices: { id: 'device.id', orgId: 'device.orgId', siteId: 'device.siteId' },
  deviceGroups: { id: 'group.id', orgId: 'group.orgId', siteId: 'group.siteId' },
  deviceGroupMemberships: { deviceId: 'membership.deviceId', groupId: 'membership.groupId' },
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
  return {
    db: {
      select: vi.fn(() => makeSelect()),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(() => true),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Partner-wide denied',
}));
vi.mock('../../services/alertConditions', () => ({
  conditionPayloadsFrom: vi.fn(() => []),
  evaluateConditions: evaluateConditionsMock,
  retiredConditionTypeError: vi.fn(() => null),
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 1, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertRuleWithOrgCheck: vi.fn(async () => ruleRef.current),
  isRecord: (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value),
  getOverrides: (value: unknown) => (value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {}),
  normalizeTargetsForRule: vi.fn(),
  getNotificationChannelIds: vi.fn(() => []),
  containsNotificationBindingOverride: vi.fn(() => false),
  validateAlertRuleNotificationBindings: vi.fn(async () => null),
  formatAlertRuleResponse: (rule: unknown) => rule,
  resolveAlertTemplate: vi.fn(),
  retiredConditionReactivationError: vi.fn(() => null),
}));

import { rulesRoutes } from './rules';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '1a1a1a1a-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE_ID = '2a2a2a2a-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DEVICE_ID = '4a4a4a4a-4444-4444-8444-444444444444';
const TEMPLATE_ID = '66666666-6666-4666-8666-666666666666';
const RULE_ID = '77777777-7777-4777-8777-777777777777';

const DEVICE = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'ws-01', osType: 'windows' };
const CPU_CONDITIONS = { logic: 'and', conditions: [{ type: 'threshold', metric: 'cpu_usage', operator: 'gt', value: 80 }] };

function app() {
  const instance = new Hono();
  instance.route('/alerts', rulesRoutes);
  return instance;
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'High CPU',
    templateId: TEMPLATE_ID,
    targetType: 'all',
    targetId: ORG_ID,
    isActive: true,
    overrideSettings: null,
    ...overrides,
  };
}

/**
 * Queue the two selects the handler always makes (device, then template),
 * plus any extra rows a target type needs (group membership).
 */
function queueLookups(template: Record<string, unknown>, extra: unknown[][] = []) {
  selectQueue.push([DEVICE]);
  selectQueue.push([template]);
  for (const rows of extra) selectQueue.push(rows);
}

async function runTest() {
  return app().request(`/alerts/rules/${RULE_ID}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  });
}

describe('POST /alerts/rules/:id/test — real verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    ruleRef.current = rule();
    authRef.current = {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      allowedSiteIds: undefined,
      canAccessOrg: () => true,
      user: { id: 'user-1' },
    };
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-23T00:00:00.000Z' },
    });
  });

  // The core defect: a rule whose conditions the evaluator says ARE met must
  // report that it would fire. The old code could not, because every condition
  // key was hardcoded to `result: false`.
  it('reports wouldTrigger true when the evaluator says the conditions are met', async () => {
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });
    evaluateConditionsMock.mockResolvedValue({
      triggered: true,
      conditionsMet: ['cpu_usage > 80 for 5min'],
      conditionsNotMet: [],
      context: {
        deviceId: DEVICE_ID,
        evaluatedAt: '2026-08-23T00:00:00.000Z',
        metric: 'cpu_usage',
        actualValue: 91,
        threshold: 80,
      },
    });

    const res = await runTest();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.wouldTrigger).toBe(true);
    expect(body.conditionResults).toEqual([
      { condition: 'cpu_usage > 80 for 5min', result: true, reason: 'cpu_usage > 80 for 5min' },
    ]);
    // With no override, the template's own conditions are what gets evaluated.
    expect(evaluateConditionsMock).toHaveBeenCalledWith(CPU_CONDITIONS, DEVICE_ID);
    // The measured values that explain the verdict are passed through intact.
    expect(body.evaluationContext).toEqual({
      deviceId: DEVICE_ID,
      evaluatedAt: '2026-08-23T00:00:00.000Z',
      metric: 'cpu_usage',
      actualValue: 91,
      threshold: 80,
    });
    // The row content queried for the device and template reaches the response.
    expect(body.device).toEqual({ id: DEVICE_ID, hostname: 'ws-01', osType: 'windows' });
    expect(body.rule.severity).toBe('high');
  });

  it('reports the evaluator’s real unmet conditions rather than a simulated placeholder', async () => {
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['cpu_usage > 80 for 5min'],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-23T00:00:00.000Z' },
    });

    const body = await (await runTest()).json();

    expect(body.wouldTrigger).toBe(false);
    expect(body.conditionResults).toEqual([
      { condition: 'cpu_usage > 80 for 5min', result: false, reason: 'cpu_usage > 80 for 5min' },
    ]);
    // The old placeholder text must be gone.
    expect(JSON.stringify(body)).not.toContain('Test evaluation of');
  });

  // An OR group can trigger with some conditions unmet, so the old
  // `conditionResults.every(r => r.result)` was the wrong verdict function.
  it('honours the evaluator verdict when an OR group triggers with an unmet condition', async () => {
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: { logic: 'or', conditions: [] } });
    evaluateConditionsMock.mockResolvedValue({
      triggered: true,
      conditionsMet: ['Device offline for 5min'],
      conditionsNotMet: ['cpu_usage > 80 for 5min'],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-23T00:00:00.000Z' },
    });

    const body = await (await runTest()).json();

    expect(body.wouldTrigger).toBe(true);
    expect(body.conditionResults.some((r: { result: boolean }) => !r.result)).toBe(true);
  });

  // The firing path resolves overrideSettings.conditions first; testing the
  // template instead reports on conditions the rule does not use.
  it('evaluates the override conditions in preference to the template', async () => {
    const override = { logic: 'and', conditions: [{ type: 'offline', durationMinutes: 10 }] };
    ruleRef.current = rule({ overrideSettings: { conditions: override } });
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

    await runTest();

    expect(evaluateConditionsMock).toHaveBeenCalledWith(override, DEVICE_ID);
  });

  it('uses the override severity when one is set', async () => {
    ruleRef.current = rule({ overrideSettings: { severity: 'critical' } });
    queueLookups({ id: TEMPLATE_ID, severity: 'low', conditions: CPU_CONDITIONS });

    const body = await (await runTest()).json();

    expect(body.rule.severity).toBe('critical');
  });

  describe('target matching', () => {
    it('matches an all-targeted rule against any device', async () => {
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

      const body = await (await runTest()).json();

      expect(body.targetMatch).toBe(true);
      expect(body.targetReason).toBe('Rule applies to all devices');
    });

    it('reports a site-targeted rule as not matching a device in another site', async () => {
      ruleRef.current = rule({ targetType: 'site', targetId: OTHER_SITE_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });
      evaluateConditionsMock.mockResolvedValue({
        triggered: true, conditionsMet: ['cpu_usage > 80 for 5min'], conditionsNotMet: [],
        context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-23T00:00:00.000Z' },
      });

      const body = await (await runTest()).json();

      expect(body.targetMatch).toBe(false);
      // Conditions met but the rule does not target this device: still no fire.
      expect(body.wouldTrigger).toBe(false);
      expect(body.targetReason).toBeTruthy();
    });

    it('reports a site-targeted rule as matching a device in that site', async () => {
      ruleRef.current = rule({ targetType: 'site', targetId: SITE_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

      const body = await (await runTest()).json();
      expect(body.targetMatch).toBe(true);
    });

    it('reports an org-targeted rule as not matching a device in another org', async () => {
      ruleRef.current = rule({ targetType: 'org', targetId: OTHER_ORG_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

      const body = await (await runTest()).json();
      expect(body.targetMatch).toBe(false);
    });

    it('checks group membership for a group-targeted rule', async () => {
      ruleRef.current = rule({ targetType: 'group', targetId: GROUP_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS }, [[]]);

      const body = await (await runTest()).json();
      expect(body.targetMatch).toBe(false);
    });

    it('matches a group-targeted rule when the device is a member', async () => {
      ruleRef.current = rule({ targetType: 'group', targetId: GROUP_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS }, [[{ groupId: GROUP_ID }]]);

      const body = await (await runTest()).json();
      expect(body.targetMatch).toBe(true);
    });

    it('reports a device-targeted rule as not matching a different device', async () => {
      ruleRef.current = rule({ targetType: 'device', targetId: OTHER_DEVICE_ID });
      queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

      const body = await (await runTest()).json();
      expect(body.targetMatch).toBe(false);
    });
  });

  // A disabled rule is filtered out by getApplicableRules, so it never fires
  // however well its conditions evaluate.
  it('reports a disabled rule as not firing even when its conditions are met', async () => {
    ruleRef.current = rule({ isActive: false });
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });
    evaluateConditionsMock.mockResolvedValue({
      triggered: true, conditionsMet: ['cpu_usage > 80 for 5min'], conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-23T00:00:00.000Z' },
    });

    const body = await (await runTest()).json();

    expect(body.wouldTrigger).toBe(false);
    expect(body.rule.enabled).toBe(false);
  });

  // The response must not carry the invented fields the client used to read.
  it('does not return success/message fields', async () => {
    queueLookups({ id: TEMPLATE_ID, severity: 'high', conditions: CPU_CONDITIONS });

    const body = await (await runTest()).json();

    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('message');
    expect(body).toHaveProperty('wouldTrigger');
  });
});
