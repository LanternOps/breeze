import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ select: vi.fn(), predicates: [] as unknown[] }));
vi.mock('../../../db', () => ({ db: { select: mocks.select } }));
import { hardwareHealthHandler } from './hardwareHealth';
const now = new Date('2026-09-23T12:00:00Z');
const condition = { type: 'hardware_health', componentTypes: ['physical_disk'],
  minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
function component(patch: Record<string, unknown> = {}) {
  return { componentKey: 'storcli:c0:e252:s3', componentType: 'physical_disk', source: 'storcli',
    name: 'Slot 3', model: 'ST4000', serial: 'SERIAL3', parentKey: 'storcli:c0',
    health: 'critical', state: 'failed', stateDetail: 'Failed', attributes: { slot: '252:3' },
    stale: false, alertExempt: false, lastSeenAt: now, predictiveFailure: false,
    unhealthyStreak: 2, criticalStreak: 2, healthyStreak: 0, belowCriticalStreak: 0, predictiveStreak: 0,
    ...patch };
}
function rows(components: unknown[], health: unknown[] = [{ pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 }]) {
  mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => health }) }) }));
  mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: (predicate: unknown) => {
    mocks.predicates.push(predicate); return Promise.resolve(components);
  } }) }));
}
beforeEach(() => { mocks.select.mockReset(); mocks.predicates.length = 0; vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
it.each([
  ['critical', { criticalStreak: 1, unhealthyStreak: 5 }, true, 'unknown'],
  ['critical', { criticalStreak: 2 }, true, 'breaching'],
  ['warning', { criticalStreak: 0, unhealthyStreak: 2, health: 'warning' }, false, 'breaching'],
  ['critical', { criticalStreak: 0, belowCriticalStreak: 2, health: 'warning', state: 'rebuilding' }, false, 'recovered'],
  ['warning', { health: 'ok', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 1 }, false, 'unknown'],
  ['warning', { health: 'ok', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 2 }, false, 'recovered'],
  ['critical', { health: 'warning', criticalStreak: 0, predictiveFailure: true, predictiveStreak: 2 }, true, 'breaching'],
  ['critical', { health: 'warning', criticalStreak: 0, predictiveFailure: true, predictiveStreak: 2, belowCriticalStreak: 2 }, false, 'unknown'],
  ['critical', { health: 'unknown', criticalStreak: 9 }, true, 'unknown'],
  ['critical', { lastSeenAt: new Date(now.getTime() - 31 * 60_000) }, true, 'unknown'],
  ['critical', { source: 'smartctl', lastSeenAt: new Date(now.getTime() - 179 * 60_000) }, true, 'breaching'],
  ['critical', { source: 'smartctl', lastSeenAt: new Date(now.getTime() - 181 * 60_000) }, true, 'unknown'],
] as const)('%s %j predictive=%s => %s', async (minHealth, patch, includePredictiveFailure, expected) => {
  rows([component(patch)]);
  const result = await hardwareHealthHandler.evaluate({ ...condition, minHealth, includePredictiveFailure }, 'device');
  expect(result.subjects?.[0]?.status).toBe(expected);
  expect(result.passed).toBe(expected === 'breaching');
  expect(result.dataAvailable).toBe(true);
});
it('failed → online → failed never reaches two consecutive observations', async () => {
  for (const patch of [
    { criticalStreak: 1, unhealthyStreak: 1 },
    { health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 1, belowCriticalStreak: 1 },
    { criticalStreak: 1, unhealthyStreak: 1 },
  ]) {
    rows([component(patch)]);
    expect((await hardwareHealthHandler.evaluate(condition, 'device')).subjects?.[0]?.status).toBe('unknown');
  }
});
it('reports unavailable for no health row or no eligible components', async () => {
  rows([], []);
  expect(await hardwareHealthHandler.evaluate(condition, 'device')).toMatchObject({ passed: false, dataAvailable: false, subjects: [] });
  mocks.select.mockReset(); rows([]);
  expect(await hardwareHealthHandler.evaluate(condition, 'device')).toMatchObject({ passed: false, dataAvailable: false, subjects: [] });
});
it('filters by device, type, non-stale and non-exempt in SQL', async () => {
  rows([component()]);
  const result = await hardwareHealthHandler.evaluate(condition, 'device');
  const query = new PgDialect().sqlToQuery(mocks.predicates[0] as never);
  expect(query.sql).toContain('"device_id"'); expect(query.params).toContain('device');
  expect(query.sql).toContain('"component_type"'); expect(query.params).toContain('physical_disk');
  expect(query.sql).toContain('"stale"'); expect(query.sql).toContain('"alert_exempt"');
  expect(query.params.filter(x => x === false)).toHaveLength(2);
  expect(result.subjects?.[0]?.context).toMatchObject({ source: 'hardware_health', subjectKey: 'storcli:c0:e252:s3',
    componentLabel: 'Physical disk 252:3 (ST4000 SERIAL3)', stateLabel: 'failed', controller: 'storcli:c0' });
});
it.each([['storcli', 30, 'breaching'], ['storcli', 31, 'unknown'], ['smartctl', 180, 'breaching'], ['smartctl', 181, 'unknown']] as const)(
  'fallback freshness %s age=%i', async (source, minutes, expected) => {
    rows([component({ source, lastSeenAt: new Date(now.getTime() - minutes * 60_000) })],
      [{ pollIntervalMinutes: null, diskHealthIntervalMinutes: null }]);
    expect((await hardwareHealthHandler.evaluate(condition, 'device')).subjects?.[0]?.status).toBe(expected);
  },
);
it('validates the same constraints as the shared leaf', () => {
  expect(hardwareHealthHandler.validate(condition, 'condition')).toEqual([]);
  expect(hardwareHealthHandler.validate({ ...condition, componentTypes: ['bmc'] }, 'condition').length).toBeGreaterThan(0);
});
