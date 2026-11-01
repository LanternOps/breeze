import { beforeEach, expect, it, vi } from 'vitest';
import { isAfterCursor, maxEvidence, type EvidenceCursor } from '@breeze/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { EvaluateOptions } from './alertConditions';

const mocks = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), trigger: vi.fn(), recovery: vi.fn(),
  closed: vi.fn(), open: vi.fn(), advance: vi.fn(), observation: vi.fn(), capture: vi.fn(),
}));
vi.mock('../db', () => ({ db: { select: mocks.select, update: mocks.update } }));
vi.mock('./alertLifecycle/cursor', async () => ({
  ...await vi.importActual<typeof import('./alertLifecycle/cursor')>('./alertLifecycle/cursor'),
  readClosedCursors: mocks.closed, readOpenCursors: mocks.open, advanceOpenCursors: mocks.advance,
}));
vi.mock('./alertConditions', () => ({
  evaluateConditions: mocks.trigger, evaluateAutoResolveConditions: mocks.recovery,
  evidenceLeafPaths: (condition: { type?: string }) => condition?.type === 'event_log' ? ['root'] : [],
  interpolateTemplate: (value: string) => value,
}));
vi.mock('./monitors/episodeService', () => ({ recordRecoveryObservation: mocks.observation }));
vi.mock('./alertCooldown', () => ({ setCooldown: vi.fn(), recordStateTransition: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: mocks.capture }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => {}) }));

import { alerts, alertRules, alertTemplates } from '../db/schema';
import { checkAutoResolve, checkAllAutoResolve } from './alertService';

const triggerCondition = { type: 'event_log', messagePattern: 'breach' };
const recoveryCondition = { type: 'event_log', messagePattern: 'recovery' };
const event = (minute: number, id = `event-${minute}`, ingested = minute): EvidenceCursor => ({
  ts: new Date(Date.UTC(2026, 9, 29, 10, minute)).toISOString(),
  createdAt: new Date(Date.UTC(2026, 9, 29, 10, ingested)).toISOString(), id,
});
let triggers: EvidenceCursor[];
let recoveries: EvidenceCursor[];
let alert: Record<string, unknown>;
let rule: Record<string, unknown>;
let template: Record<string, unknown>;
let payloads: Record<string, unknown>[];
let predicates: SQL[];
let casWins: boolean;

function evaluate(events: EvidenceCursor[], opts?: EvaluateOptions) {
  const watermark = events.reduce<EvidenceCursor | undefined>((a, b) => maxEvidence(a, b), undefined);
  return {
    passed: events.some(row => isAfterCursor(row, opts?.cursors?.root, opts?.side ?? 'trigger')
      && (opts?.cursors?.root !== undefined || !opts?.legacyIngestedBefore || Date.parse(row.createdAt) > opts.legacyIngestedBefore.getTime())),
    evidenceWatermarks: watermark ? { root: watermark } : {}, dataState: 'ok',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  triggers = [event(2)]; recoveries = [event(3)];
  payloads = []; predicates = []; casWins = true;
  alert = { id: 'alert-1', ruleId: 'rule-1', deviceId: 'device-1', orgId: 'org-1',
    status: 'active', triggeredAt: new Date('2026-10-29T10:05:00Z'), requiresHuman: false };
  rule = { id: 'rule-1', templateId: 'template-1', managedByMonitorId: 'monitor-1' };
  template = { conditions: triggerCondition, autoResolve: true, autoResolveConditions: recoveryCondition };
  mocks.select.mockImplementation(() => ({ from: (table: unknown) => ({ where: (predicate: SQL) => {
    predicates.push(predicate);
    const rows = table === alerts ? [alert] : table === alertRules ? [rule] : table === alertTemplates ? [template] : [];
    return { limit: async () => rows, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  } }) }));
  mocks.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => {
    payloads.push(values);
    return { where: () => ({ returning: async () => casWins ? [{ ...alert, ...values }] : [] }) };
  } }));
  mocks.closed.mockResolvedValue(new Map());
  mocks.open.mockResolvedValue({ root: event(2) });
  mocks.advance.mockResolvedValue(true);
  mocks.trigger.mockImplementation(async (_c, _d, opts) => {
    const result = evaluate(triggers, opts);
    return { ...result, triggered: result.passed };
  });
  mocks.recovery.mockImplementation(async (_c, _d, opts) => {
    const result = evaluate(recoveries, opts);
    return { ...result, shouldResolve: result.passed, reason: 'recovered' };
  });
});

