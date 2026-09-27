import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getApplicableRules`'s invalid-monitor-override fallback (#5289) is dead in
 * `alertService.test.ts`, which stubs `resolveMonitorsForDevice` to return
 * `[]` for every case. This file exercises the real `./monitors/kinds`
 * module (applyOverrides + getMonitorKindSpec are NOT mocked) against a
 * resolved monitor whose per-device override does — and doesn't — survive
 * re-validation.
 *
 * `db` is a minimal chainable stand-in: every `.where()` call returns an
 * object that is both directly thenable AND has `.limit()`, sharing one
 * lazily-computed result so it works whichever way `getApplicableRules`
 * happens to consume it (some of its selects call `.limit(1)`, some don't).
 */
const { dbMock, resultsQueue, captureExceptionMock, resolveMonitorsForDeviceMock } = vi.hoisted(() => {
  const resultsQueue: unknown[][] = [];
  const nextResult = () => resultsQueue.shift() ?? [];
  const chain = () => {
    let resolved: unknown[] | undefined;
    const resolveOnce = () => {
      if (resolved === undefined) resolved = nextResult();
      return resolved;
    };
    return {
      limit: () => Promise.resolve(resolveOnce()),
      then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolveOnce()).then(onFulfilled, onRejected),
    };
  };
  return {
    resultsQueue,
    dbMock: {
      select: vi.fn(() => ({
        from: () => ({
          where: () => chain(),
        }),
      })),
    },
    captureExceptionMock: vi.fn(),
    resolveMonitorsForDeviceMock: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    { join: (...args: unknown[]) => ({ op: 'sqlJoin', args }), raw: (s: string) => ({ op: 'raw', s }) },
  ),
  asc: (col: unknown) => ({ op: 'asc', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('../db/schema', () => ({
  alerts: { id: 'alerts.id' },
  alertRules: {
    id: 'alert_rules.id',
    templateId: 'alert_rules.templateId',
    orgId: 'alert_rules.orgId',
    partnerId: 'alert_rules.partnerId',
    targetType: 'alert_rules.targetType',
    targetId: 'alert_rules.targetId',
    isActive: 'alert_rules.isActive',
    managedByMonitorId: 'alert_rules.managedByMonitorId',
  },
  alertTemplates: { id: 'alert_templates.id' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroups: {},
  deviceGroupMemberships: {
    deviceId: 'device_group_memberships.deviceId',
    groupId: 'device_group_memberships.groupId',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  sites: {},
  configPolicyAlertRules: {},
  monitorDefinitions: { id: 'monitor_definitions.id' },
}));

vi.mock('./monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: resolveMonitorsForDeviceMock,
}));

vi.mock('./alertConditions', () => ({
  evaluateConditions: vi.fn(),
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)),
  setCooldown: vi.fn(() => Promise.resolve()),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve('job-1')) }));

// Deliberately NOT mocked: './monitors/kinds' (applyOverrides + getMonitorKindSpec)
// is the real implementation under test here.

import { getApplicableRules } from './alertService';

const DEVICE_ID = 'device-1';

const TEMPLATE_CONDITIONS = { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 80 };

function pushHappyPathQueue() {
  resultsQueue.push([{ orgId: 'org-1', siteId: 'site-1' }]); // device
  resultsQueue.push([]); // device group memberships
  resultsQueue.push([{ partnerId: null }]); // owning org (ownership condition)
  resultsQueue.push([
    {
      id: 'rule-1',
      templateId: 'template-1',
      orgId: 'org-1',
      partnerId: null,
      targetType: 'monitor',
      targetId: 'monitor-1',
      isActive: true,
      managedByMonitorId: 'monitor-1',
      overrideSettings: null,
      name: 'CPU rule',
    },
  ]); // rules
  resultsQueue.push([
    {
      id: 'template-1',
      conditions: TEMPLATE_CONDITIONS,
      severity: 'high',
      cooldownMinutes: 5,
      titleTemplate: 'High CPU on {{deviceName}}',
      messageTemplate: 'CPU {{actualValue}}%',
    },
  ]); // templates
  resultsQueue.push([{ id: 'monitor-1', kind: 'cpu', condition: { operator: 'gt', value: 80 } }]); // monitor definitions
}

beforeEach(() => {
  resultsQueue.length = 0;
  vi.clearAllMocks();
});

describe('getApplicableRules — invalid monitor override fallback (#5289)', () => {
  it('keeps the rule and falls back to the compiled, un-overridden condition when the override fails re-validation', async () => {
    pushHappyPathQueue();
    resolveMonitorsForDeviceMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: 'monitor-1',
          enabled: true,
          // value: 999 is out of the cpu schema's 0-100 range — applyOverrides
          // must throw when re-validating the merged condition.
          overrides: { value: 999 },
          sourcePolicyId: 'policy-1',
          sourceLevel: 'organization',
          inheritedFromParent: false,
        },
      ],
    });

    const result = await getApplicableRules(DEVICE_ID);

    // Must NOT throw, and must NOT drop the rule.
    expect(result).toHaveLength(1);
    const [applicable] = result;
    expect(applicable?.rule.id).toBe('rule-1');
    // Falls back to the compiled condition the template already carries —
    // never the invalid override.
    expect(applicable?.effectiveConditions).toEqual(TEMPLATE_CONDITIONS);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('applies a VALID override into effectiveConditions', async () => {
    pushHappyPathQueue();
    resolveMonitorsForDeviceMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: 'monitor-1',
          enabled: true,
          overrides: { value: 55 },
          sourcePolicyId: 'policy-1',
          sourceLevel: 'organization',
          inheritedFromParent: false,
        },
      ],
    });

    const result = await getApplicableRules(DEVICE_ID);

    expect(result).toHaveLength(1);
    const [applicable] = result;
    expect(applicable?.effectiveConditions).toEqual({
      type: 'threshold',
      metric: 'cpuPercent',
      operator: 'gt',
      value: 55,
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a device that raced a delete (resolver returns device_missing) falls back to the un-overridden template condition, same as no override, without throwing (#5677)', async () => {
    pushHappyPathQueue();
    resolveMonitorsForDeviceMock.mockResolvedValue({ kind: 'device_missing' });

    const result = await getApplicableRules(DEVICE_ID);

    expect(result).toHaveLength(1);
    const [applicable] = result;
    expect(applicable?.effectiveConditions).toEqual(TEMPLATE_CONDITIONS);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
