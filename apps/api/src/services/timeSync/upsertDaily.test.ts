import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows: [] as unknown[], insert: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ for: async () => m.rows }) }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async () => {
          m.insert(values);
        },
      }),
    }),
  },
}));
import { upsertDaily } from './upsertDaily';
import { timeSnapshot } from './testSnapshot';
beforeEach(() => {
  m.rows = [];
  m.insert.mockReset();
});
it('uses the UTC collected date rather than the received date', async () => {
  await upsertDaily({
    deviceId: 'device',
    orgId: 'org',
    snapshot: timeSnapshot({ collectedAt: '2026-09-28T23:30:00-06:00' }),
    result: { health: 'healthy', findings: [], eventMarks: {} },
    expectedTimezone: null,
    receivedAt: new Date('2026-09-30T00:00:00Z'),
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      day: '2026-09-29',
      snapshotCount: 1,
      findingCodes: [],
    }),
  );
});
it('unions codes, retains worst health and max sync, and replaces latest accepted fields', async () => {
  m.rows = [
    {
      findingCodes: ['sync_stale'],
      worstHealth: 'critical',
      snapshotCount: 5,
      lastSuccessfulSyncAt: new Date('2026-09-28T12:00:00Z'),
    },
  ];
  await upsertDaily({
    deviceId: 'device',
    orgId: 'org',
    snapshot: timeSnapshot(),
    result: {
      health: 'critical',
      findings: [
        {
          code: 'sync_disabled',
          severity: 'critical',
          detail: { reason: 'no_sync' },
        },
      ],
      eventMarks: {},
    },
    expectedTimezone: {
      iana: 'America/Denver',
      windowsId: 'Mountain Standard Time',
      source: 'site',
      sourceId: 'site',
      sourceName: 'Office',
    },
    receivedAt: new Date('2026-09-28T12:01:00Z'),
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshotCount: 6,
      worstHealth: 'critical',
      findingCodes: ['sync_disabled', 'sync_stale'],
      lastSuccessfulSyncAt: new Date('2026-09-28T12:00:00Z'),
      source: null,
      sourceKind: 'ntp_peer',
      syncType: 'NTP',
      expectedTimezone: 'America/Denver',
      timezoneWindowsId: 'UTC',
    }),
  );
});
it.each([
  ['healthy', 'unknown', 'unknown'],
  ['unknown', 'healthy', 'unknown'],
  ['unknown', 'warning', 'warning'],
  ['warning', 'critical', 'critical'],
] as const)('folds %s and %s to %s', async (prior, incoming, expected) => {
  m.rows = [
    {
      findingCodes: [],
      worstHealth: prior,
      snapshotCount: 1,
      lastSuccessfulSyncAt: null,
    },
  ];
  await upsertDaily({
    deviceId: 'device',
    orgId: 'org',
    snapshot: timeSnapshot(),
    result: { health: incoming, findings: [], eventMarks: {} },
    expectedTimezone: null,
    receivedAt: new Date(),
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({ worstHealth: expected, snapshotCount: 2 }),
  );
});
