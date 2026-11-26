import { describe, expect, it } from 'vitest';
import type { TopologyAlertStreak } from '@breeze/shared';
import { advanceTopologyAlertStreak, runToMonitoringEvent, type TopologyMonitoringEvent } from './monitoringAssessment';

const hex = (c: string) => c.repeat(64);
const emptyStreak: TopologyAlertStreak = {
  contextKey: 'default', family: 'ipv4', policyRevision: '4',
  lastClaimedScheduledFor: null, lastClaimedOccurrenceKey: null, lastAppliedScheduledFor: null, lastAppliedOccurrenceKey: null,
  continuityKey: hex('c'), originDeviceId: null, originAgentId: null, consecutiveFailures: 0, consecutiveSuccesses: 0, activeAlertId: null, lastNotifiedAt: null,
};
const policy = { failureThreshold: 3, recoveryThreshold: 2, alertsEnabled: true };
let slot = 0;
function result(assessment: TopologyMonitoringEvent['assessment'], overrides: Partial<TopologyMonitoringEvent> = {}): TopologyMonitoringEvent {
  slot += 1;
  return {
    kind: 'scheduled_result', policyRevision: '4', contextKey: 'default', family: 'ipv4',
    scheduledFor: new Date(Date.UTC(2026, 8, 15, 0, slot * 5)).toISOString(), occurrenceKey: hex(String(slot % 10)),
    continuityKey: hex('c'), coverage: 'complete', freshness: 'fresh', assessment, runId: null, originDeviceId: null, originAgentId: null, interfaceId: null, interfaceEpoch: null, reason: null,
    ...overrides,
  };
}
const gapEvent = (overrides: Partial<TopologyMonitoringEvent> = {}) => result('unknown', { kind: 'scheduled_gap', coverage: 'none', reason: 'budget_exhausted', ...overrides });

function replay(events: TopologyMonitoringEvent[], start = emptyStreak, thresholds = policy) {
  const actions: string[] = [];
  let streak = start;
  for (const event of events) {
    const decision = advanceTopologyAlertStreak(streak, event, thresholds);
    // The caller attaches the opened/recovered alert id, exactly as applyTopologyPolicyAssessments does.
    streak = decision.action === 'open' ? { ...decision.streak, activeAlertId: '11111111-1111-4111-8111-111111111111' }
      : decision.action === 'recover' ? { ...decision.streak, activeAlertId: null } : decision.streak;
    actions.push(decision.action);
  }
  return { streak, actions };
}

