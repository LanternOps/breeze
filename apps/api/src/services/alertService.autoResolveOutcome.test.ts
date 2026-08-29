import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auto-resolve sweeps must report what `resolveAlert`'s compare-and-swap
 * ACTUALLY did (#4094).
 *
 * Before this suite, `checkAutoResolve` returned a hard-coded `true` and
 * `checkAutoResolveFromConfigPolicy` incremented `resolvedCount` (and wrote the
 * config-policy cooldown) unconditionally. A sweep that lost the race to the
 * monitor worker, a `policy.compliant` redelivery, or a technician therefore
 * reported a resolution it never performed AND stamped a cooldown that suppresses
 * the next legitimate alert for that rule.
 *
 * Only the CONNECTION is mocked here — drizzle-orm and ../db/schema are real, so
 * nothing in this file depends on matching a predicate by its column names.
 */
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
const markConfigPolicyRuleCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
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
  isConfigPolicyRuleCooling: vi.fn(() => Promise.resolve(false)),
  markConfigPolicyRuleCooldown: (...args: unknown[]) => markConfigPolicyRuleCooldown(...args),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('./featureConfigResolver', () => ({
  resolveAlertRulesForDevice: vi.fn(() => Promise.resolve([])),
  resolveMaintenanceConfigForDevice: vi.fn(() => Promise.resolve(null)),
  isInMaintenanceWindow: vi.fn(() => false),
}));
vi.mock('./eventBus', () => ({ publishEvent: (...args: unknown[]) => publishEvent(...args) }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve()) }));

import { checkAutoResolve, checkAutoResolveFromConfigPolicy } from './alertService';

const seed = (table: string, ...batches: unknown[][]) => selectQueues.set(table, batches);

const TRIGGERED_AT = new Date('2026-08-29T10:00:00.000Z');
const RESOLVED_AT = new Date('2026-08-29T10:05:00.000Z');
// `alert.resolved` carries triggeredAt/resolvedAt off the RETURNING row (C2 fix in
// resolveAlert) — `triggeredAt` is NOT NULL and the same UPDATE sets `resolvedAt`, so
// a fixture row must model both or the publish path throws on `.toISOString()`.
const resolved = <T extends object>(row: T) => ({ ...row, status: 'resolved', resolvedAt: RESOLVED_AT });

const cpAlert = (id: string) => ({
  id,
  orgId: 'org-1',
  deviceId: 'device-1',
  ruleId: null,
  configPolicyId: 'cp-rule-1',
  status: 'active',
  triggeredAt: TRIGGERED_AT,
  resolvedAt: null as Date | null,
});

/**
 * `checkAutoResolveFromConfigPolicy` forks on `rule.autoResolveConditions`, and the
 * CAS-outcome gate is duplicated in BOTH arms. A fixture that pins this field to one
 * value would leave the other arm free to regress with this suite still green — the
 * uniform-fixture blind spot that shipped #3975 — so the suites below run against
 * both, and `bothRuleShapes` exists to make forgetting that awkward.
 */
type CpRule = {
  id: string;
  autoResolve: boolean;
  autoResolveConditions: unknown;
  conditions: unknown;
  cooldownMinutes: number;
};

const cpRuleInverseTrigger: CpRule = {
  id: 'cp-rule-1',
  autoResolve: true,
  autoResolveConditions: null,
  conditions: { all: [] },
  cooldownMinutes: 30,
};

const cpRuleExplicitConditions: CpRule = {
  ...cpRuleInverseTrigger,
  autoResolveConditions: { all: [{ metric: 'cpu', op: 'lt', value: 50 }] },
};

const bothRuleShapes: Array<[string, CpRule]> = [
  ['inverse-trigger branch (autoResolveConditions null)', cpRuleInverseTrigger],
  ['explicit-conditions branch (autoResolveConditions set)', cpRuleExplicitConditions],
];

// Kept for the single-shape suites below that are not branch-sensitive.
const cpRule = cpRuleInverseTrigger;

beforeEach(() => {
  selectQueues.clear();
  updateReturns.length = 0;
  updateCount.current = 0;
  vi.clearAllMocks();
  evaluateConditions.mockResolvedValue({ triggered: false });
  evaluateAutoResolveConditions.mockResolvedValue({ shouldResolve: true, reason: 'cleared' });
  markConfigPolicyRuleCooldown.mockResolvedValue(undefined);
  setCooldown.mockResolvedValue(undefined);
  publishEvent.mockResolvedValue('evt');
});

