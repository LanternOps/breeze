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
      // Stale "latest" values: R12 says the newest accepted snapshot replaces
      // them, so a first-of-day-wins regression must fail here.
      source: 'old.example.com',
      sourceKind: 'domain_hierarchy',
      syncType: 'NT5DS',
      expectedTimezone: 'UTC',
      timezoneWindowsId: 'Pacific Standard Time',
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
  [
    'replaces an older retained sync with a newer reported one',
    '2026-09-28T11:00:00Z',
    '2026-09-28T11:59:00Z',
    '2026-09-28T11:59:00Z',
  ],
  [
    'retains the previous sync when the snapshot reports none',
    '2026-09-28T11:00:00Z',
    null,
    '2026-09-28T11:00:00Z',
  ],
] as const)('%s', async (_name, prior, reported, expected) => {
  m.rows = [
    {
      findingCodes: [],
      worstHealth: 'healthy',
      snapshotCount: 1,
      lastSuccessfulSyncAt: new Date(prior),
    },
  ];
  const snapshot = timeSnapshot();
  snapshot.status.lastSuccessfulSyncAt = reported;
  await upsertDaily({
    deviceId: 'device',
    orgId: 'org',
    snapshot,
    result: { health: 'healthy', findings: [], eventMarks: {} },
    expectedTimezone: null,
    receivedAt: new Date('2026-09-28T12:01:00Z'),
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({ lastSuccessfulSyncAt: new Date(expected) }),
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
