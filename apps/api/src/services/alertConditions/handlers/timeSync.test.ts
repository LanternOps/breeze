import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  predicates: [] as unknown[],
}));
vi.mock('../../../db', () => ({ db: { select: mocks.select } }));
import { timeSyncHandler } from './timeSync';
const now = new Date('2026-09-28T12:00:00Z');
const deviceId = '11111111-1111-4111-8111-111111111111';
const condition = {
  type: 'time_sync',
  findings: ['sync_stale', 'sync_disabled'],
  consecutiveSnapshots: 2,
};
function rows(patch: Record<string, unknown> | null = {}) {
  const result =
    patch === null
      ? []
      : [
          {
            receivedAt: now,
            findings: ['sync_stale'],
            findingStreaks: {
              sync_stale: { present: 2, absent: 0 },
              sync_disabled: { present: 0, absent: 2 },
            },
            findingDetails: { sync_stale: { thresholdHours: 24 } },
            domainRole: 'member',
            source: 'time.example.com',
            lastSuccessfulSyncAt: now,
            ...patch,
          },
        ];
  mocks.select.mockImplementationOnce(() => ({
    from: () => ({
      where: (p: unknown) => {
        mocks.predicates.push(p);
        return { limit: async () => result };
      },
    }),
  }));
}
beforeEach(() => {
  mocks.select.mockReset();
  mocks.predicates = [];
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
it('emits independent subjects and complete template context', async () => {
  rows();
  const result = await timeSyncHandler.evaluate(condition, deviceId);
  expect(result).toMatchObject({
    passed: true,
    dataAvailable: true,
    subjects: [
      { subjectKey: 'sync_stale', status: 'breaching' },
      { subjectKey: 'sync_disabled', status: 'recovered' },
    ],
  });
  expect(result.subjects?.[0]?.context).toEqual({
    source: 'time_sync',
    subjectKey: 'sync_stale',
    findingCode: 'sync_stale',
    findingLabel: 'Time sync is stale',
    findingDetail: 'thresholdHours: 24',
    domainRole: 'member',
    timeSource: 'time.example.com',
    lastSuccessfulSyncAt: now.toISOString(),
  });
  const query = new PgDialect().sqlToQuery(mocks.predicates[0] as never);
  expect(query.sql).toContain('"device_id"');
  expect(query.params).toContain(deviceId);
});
it.each([
  [1, 0, 'unknown'],
  [2, 0, 'breaching'],
  [0, 1, 'unknown'],
  [0, 2, 'recovered'],
] as const)('streak %i/%i -> %s', async (present, absent, status) => {
  rows({ findingStreaks: { sync_stale: { present, absent } } });
  const result = await timeSyncHandler.evaluate(condition, deviceId);
  expect(result.subjects?.[0]?.status).toBe(status);
  expect(result.subjects?.[1]?.status).toBe('unknown');
});
it.each([null, { receivedAt: new Date(+now - 90 * 60_000 - 1) }])(
  'missing/stale row stays unknown',
  async (patch) => {
    rows(patch);
    expect(await timeSyncHandler.evaluate(condition, deviceId)).toMatchObject({
      passed: false,
      dataAvailable: false,
      subjects: [
        { subjectKey: 'sync_stale', status: 'unknown' },
        { subjectKey: 'sync_disabled', status: 'unknown' },
      ],
    });
  },
);
it('keeps the exact 90-minute boundary fresh and never counts sweeps', async () => {
  for (let sweep = 0; sweep < 3; sweep++) {
    rows({
      receivedAt: new Date(+now - 90 * 60_000),
      findingStreaks: { sync_stale: { present: 1, absent: 0 } },
    });
    const result = await timeSyncHandler.evaluate(condition, deviceId);
    expect(result.dataAvailable).toBe(true);
    expect(result.subjects?.[0]?.status).toBe('unknown');
  }
});
it('deduplicates selected findings and validates the shared shape', async () => {
  rows();
  expect(
    (
      await timeSyncHandler.evaluate(
        { ...condition, findings: ['sync_stale', 'sync_stale'] },
        deviceId,
      )
    ).subjects,
  ).toHaveLength(1);
  expect(timeSyncHandler.validate(condition, 'condition')).toEqual([]);
  expect(
    timeSyncHandler.validate({ ...condition, findings: [] }, 'condition')[0],
  ).toContain('condition.findings');
});
