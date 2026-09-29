import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
const m = vi.hoisted(() => ({ list: vi.fn(), where: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: m.where }) }) }),
  },
}));
vi.mock('./fleet', async (original) => ({
  ...(await original<typeof import('./fleet')>()),
  listFleetTimeStatus: m.list,
}));
import {
  evidenceDays,
  exportCurrentTimeCsv,
  exportHistoryTimeCsv,
  historyTimeQuerySchema,
  TIME_EVIDENCE_HEADER,
} from './exports';
const org = '11111111-1111-4111-8111-111111111111',
  device = '22222222-2222-4222-8222-222222222222';
const auth = {
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;
const row = {
  deviceId: device,
  hostname: '=SUM(1,2)',
  orgId: org,
  orgName: 'Customer',
  siteId: null,
  siteName: null,
  view: {
    state: 'not_reported',
    health: 'unknown',
    stale: false,
    receivedAt: null,
    collectedAt: null,
    findings: [],
    domain: null,
    status: null,
    config: null,
    timezone: null,
  },
};
async function collect(generator: AsyncGenerator<string>) {
  let text = '';
  for await (const chunk of generator) text += chunk;
  return text;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  m.list.mockReset().mockResolvedValue({
    data: [row],
    total: 1,
    page: 1,
    limit: 100,
    domains: [],
  });
  m.where.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
it('accepts 400 inclusive UTC dates; rejects invalid, inverted, expired, future or 401-day ranges', () => {
  expect(
    historyTimeQuerySchema.safeParse({ from: '2025-08-25', to: '2026-09-28' })
      .success,
  ).toBe(true);
  for (const range of [
    { from: '2025-08-24', to: '2026-09-28' },
    { from: '2026-09-29', to: '2026-09-29' },
    { from: '2026-09-28', to: '2026-09-27' },
    { from: '2026-02-30', to: '2026-09-28' },
    { from: '2025-08-23', to: '2025-08-23' },
  ])
    expect(historyTimeQuerySchema.safeParse(range).success).toBe(false);
  expect(evidenceDays('2026-09-27', '2026-09-28')).toEqual([
    '2026-09-27',
    '2026-09-28',
  ]);
});
it('states observation limits and neutralizes spreadsheet formulas', async () => {
  const text = await collect(exportCurrentTimeCsv({}, auth));
  expect(text.split('\r\n')[0]).toBe(TIME_EVIDENCE_HEADER);
  expect(text).toContain(`"'=SUM(1,2)"`);
  expect(text).toContain('"not_reported"');
});
it('lists gaps and preserves historical timezone and source', async () => {
  m.where.mockResolvedValue([
    {
      row: {
        deviceId: device,
        day: '2026-09-28',
        worstHealth: 'warning',
        findingCodes: ['sync_stale'],
        source: 'time.example.com',
        sourceKind: 'ntp_peer',
        syncType: 'NTP',
        lastSuccessfulSyncAt: new Date('2026-09-28T01:00:00Z'),
        snapshotCount: 4,
        expectedTimezone: 'America/New_York',
        timezoneWindowsId: 'Eastern Standard Time',
      },
    },
  ]);
  const text = await collect(
    exportHistoryTimeCsv(
      { orgId: org },
      { from: '2026-09-27', to: '2026-09-28' },
      auth,
    ),
  );
  expect(text).toContain('"2026-09-27","gap"');
  expect(text).toContain('"2026-09-28","observed","warning","sync_stale"');
  expect(text).toContain('America/New_York');
  expect(text).toContain('Eastern Standard Time');
});
it('exports all pages rather than the currently displayed page', async () => {
  m.list
    .mockResolvedValueOnce({ data: [row], total: 101, limit: 100 })
    .mockResolvedValueOnce({
      data: [{ ...row, deviceId: org }],
      total: 101,
      limit: 100,
    });
  const text = await collect(exportCurrentTimeCsv({ page: 8, limit: 1 }, auth));
  expect(m.list.mock.calls.map((call) => call[0].page)).toEqual([1, 2]);
  expect(text).toContain(`"${device}"`);
});
it('does not invent devices or gaps for an empty accessible fleet', async () => {
  m.list.mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    limit: 100,
    domains: [],
  });
  const text = await collect(
    exportHistoryTimeCsv({}, { from: '2026-09-28', to: '2026-09-28' }, auth),
  );
  expect(text.trim().split('\r\n')).toHaveLength(2);
  expect(m.where).not.toHaveBeenCalled();
});