it('a recovery event older than the cursor does not resolve a new alert', async () => {
  recoveries = [event(1)];
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(payloads).toHaveLength(0);
});
it('a recovery event logged after the trigger but ingested before triggered_at resolves it', async () => {
  expect(await checkAutoResolve('alert-1')).toBe(true);
});
it('a repeat trigger event during the episode advances the cursor and blocks an earlier recovery', async () => {
  triggers.push(event(4));
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(mocks.advance).toHaveBeenCalledWith('alert-1', { root: event(4) });
});
it('a recovery event with the same clamped timestamp as the trigger resolves it', async () => {
  triggers = [event(2, 'zzz-trigger')]; recoveries = [event(2, 'aaa-recovery')];
  mocks.open.mockResolvedValue({ root: triggers[0] });
  expect(await checkAutoResolve('alert-1')).toBe(true);
  expect(mocks.recovery).toHaveBeenCalledWith(recoveryCondition, 'device-1', { side: 'resolve', cursors: { root: triggers[0] }, legacyIngestedBefore: alert.triggeredAt });
});
it('recovery close freezes the cursor in the same update as the status change', async () => {
  await checkAutoResolve('alert-1');
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ status: 'resolved', context: expect.any(Object) });
  const compiled = new PgDialect().sqlToQuery(payloads[0]!.context as SQL);
  expect(compiled.sql).toContain("jsonb_build_object('cursor'");
  expect(compiled.params).toContain(JSON.stringify({ root: event(3) }));
});
it('recovery close records an ok observation and closes the breach episode', async () => {
  expect(await checkAutoResolve('alert-1')).toBe(true);
  expect(mocks.observation).toHaveBeenCalledWith('monitor-1', 'device-1', 'org-1');
});
it.each(['acknowledged', 'suppressed'])('%s alert auto-resolves', async status => {
  alert.status = status;
  expect(await checkAutoResolve('alert-1')).toBe(true);
});
it('requiresHuman alert never auto-resolves', async () => {
  alert.requiresHuman = true;
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.recovery).not.toHaveBeenCalled();
});
it.each([false, true])('unknown data state never resolves (explicit: %s)', async explicit => {
  if (!explicit) template.autoResolveConditions = null;
  mocks.trigger.mockResolvedValue({ triggered: false, dataState: 'unknown', evidenceWatermarks: {} });
  mocks.recovery.mockResolvedValue({ shouldResolve: true, dataState: 'unknown', evidenceWatermarks: {} });
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(payloads).toHaveLength(0);
});
it('checkAllAutoResolve selects active, acknowledged and suppressed alerts', async () => {
  await checkAllAutoResolve('org-1');
  const compiled = new PgDialect().sqlToQuery(predicates[0]!);
  expect(compiled.sql).toContain('"alerts"."status" in ($1, $2, $3)');
  expect(compiled.params).toEqual(['active', 'acknowledged', 'suppressed', false, 'org-1']);
  expect(compiled.sql).toContain('"alerts"."requires_human" = $4');
});
it('inverse trigger uses the previous closed episode, not the open cursor', async () => {
  template.autoResolveConditions = null;
  mocks.closed.mockResolvedValue(new Map([['rule-1', { cursors: { root: event(3) }, legacy: false }]]));
  expect(await checkAutoResolve('alert-1')).toBe(true);
  expect(mocks.closed).toHaveBeenCalledWith('device-1', ['rule-1']);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(payloads[0]).not.toHaveProperty('context');
});
it('refresh failure never resolves using a stale cursor', async () => {
  const error = new Error('refresh failed'); mocks.advance.mockRejectedValue(error);
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(mocks.capture).toHaveBeenCalledWith(error, undefined, { errorId: 'alert-rearm-refresh-failed', alertId: 'alert-1' });
  expect(mocks.recovery).not.toHaveBeenCalled();
});
it('a lost CAS never records recovery', async () => {
  casWins = false;
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(mocks.observation).not.toHaveBeenCalled();
});
it('observation failure does not undo recovery', async () => {
  const error = new Error('observation failed'); mocks.observation.mockRejectedValue(error);
  expect(await checkAutoResolve('alert-1')).toBe(true);
  expect(mocks.capture).toHaveBeenCalledWith(error, undefined, expect.objectContaining({ area: 'monitors', issue: 'recovery_observation_failed' }));
});
it.each([
  ['an episode opened before cursors existed', triggerCondition],
  ['a trigger with no event_log leaf', { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }],
])('with no stored cursor (%s) a recovery ingested before triggered_at does not resolve', async (_label, conditions) => {
  template.conditions = conditions;
  mocks.open.mockResolvedValue({});
  triggers = [];
  expect(await checkAutoResolve('alert-1')).toBe(false);
  expect(payloads).toHaveLength(0);
});
it('with no stored cursor a recovery ingested after triggered_at resolves', async () => {
  mocks.open.mockResolvedValue({});
  triggers = []; recoveries = [event(6)];
  expect(await checkAutoResolve('alert-1')).toBe(true);
});
