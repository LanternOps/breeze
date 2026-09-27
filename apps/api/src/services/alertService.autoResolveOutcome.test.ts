import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auto-resolution reports compare-and-swap winners only.
const { dbMock, selectQueues, updateReturns, updateCount } = vi.hoisted(() => {
  const selectQueues = new Map<string, unknown[][]>();
  const updateReturns: unknown[][] = [];
  const updateCount = { current: 0 };

  // Queues are keyed by the real Drizzle table object, resolved via its symbol
  // name, so a test seeds rows per table rather than by call order.
  const tableName = (table: unknown): string => {
    const symbols = Object.getOwnPropertySymbols(table as object);
    for (const symbol of symbols) {
      if (symbol.description?.includes('Name')) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === 'string') return value;
      }
    }
    return 'unknown';
  };

  const take = (table: unknown): unknown[] => selectQueues.get(tableName(table))?.shift() ?? [];

  const dbMock = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = take(table);
          return {
            limit: () => Promise.resolve(rows),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            updateCount.current += 1;
            return Promise.resolve(updateReturns.shift() ?? []);
          },
        }),
      }),
    }),
  };

  return { dbMock, selectQueues, updateReturns, updateCount };
});

const evaluateConditions = vi.fn();
const evaluateAutoResolveConditions = vi.fn();
const setCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./alertConditions', () => ({
  evaluateConditions: (...args: unknown[]) => evaluateConditions(...args),
  evaluateAutoResolveConditions: (...args: unknown[]) => evaluateAutoResolveConditions(...args),
  interpolateTemplate: (t: string) => t,
}));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)),
  setCooldown: (...args: unknown[]) => setCooldown(...args),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(() => Promise.resolve(null)),
  isInMaintenanceWindow: vi.fn(() => false),
}));
vi.mock('./eventBus', () => ({ publishEvent: (...args: unknown[]) => publishEvent(...args) }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve()) }));

import { checkAutoResolve } from './alertService';

const seed = (table: string, ...batches: unknown[][]) => selectQueues.set(table, batches);

const TRIGGERED_AT = new Date('2026-08-29T10:00:00.000Z');
const RESOLVED_AT = new Date('2026-08-29T10:05:00.000Z');
// `alert.resolved` carries triggeredAt/resolvedAt off the RETURNING row (C2 fix in
// resolveAlert) — `triggeredAt` is NOT NULL and the same UPDATE sets `resolvedAt`, so
// a fixture row must model both or the publish path throws on `.toISOString()`.
const resolved = <T extends object>(row: T) => ({ ...row, status: 'resolved', resolvedAt: RESOLVED_AT });

beforeEach(() => {
  selectQueues.clear();
  updateReturns.length = 0;
  updateCount.current = 0;
  vi.clearAllMocks();
  evaluateConditions.mockResolvedValue({ triggered: false });
  evaluateAutoResolveConditions.mockResolvedValue({ shouldResolve: true, reason: 'cleared' });
  setCooldown.mockResolvedValue(undefined);
  publishEvent.mockResolvedValue('evt');
});

const legacyAlert = {
  id: 'a-legacy',
  orgId: 'org-1',
  deviceId: 'device-1',
  ruleId: 'rule-1',
  configPolicyId: null,
  status: 'active',
  triggeredAt: TRIGGERED_AT,
  resolvedAt: null as Date | null,
};
const legacyRule = { id: 'rule-1', templateId: 'tpl-1', overrideSettings: null };

type LegacyTemplate = {
  id: string;
  autoResolve: boolean;
  autoResolveConditions: unknown;
  conditions: unknown;
  cooldownMinutes: number;
};

const legacyTemplateInverseTrigger: LegacyTemplate = {
  id: 'tpl-1',
  autoResolve: true,
  autoResolveConditions: null,
  conditions: { all: [] },
  cooldownMinutes: 15,
};

const legacyTemplateExplicitConditions: LegacyTemplate = {
  ...legacyTemplateInverseTrigger,
  autoResolveConditions: { all: [{ metric: 'cpu', op: 'lt', value: 50 }] },
};

const bothTemplateShapes: Array<[string, LegacyTemplate]> = [
  ['inverse-trigger branch (autoResolveConditions null)', legacyTemplateInverseTrigger],
  ['explicit-conditions branch (autoResolveConditions set)', legacyTemplateExplicitConditions],
];

describe.each(bothTemplateShapes)(
  'checkAutoResolve reports the compare-and-swap outcome — %s',
  (_label, template) => {
    it('returns false when another resolver won the race', async () => {
      seed('alerts', [legacyAlert]);
      seed('alert_rules', [legacyRule]);
      seed('alert_templates', [template]);
      updateReturns.push([]); // CAS matched nothing

      await expect(checkAutoResolve('a-legacy')).resolves.toBe(false);
      expect(publishEvent).not.toHaveBeenCalled();
    });

    it('returns true when this caller performed the transition', async () => {
      seed('alerts', [legacyAlert]);
      seed('alert_rules', [legacyRule], [legacyRule]);
      seed('alert_templates', [template], [template]);
      updateReturns.push([resolved(legacyAlert)]);

      await expect(checkAutoResolve('a-legacy')).resolves.toBe(true);
      expect(publishEvent).toHaveBeenCalledTimes(1);
    });
  }
);

describe('checkAutoResolve takes the branch the fixture selects', () => {
  // Guards the parameterisation above: if both template fixtures silently routed
  // through the same arm, every branch-sensitive assertion would be testing one
  // arm twice.
  it('evaluates the trigger conditions when autoResolveConditions is null', async () => {
    seed('alerts', [legacyAlert]);
    seed('alert_rules', [legacyRule], [legacyRule]);
    seed('alert_templates', [legacyTemplateInverseTrigger], [legacyTemplateInverseTrigger]);
    updateReturns.push([resolved(legacyAlert)]);

    await checkAutoResolve('a-legacy');

    expect(evaluateConditions).toHaveBeenCalledTimes(1);
    expect(evaluateAutoResolveConditions).not.toHaveBeenCalled();
  });

  it('evaluates the explicit auto-resolve conditions when they are set', async () => {
    seed('alerts', [legacyAlert]);
    seed('alert_rules', [legacyRule], [legacyRule]);
    seed('alert_templates', [legacyTemplateExplicitConditions], [legacyTemplateExplicitConditions]);
    updateReturns.push([resolved(legacyAlert)]);

    await checkAutoResolve('a-legacy');

    expect(evaluateAutoResolveConditions).toHaveBeenCalledTimes(1);
    expect(evaluateConditions).not.toHaveBeenCalled();
  });
});

// Retired sources never participate in automatic resolution.
it('leaves history-only policy alerts open without evaluating conditions', async () => {
  seed('alerts', [{ ...legacyAlert, ruleId: null, configPolicyId: 'retired-source' }]);
  await expect(checkAutoResolve('a-legacy')).resolves.toBe(false);
  expect(evaluateConditions).not.toHaveBeenCalled();
  expect(evaluateAutoResolveConditions).not.toHaveBeenCalled();
  expect(updateCount.current).toBe(0);
  expect(setCooldown).not.toHaveBeenCalled();
});
