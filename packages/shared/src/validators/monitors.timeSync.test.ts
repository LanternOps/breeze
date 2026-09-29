import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '../constants/timeSync';
import {
  MONITOR_KINDS,
  SERVER_EVALUATED_MONITOR_KINDS,
  monitorConditionSchemas,
  compositeConditionSchema,
} from './monitors';
it('accepts each finding with two observations by default and remains root-only', () => {
  expect(MONITOR_KINDS).toContain('time_sync');
  expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain('time_sync');
  for (const code of TIME_SYNC_FINDING_CODES)
    expect(
      monitorConditionSchemas.time_sync.parse({ findings: [code] }),
    ).toEqual({ findings: [code], consecutiveSnapshots: 2 });
});
it.each([
  { findings: [] },
  { findings: ['other'] },
  { findings: 'sync_stale' },
  { consecutiveSnapshots: 0 },
  { consecutiveSnapshots: 11 },
  { consecutiveSnapshots: 1.5 },
  { consecutiveSnapshots: '2' },
  { extra: true },
])('rejects %j', (patch) =>
  expect(
    monitorConditionSchemas.time_sync.safeParse({
      findings: ['sync_stale'],
      ...patch,
    }).success,
  ).toBe(false),
);
it.each([1, 10])('accepts streak boundary %i', (consecutiveSnapshots) => {
  expect(
    monitorConditionSchemas.time_sync.safeParse({
      findings: ['sync_stale'],
      consecutiveSnapshots,
    }).success,
  ).toBe(true);
});
it('rejects time subjects inside composites', () => {
  expect(
    compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'time_sync', condition: { findings: ['sync_stale'] } },
        { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
      ],
    }).success,
  ).toBe(false);
});