describe.each(bothRuleShapes)(
  'checkAutoResolveFromConfigPolicy counts compare-and-swap winners only — %s',
  (_label, rule) => {
    it('does not count an alert another resolver already transitioned', async () => {
      seed('alerts', [cpAlert('a-win'), cpAlert('a-lose')]);
      // resolveAlert re-reads the policy rule on the winning path only.
      seed('config_policy_alert_rules', [rule], [rule]);
      updateReturns.push([resolved(cpAlert('a-win'))]); // CAS matched: this sweep won
      updateReturns.push([]);                 // CAS matched nothing: someone else won

      await expect(checkAutoResolveFromConfigPolicy('device-1')).resolves.toBe(1);

      // Both alerts were attempted — the count is filtered by the CAS outcome, not
      // by skipping the attempt.
      expect(updateCount.current).toBe(2);
    });

    it('publishes alert.resolved once per real transition, not once per attempt', async () => {
      seed('alerts', [cpAlert('a-win'), cpAlert('a-lose')]);
      seed('config_policy_alert_rules', [rule], [rule]);
      updateReturns.push([resolved(cpAlert('a-win'))]);
      updateReturns.push([]);

      await checkAutoResolveFromConfigPolicy('device-1');

      expect(publishEvent).toHaveBeenCalledTimes(1);
      expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.resolved');
    });

    it('writes the config-policy cooldown exactly once for the winner and never for the loser', async () => {
      seed('alerts', [cpAlert('a-win'), cpAlert('a-lose')]);
      seed('config_policy_alert_rules', [rule], [rule]);
      updateReturns.push([resolved(cpAlert('a-win'))]);
      updateReturns.push([]);

      await checkAutoResolveFromConfigPolicy('device-1');

      // One write, from inside resolveAlert's winning path. Two would mean the
      // caller re-added its own duplicate; zero would mean the winner's cooldown
      // was lost; any write attributable to `a-lose` suppresses a rule that this
      // sweep never actually resolved.
      expect(markConfigPolicyRuleCooldown).toHaveBeenCalledTimes(1);
      expect(markConfigPolicyRuleCooldown).toHaveBeenCalledWith('cp-rule-1', 'device-1', 30);
    });

    it('counts every winner when nobody races the sweep', async () => {
      seed('alerts', [cpAlert('a-1'), cpAlert('a-2')]);
      seed('config_policy_alert_rules', [rule], [rule], [rule]);
      updateReturns.push([resolved(cpAlert('a-1'))]);
      updateReturns.push([resolved(cpAlert('a-2'))]);

      await expect(checkAutoResolveFromConfigPolicy('device-1')).resolves.toBe(2);
      expect(publishEvent).toHaveBeenCalledTimes(2);
    });
  }
);

describe('checkAutoResolveFromConfigPolicy takes the branch the fixture selects', () => {
  // Guards the parameterisation above: if both fixtures silently routed through
  // the same arm, every branch-sensitive assertion would be testing one arm twice.
  it('evaluates the trigger conditions when autoResolveConditions is null', async () => {
    seed('alerts', [cpAlert('a-1')]);
    seed('config_policy_alert_rules', [cpRuleInverseTrigger], [cpRuleInverseTrigger]);
    updateReturns.push([resolved(cpAlert('a-1'))]);

    await checkAutoResolveFromConfigPolicy('device-1');

    expect(evaluateConditions).toHaveBeenCalledTimes(1);
    expect(evaluateAutoResolveConditions).not.toHaveBeenCalled();
  });

  it('evaluates the explicit auto-resolve conditions when they are set', async () => {
    seed('alerts', [cpAlert('a-1')]);
    seed('config_policy_alert_rules', [cpRuleExplicitConditions], [cpRuleExplicitConditions]);
    updateReturns.push([resolved(cpAlert('a-1'))]);

    await checkAutoResolveFromConfigPolicy('device-1');

    expect(evaluateAutoResolveConditions).toHaveBeenCalledTimes(1);
    expect(evaluateConditions).not.toHaveBeenCalled();
  });
});

/**
 * `checkAutoResolve` forks on `autoResolveConditions` exactly like the config-policy
 * sweep above, and the CAS-outcome gate is likewise duplicated in BOTH arms
 * (alertService.ts ~231-250). Pinning the template to one shape would leave the
 * other arm free to revert to `await resolveAlert(...); return true;` with this
 * suite still green — the same uniform-fixture blind spot (#3975) — so both suites
 * below run against both template shapes.
 */
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
