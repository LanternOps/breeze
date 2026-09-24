import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OfflineEffect } from '../db/schema';

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  applicable: vi.fn(), lock: vi.fn(), finish: vi.fn(), child: vi.fn(),
  lease: vi.fn(), update: vi.fn(), updateWhere: vi.fn(), insert: vi.fn(), maintenance: vi.fn(),
}));
vi.mock('../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  db: {
    select: () => {
      const chain = {
        from: () => chain, innerJoin: () => chain, where: () => chain,
        orderBy: () => chain, limit: () => chain,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(mocks.rows.shift() ?? []).then(resolve),
      };
      return chain;
    },
    update: () => ({ set: mocks.update }),
    insert: () => ({ values: mocks.insert }),
  },
}));
vi.mock('./alertService', () => ({
  alertRuleOwnershipConditionForOrg: vi.fn(), getApplicableRules: mocks.applicable,
}));
vi.mock('./offlineEffectsStore', async (original) => ({
  ...await original<typeof import('./offlineEffectsStore')>(),
  withOfflineEffectLease: mocks.lease, lockCurrentOfflineObservation: mocks.lock,
  finishOfflineEffect: mocks.finish, insertOfflineEffect: mocks.child,
}));
vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: mocks.maintenance,
  isInMaintenanceWindow: (value: unknown) => value,
}));
vi.mock('./alertConditions', () => ({ evaluateConditions: vi.fn(), interpolateTemplate: (s: string) => s }));
vi.mock('./redis', () => ({ getRedisConnection: vi.fn() }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn() }));
vi.mock('./offlineAlertPostprocess', () => ({
  readOfflineAlertRedisSuppression: async () => ({ cooling: false, flapping: false, multiplier: 1 }),
  applyOfflineAlertPostprocess: vi.fn(),
}));

import { admitOfflineAlertRule, expandOfflineAlertPlan } from './offlineAlertEffects';

const observation = {
  deviceId: '00000000-0000-4000-8000-000000000001', orgId: '00000000-0000-4000-8000-000000000002',
  siteId: '00000000-0000-4000-8000-000000000003', hostname: 'device', displayName: null,
  osType: 'linux', osVersion: '1', observedLastSeenAt: '2026-09-19T10:00:00.000Z',
};
const monitor = {
  rule: { id: 'rule', name: 'Offline monitor', targetType: 'monitor', managedByMonitorId: 'monitor' },
  template: { id: 'template', titleTemplate: 'Offline', messageTemplate: 'Offline duration', conditions: { type: 'offline', durationMinutes: 5 } },
  monitor: { id: 'monitor', kind: 'offline' },
  effectiveConditions: { type: 'offline', durationMinutes: 60 },
  effectiveSeverity: 'critical', effectiveCooldownMinutes: 10,
};
function effect(type: 'alert-plan' | 'alert-rule' = 'alert-plan'): OfflineEffect {
  return {
    id: 'effect', transitionId: 'transition', orgId: observation.orgId, deviceId: observation.deviceId,
    leaseToken: 'lease', payload: type === 'alert-plan' ? { type, observation } : {
      type, observation, rule: {
        ruleId: 'rule', monitorId: 'monitor', name: 'Offline monitor', templateId: 'template',
        conditions: monitor.effectiveConditions, severity: 'critical', cooldownMinutes: 10,
        titleTemplate: 'Offline', messageTemplate: 'Offline duration',
      },
    },
  } as unknown as OfflineEffect;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-19T10:05:00Z'));
  mocks.rows = [];
  mocks.applicable.mockResolvedValue([monitor]);
  mocks.lock.mockResolvedValue({ ...observation, id: observation.deviceId });
  mocks.lease.mockImplementation(async (_effect, fn) => fn());
  mocks.child.mockResolvedValue('child');
  mocks.maintenance.mockResolvedValue(null);
  mocks.update.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockReturnValue({ returning: async () => [{ id: 'effect' }] });
  mocks.insert.mockReturnValue({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'alert' }] }) });
});
afterEach(() => vi.useRealTimers());