describe('advanceTopologyAlertStreak (M3 Task 8)', () => {
  it('opens exactly at the configured failure threshold and recovers at the recovery threshold', () => {
    const { actions } = replay([result('failed_check'), result('failed_check'), result('failed_check'), result('failed_check')]);
    expect(actions).toEqual(['none', 'none', 'open', 'none']);
    const opened = { ...emptyStreak, activeAlertId: '11111111-1111-4111-8111-111111111111' };
    expect(replay([result('healthy'), result('healthy')], opened).actions).toEqual(['none', 'recover']);
  });

  it('honours configured thresholds instead of hard-coded 3/2 (M3-D8)', () => {
    expect(replay([result('failed_check')], emptyStreak, { ...policy, failureThreshold: 1 }).actions).toEqual(['open']);
    expect(replay([result('failed_check'), result('failed_check'), result('failed_check')], emptyStreak, { ...policy, failureThreshold: 5 }).actions).toEqual(['none', 'none', 'none']);
  });

  it('never opens when alerts are disabled but still tracks the streak', () => {
    const { streak, actions } = replay([result('failed_check'), result('failed_check'), result('failed_check')], emptyStreak, { ...policy, alertsEnabled: false });
    expect(actions).toEqual(['none', 'none', 'none']);
    expect(streak.consecutiveFailures).toBe(3);
  });

  it('breaks the failure streak on a collection gap', () => {
    const old = { ...emptyStreak, consecutiveFailures: 2 };
    const next = advanceTopologyAlertStreak(old, gapEvent(), policy);
    expect(next.streak.consecutiveFailures).toBe(0);
    expect(next.action).toBe('none');
  });

  it.each(['scheduled_gap', 'scheduled_result'] as const)('ignores an older %s without breaking the current streak', (kind) => {
    const previous = { ...emptyStreak, consecutiveFailures: 2, lastAppliedScheduledFor: '2026-09-15T00:10:00.000Z', lastAppliedOccurrenceKey: hex('a') };
    const event = { ...gapEvent(), kind, scheduledFor: '2026-09-15T00:05:00.000Z', occurrenceKey: hex('b') };
    expect(advanceTopologyAlertStreak(previous, event, policy)).toEqual({ streak: previous, action: 'none' });
  });

  it('ignores an equal-slot duplicate and a stale policy revision', () => {
    const first = result('failed_check');
    const applied = advanceTopologyAlertStreak(emptyStreak, first, policy).streak;
    expect(advanceTopologyAlertStreak(applied, first, policy)).toEqual({ streak: applied, action: 'none' });
    expect(advanceTopologyAlertStreak(applied, result('failed_check', { policyRevision: '3' }), policy)).toEqual({ streak: applied, action: 'none' });
  });

  it('starts a fresh series for a new origin (no pre/post-origin mixing) and counts the first measurement', () => {
    const old = { ...emptyStreak, consecutiveFailures: 2 };
    const next = advanceTopologyAlertStreak(old, result('failed_check', { continuityKey: hex('d') }), policy);
    expect(next.streak).toMatchObject({ consecutiveFailures: 1, continuityKey: hex('d') });
    expect(next.action).toBe('none');
  });

  it('does not advance on partial coverage, stale freshness or an orchestration error', () => {
    const old = { ...emptyStreak, consecutiveFailures: 2 };
    for (const event of [result('failed_check', { coverage: 'partial' }), result('failed_check', { freshness: 'stale' }), result('unknown', { reason: 'orchestration_failed' })]) {
      const next = advanceTopologyAlertStreak(old, event, policy);
      expect(next.streak.consecutiveFailures).toBe(0);
      expect(next.action).toBe('none');
    }
  });

  it('ignores on-demand results', () => {
    const old = { ...emptyStreak, consecutiveFailures: 2 };
    expect(advanceTopologyAlertStreak(old, result('failed_check', { kind: 'on_demand_result' }), policy)).toEqual({ streak: old, action: 'none' });
  });
});

describe('runToMonitoringEvent interface provenance', () => {
  const origin = (overrides: Record<string, unknown>) => ({ deviceId: 'dev-1', agentId: 'agent-1', ...overrides });
  const run = (originSnapshot: Record<string, unknown>) => ({
    id: 'run-1', state: 'completed', policyId: 'pol-1', policyRevision: 4n, scheduledContextKey: 'default', scheduledFamily: 'ipv4',
    scheduledFor: new Date('2026-10-01T00:00:00Z'), occurrenceKey: hex('a'), coverage: 'complete', assessment: 'failed_check',
    finishedAt: new Date('2026-10-01T00:00:10Z'), deadline: new Date('2026-10-01T00:01:00Z'), failureReason: null, originSnapshot,
  }) as unknown as Parameters<typeof runToMonitoringEvent>[0];

  it('carries the origin interface id and epoch', () => {
    const event = runToMonitoringEvent(run(origin({ interfaceId: 'if-1', interfaceEpoch: 'gen:1' })));
    expect(event.interfaceId).toBe('if-1');
    expect(event.interfaceEpoch).toBe('gen:1');
  });

  it('carries null for an origin without a single interface (ECMP)', () => {
    const event = runToMonitoringEvent(run(origin({ interfaceId: null, interfaceEpoch: null })));
    expect(event.interfaceId).toBeNull();
    expect(event.interfaceEpoch).toBeNull();
  });
});
