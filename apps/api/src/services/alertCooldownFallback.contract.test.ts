import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DEFAULT_ALERT_COOLDOWN_MINUTES } from '@breeze/shared';

const { selectResults, updateResults, dbMock } = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const updateResults: unknown[][] = [];
  return {
    selectResults,
    updateResults,
    dbMock: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => selectResults.shift() ?? [] }) }) }),
      execute: vi.fn(async () => [{ id: 'alert-1' }]),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => updateResults.shift() ?? [] }) }) }),
    },
  };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => {}),
  recordStateTransition: vi.fn(async () => {}),
  isFlapping: vi.fn(async () => false),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => 'evt') }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => 'site-1') }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => {}) }));

import { createAlert, resolveAlert } from './alertService';
import { setCooldown } from './alertCooldown';

const SRC = resolve(import.meta.dirname, '..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '__tests__', '__snapshots__'].includes(entry.name)) return [];
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    return file.endsWith('.ts') && !/\.(?:test|spec|d)\.ts$/.test(file) ? [file] : [];
  });
}

it('no alert path hard-codes a cooldown fallback other than DEFAULT_ALERT_COOLDOWN_MINUTES', () => {
  const offenders: string[] = [];
  for (const file of ['services', 'routes', 'jobs'].flatMap(dir => walk(join(SRC, dir)))) {
    // Preserve newlines so diagnostics point at the original source line.
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      comment => comment.replace(/[^\n]/g, ' '));
    const locations = new Set<number>();
    for (const match of source.matchAll(/cooldown(?:Minutes)?\s*\?\?\s*\d+/g)) {
      locations.add(source.slice(0, match.index).split('\n').length);
    }
    source.split('\n').forEach((line, index) => {
      if (line.includes('cooldownMinutes') && /\?\?\s*15\b/.test(line)) locations.add(index + 1);
    });
    for (const line of locations) offenders.push(`${relative(SRC, file)}:${line}`);
  }
  expect(offenders, 'Use DEFAULT_ALERT_COOLDOWN_MINUTES at these fallback sites').toEqual([]);
  expect(DEFAULT_ALERT_COOLDOWN_MINUTES).toBe(5);
});

it('resolveAlert and createAlert use the same cooldown fallback', async () => {
  vi.clearAllMocks();
  const rule = { id: 'rule-1', templateId: 'tpl-1', overrideSettings: null };
  const template = { id: 'tpl-1' };
  selectResults.push([rule], [template], [], [rule], [template]);
  updateResults.push([{
    id: 'alert-1', orgId: 'org-1', ruleId: 'rule-1', deviceId: 'device-1',
    triggeredAt: new Date('2026-10-29T10:00:00Z'), resolvedAt: new Date('2026-10-29T10:05:00Z'),
  }]);

  await expect(createAlert({
    ruleId: 'rule-1', deviceId: 'device-1', orgId: 'org-1', severity: 'high',
    title: 'Test alert', message: 'Test condition',
  })).resolves.toBe('alert-1');
  await expect(resolveAlert('alert-1')).resolves.toBe(true);

  expect(setCooldown).toHaveBeenCalledTimes(2);
  expect(vi.mocked(setCooldown).mock.calls.map(call => call[2])).toEqual([
    DEFAULT_ALERT_COOLDOWN_MINUTES, DEFAULT_ALERT_COOLDOWN_MINUTES,
  ]);
});
