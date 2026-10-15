import { describe, expect, it } from 'vitest';
import { planTransitions } from './transitions';
import type { HealthObservation, TrackedIncident } from './types';

const NOW = new Date('2026-10-15T12:00:00Z');
const obs = (over: Partial<HealthObservation> = {}): HealthObservation => ({
  sourceKind: 'oauth_grant', sourceId: 's1', partnerId: 'p1', orgId: null, ownerUserId: null,
  state: 'broken', severity: 'transient', condition: 'sync_failed', detail: null,
  displayName: 'X', fixHref: '/integrations', ownerFixHref: null,
  viewPermission: { resource: 'connected_apps', action: 'read' },
  repairPermission: { resource: 'connected_apps', action: 'manage' },
  observedAt: NOW, ...over,
});
const open = (over: Partial<TrackedIncident> = {}): TrackedIncident => ({
  id: 'i1', sourceId: 's1', severity: 'transient', openedAt: new Date('2026-10-15T10:00:00Z'),
  resolvedAt: null, healthyStreak: 0, ...over,
});
const plan = (o: HealthObservation[], t: TrackedIncident[], seed = false) =>
  planTransitions({ observations: o, tracked: t, now: NOW, seed });

describe('planTransitions', () => {
  it('opens a permanent failure immediately and notifies', () => {
    expect(plan([obs({ severity: 'permanent' })], [])).toEqual([
      { type: 'insertOpen', obs: obs({ severity: 'permanent' }), notify: true },
    ]);
  });
  it('records a first transient failure as pending only', () => {
    expect(plan([obs()], [])).toEqual([{ type: 'insertPending', obs: obs() }]);
  });
  it('promotes a pending transient on the second consecutive broken observation', () => {
    expect(plan([obs()], [open({ openedAt: null })])).toEqual([
      { type: 'promotePending', incidentId: 'i1', obs: obs(), notify: true },
    ]);
  });
  it('deletes a pending row when the connection is healthy', () => {
    expect(plan([obs({ state: 'healthy' })], [open({ openedAt: null })])).toEqual([
      { type: 'deletePending', incidentId: 'i1' },
    ]);
  });
  it('updates an open incident and flags escalation transient→permanent', () => {
    expect(plan([obs({ severity: 'permanent' })], [open()])).toEqual([
      { type: 'update', incidentId: 'i1', obs: obs({ severity: 'permanent' }), escalated: true },
    ]);
  });
  it('does not flag escalation for permanent→permanent', () => {
    expect(plan([obs({ severity: 'permanent' })], [open({ severity: 'permanent' })])[0])
      .toMatchObject({ type: 'update', escalated: false });
  });
  it('needs two consecutive healthy observations to resolve', () => {
    expect(plan([obs({ state: 'healthy' })], [open()])).toEqual([
      { type: 'healthyTick', incidentId: 'i1', healthyStreak: 1 },
    ]);
    expect(plan([obs({ state: 'healthy' })], [open({ healthyStreak: 1 })])).toEqual([
      { type: 'resolve', incidentId: 'i1', resolution: 'recovered' },
    ]);
  });
  it('a broken observation after one healthy tick emits an update (store resets the streak)', () => {
    expect(plan([obs()], [open({ healthyStreak: 1 })])[0]).toMatchObject({ type: 'update', incidentId: 'i1' });
  });
  it('unknown never opens, resolves or ticks', () => {
    expect(plan([obs({ state: 'unknown' })], [])).toEqual([]);
    expect(plan([obs({ state: 'unknown' })], [open({ healthyStreak: 1 })])).toEqual([]);
    expect(plan([obs({ state: 'unknown' })], [open({ openedAt: null })])).toEqual([]);
  });
  it('retired resolves an open incident as retired and deletes a pending one', () => {
    expect(plan([obs({ state: 'retired' })], [open()])).toEqual([{ type: 'resolve', incidentId: 'i1', resolution: 'retired' }]);
    expect(plan([obs({ state: 'retired' })], [open({ openedAt: null })])).toEqual([{ type: 'deletePending', incidentId: 'i1' }]);
  });
  it('a tracked open id missing from the observations is retired', () => {
    expect(plan([], [open()])).toEqual([{ type: 'resolve', incidentId: 'i1', resolution: 'retired' }]);
  });
  it('reopens an incident resolved inside the 60-minute window instead of creating one', () => {
    const resolved = open({ resolvedAt: new Date('2026-10-15T11:30:00Z') });
    expect(plan([obs()], [resolved])).toEqual([{ type: 'reopen', incidentId: 'i1', obs: obs() }]);
  });
  it('reopens at exactly the 60-minute boundary (inclusive)', () => {
    const resolved = open({ resolvedAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    expect(plan([obs()], [resolved])).toEqual([{ type: 'reopen', incidentId: 'i1', obs: obs() }]);
  });
  it('opens a new incident when the resolved row is outside the reopen window', () => {
    const resolved = open({ resolvedAt: new Date(NOW.getTime() - 61 * 60 * 1000) });
    const p = obs({ severity: 'permanent' });
    expect(plan([p], [resolved])).toEqual([{ type: 'insertOpen', obs: p, notify: true }]);
    expect(plan([obs()], [resolved])).toEqual([{ type: 'insertPending', obs: obs() }]);
  });
  it('ignores a recently resolved incident that stays healthy or is missing', () => {
    const resolved = open({ resolvedAt: new Date('2026-10-15T11:30:00Z') });
    expect(plan([obs({ state: 'healthy' })], [resolved])).toEqual([]);
    expect(plan([], [resolved])).toEqual([]);
  });
  it('seed mode opens without notifying, even for transient failures', () => {
    expect(plan([obs()], [], true)).toEqual([{ type: 'insertOpen', obs: obs(), notify: false }]);
    expect(plan([obs({ severity: 'permanent' })], [], true)).toEqual([
      { type: 'insertOpen', obs: obs({ severity: 'permanent' }), notify: false },
    ]);
  });
  it('a healthy observation with nothing tracked produces nothing', () => {
    expect(plan([obs({ state: 'healthy' })], [])).toEqual([]);
  });
  it('rejects duplicate observations for one source id', () => {
    expect(() => plan([obs(), obs()], [])).toThrow(/duplicate observation/i);
  });
});
