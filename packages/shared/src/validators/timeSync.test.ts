import { expect, it } from 'vitest';
import {
  timeStatusSnapshotSchema,
  timeSyncEnforcementReportSchema,
} from './timeSync';
import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
} from '../constants/timeSync';
const wire = {
  schemaVersion: 1,
  sequence: 0,
  collectedAt: '2026-09-28T10:00:00Z',
  config: {
    type: null,
    ntpServer: null,
    specialPollIntervalSeconds: null,
    policyManaged: false,
    policyManagedValues: [],
    serviceState: 'unknown',
    serviceStartType: 'unknown',
    hostTimeProviderEnabled: null,
  },
  status: {
    method: 'unavailable',
    source: null,
    sourceKind: 'unknown',
    lastSuccessfulSyncAt: null,
    lastSyncError: null,
    stratum: null,
    pollIntervalSeconds: null,
  },
  domain: {
    joinType: 'unknown',
    role: 'unknown',
    domainDns: null,
    forestDns: null,
    pdcName: null,
  },
  timezone: {
    windowsId: null,
    biasMinutes: null,
    dynamicDstDisabled: null,
    autoUpdate: 'unknown',
  },
  events: [],
  enforcement: null,
};
it('accepts unavailable fields as null and sequence zero', () => {
  expect(timeStatusSnapshotSchema.parse(wire)).toEqual(wire);
  expect(Object.keys(TIME_SYNC_FINDING_SEVERITY)).toEqual([
    ...TIME_SYNC_FINDING_CODES,
  ]);
});
it.each([
  { sequence: -1 },
  { sequence: 0.5 },
  { schemaVersion: 2 },
  { extra: true },
  { collectedAt: '2026-09-28T10:00:00' },
  { config: { ...wire.config, extra: true } },
  { config: { ...wire.config, ntpServer: 'x'.repeat(1025) } },
  { config: { ...wire.config, policyManagedValues: Array(21).fill('Type') } },
  { status: { ...wire.status, stratum: 17 } },
  { timezone: { ...wire.timezone, biasMinutes: -1441 } },
  {
    events: Array(101).fill({
      recordId: 1,
      eventId: 134,
      level: 2,
      occurredAt: wire.collectedAt,
      message: '',
      properties: [],
    }),
  },
])('rejects invalid snapshot %j', (patch) => {
  expect(
    timeStatusSnapshotSchema.safeParse({ ...wire, ...patch }).success,
  ).toBe(false);
});
it('bounds events and enforcement and rejects nested unknown keys', () => {
  const event = {
    recordId: 1,
    eventId: 134,
    level: 2,
    occurredAt: wire.collectedAt,
    message: 'm'.repeat(1000),
    properties: Array(10).fill('p'.repeat(500)),
  };
  expect(
    timeStatusSnapshotSchema.safeParse({
      ...wire,
      events: Array(100).fill(event),
    }).success,
  ).toBe(true);
  for (const patch of [
    { message: 'm'.repeat(1001) },
    { properties: Array(11).fill('p') },
    { properties: ['p'.repeat(501)] },
    { level: 6 },
    { recordId: -1 },
    { extra: 1 },
  ]) {
    expect(
      timeStatusSnapshotSchema.safeParse({
        ...wire,
        events: [{ ...event, ...patch }],
      }).success,
    ).toBe(false);
  }
  const result = {
    resultId: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'sha256:abc',
    at: wire.collectedAt,
    outcome: 'skipped',
    reason: 'role_unknown',
    before: { type: null },
    after: { type: 'NT5DS' },
    error: null,
  };
  expect(
    timeSyncEnforcementReportSchema.safeParse({ ntp: result, timezone: null })
      .success,
  ).toBe(true);
  for (const patch of [
    { resultId: 'bad' },
    { reason: 'guessed' },
    { error: 'x'.repeat(513) },
    { before: { nested: {} } },
    { fingerprint: 'x'.repeat(81) },
    { extra: true },
  ]) {
    expect(
      timeSyncEnforcementReportSchema.safeParse({
        ntp: { ...result, ...patch },
        timezone: null,
      }).success,
    ).toBe(false);
  }
});