describe('offline monitor effects (#6342)', () => {
  it('plans effective offline monitors without evaluating legacy policy rules', async () => {
    await expandOfflineAlertPlan(effect());
    expect(mocks.child).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'alert-rule', rule: expect.objectContaining({
        ruleId: 'rule', monitorId: 'monitor',
        conditions: { type: 'offline', durationMinutes: 60 }, severity: 'critical',
      }),
    }), 'rule');
    expect(readFileSync(new URL('./offlineAlertEffects.ts', import.meta.url), 'utf8'))
      .not.toMatch(/getApplicableRulesFromPolicy/);
    expect(mocks.child).toHaveBeenCalledTimes(1);
    expect(mocks.child.mock.calls[0]![1].rule).not.toHaveProperty('policy');
  });

  it('contains no policy dispatch or legacy cooldown writer in durable effects', () => {
    for (const name of ['offlineAlertEffects.ts', 'offlineAlertPostprocess.ts']) {
      expect(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
        .not.toMatch(/rule\.policy|p\.policy|cooldown:cpar|configPolicyAlertRules/);
    }
  });

  it('does not plan other monitor kinds or monitors excluded by effective resolution', async () => {
    mocks.applicable.mockResolvedValue([{ ...monitor, monitor: { id: 'monitor', kind: 'cpu' } }]);
    await expandOfflineAlertPlan(effect());
    expect(mocks.child).not.toHaveBeenCalled();
    mocks.applicable.mockResolvedValue([]);
    await expandOfflineAlertPlan(effect());
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it.each(['2026-09-19T10:05:00Z', '2026-09-19T11:00:00Z'])('defers a long-duration monitor at %s with the live lease instead of completing it', async (now) => {
    vi.setSystemTime(new Date(now));
    mocks.rows = [[{ id: observation.deviceId }], [{ id: 'rule' }]];
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      availableAt: new Date('2026-09-19T11:00:00.001Z'), leaseToken: null, leaseUntil: null,
    }));
    const query = new PgDialect().sqlToQuery(mocks.updateWhere.mock.calls[0]![0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining(['effect', 'lease']));
    expect(query.sql).toContain('"completed_at" is null');
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('admits the monitor after its duration through the observation lock and existing alert effects', async () => {
    vi.setSystemTime(new Date('2026-09-19T11:00:00.001Z'));
    mocks.rows = [[{ id: observation.deviceId }], [{ id: 'rule' }], [{ id: 'rule' }], [], [], [], []];
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.lock).toHaveBeenCalledWith(observation);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule', monitorId: 'monitor', configPolicyId: null,
      context: expect.objectContaining({ durationMinutes: 60 }),
    }));
    expect(mocks.child).toHaveBeenCalledTimes(2);
    expect(mocks.finish).toHaveBeenCalled();
  });

  it('cancels a delayed monitor when the observation becomes stale', async () => {
    mocks.rows = [[{ id: observation.deviceId }], [{ id: 'rule' }]];
    mocks.lock.mockResolvedValue(null);
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.finish).toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects deferral if the lease expires before the update', async () => {
    mocks.rows = [[{ id: observation.deviceId }], [{ id: 'rule' }]];
    mocks.updateWhere.mockReturnValue({ returning: async () => [] });
    await expect(admitOfflineAlertRule(effect('alert-rule'))).rejects.toThrow('Offline effect lease expired before deferral');
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('keeps a long-duration monitor pending when maintenance may end before its deadline', async () => {
    mocks.rows = [[{ id: observation.deviceId }], [{ id: 'rule' }]];
    mocks.maintenance.mockResolvedValue({ active: true, suppressAlerts: true });
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ availableAt: new Date('2026-09-19T11:00:00.001Z') }));
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('does not plan effects without an owned lease', async () => {
    mocks.lease.mockResolvedValue(undefined);
    await expandOfflineAlertPlan(effect());
    expect(mocks.applicable).not.toHaveBeenCalled();
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it.each(['cooldown', 'open'] as const)('preserves %s suppression for a due monitor', async (reason) => {
    vi.setSystemTime(new Date('2026-09-19T11:01:00Z'));
    mocks.rows = [
      [{ id: observation.deviceId }], [{ id: 'rule' }], [{ id: 'rule' }],
      [{ cooling: reason === 'cooldown', triggers: 0 }], [], [], reason === 'open' ? [{ id: 'existing' }] : [],
    ];
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.child).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalled();
  });

  it.each(['detached', 'maintenance', 'moved'] as const)('does not admit a %s monitor', async (reason) => {
    vi.setSystemTime(new Date('2026-09-19T11:01:00Z'));
    mocks.rows = reason === 'moved' ? [[]] : [[{ id: observation.deviceId }], [{ id: 'rule' }], [{ id: 'rule' }], [], [], [], []];
    if (reason === 'detached') mocks.applicable.mockResolvedValue([]);
    if (reason === 'maintenance') mocks.maintenance.mockResolvedValue({ active: true, suppressAlerts: true });
    await admitOfflineAlertRule(effect('alert-rule'));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalled();
  });
});
