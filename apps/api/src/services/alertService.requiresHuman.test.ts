import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * #5290 — a `requires_human` alert is closed by a person, never by the machine.
 *
 * The two sweep entry points are asserted on their COMPILED SQL, not on column
 * names: a name-only assertion cannot tell an `AND requires_human = false` from
 * an `OR`, and cannot see whether the predicate reached the SELECT at all.
 * `checkAutoResolve` is asserted behaviourally — it must refuse BEFORE any
 * condition evaluation happens.
 */
const { dbMock, resultsQueue, capturedWheres, evaluateConditionsMock } = vi.hoisted(() => {
  const resultsQueue: unknown[][] = [];
  const capturedWheres: unknown[] = [];
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
    capturedWheres,
    evaluateConditionsMock: vi.fn(),
    dbMock: {
      select: vi.fn(() => ({
        from: () => ({
          where: (condition: unknown) => {
            capturedWheres.push(condition);
            return chain();
          },
        }),
      })),
      insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([]) }) })),
      update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) })),
    },
  };
});

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('./alertConditions', () => ({
  evaluateConditions: evaluateConditionsMock,
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(),
  isConfigPolicyRuleCooling: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn(),
  recordStateTransition: vi.fn(),
  isFlapping: vi.fn(async () => false),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveAlertRulesForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: vi.fn(async () => ({ kind: 'resolved', monitors: [] })),
}));
vi.mock('./monitors/episodeService', () => ({
  recordMonitorEvaluation: vi.fn(),
  detachMonitorFromDevice: vi.fn(),
  linkEpisodeAlert: vi.fn(),
}));
vi.mock('./monitors/escalationLatch', () => ({ fireEscalationLatch: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => null) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn() }));

import { checkAutoResolve, checkAutoResolveFromConfigPolicy, checkAllAutoResolve } from './alertService';

const dialect = new PgDialect();
const sqlText = (condition: unknown) => dialect.sqlToQuery(condition as SQL).sql;

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    status: 'active',
    ruleId: 'rule-1',
    deviceId: 'device-1',
    orgId: 'org-1',
    configPolicyId: null,
    requiresHuman: false,
    ...overrides,
  };
}

beforeEach(() => {
  resultsQueue.length = 0;
  capturedWheres.length = 0;
  vi.clearAllMocks();
});

describe('checkAutoResolve and requires_human', () => {
  it('returns false without evaluating conditions for a requires_human alert', async () => {
    resultsQueue.push([alertRow({ requiresHuman: true })]);

    expect(await checkAutoResolve('alert-1')).toBe(false);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    // It must refuse before even loading the rule.
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('still proceeds past the guard for an ordinary alert', async () => {
    resultsQueue.push([alertRow({ requiresHuman: false })]);
    resultsQueue.push([]); // rule lookup — returns nothing, so it bails after the guard

    expect(await checkAutoResolve('alert-1')).toBe(false);
    // The point: it got PAST the requires_human guard and read the rule.
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
});

describe('checkAutoResolveFromConfigPolicy and requires_human', () => {
  it('excludes requires_human alerts in its SELECT', async () => {
    resultsQueue.push([]); // no active alerts — the WHERE is what we assert

    await checkAutoResolveFromConfigPolicy('device-1');

    const where = sqlText(capturedWheres[0]).toLowerCase();
    expect(where).toContain('requires_human');
    // AND, not OR: an OR would re-admit every requires-human alert.
    expect(where).not.toMatch(/or\s+"?alerts"?\."?requires_human/);
  });
});

describe('checkAllAutoResolve and requires_human', () => {
  it('excludes requires_human alerts in its SELECT', async () => {
    resultsQueue.push([]); // no active alerts

    await checkAllAutoResolve('org-1');

    const where = sqlText(capturedWheres[0]).toLowerCase();
    expect(where).toContain('requires_human');
    expect(where).not.toMatch(/or\s+"?alerts"?\."?requires_human/);
  });
});
