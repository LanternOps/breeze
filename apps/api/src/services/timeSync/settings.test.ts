import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  rows: [] as any[][],
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const rows = m.rows.shift() ?? [];
      const q: any = {
        then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
      };
      for (const key of ['from', 'where', 'limit', 'innerJoin'])
        q[key] = () => q;
      return q;
    },
  },
}));
vi.mock('../redis', () => ({ getRedis: () => ({ get: m.get, set: m.set }) }));
const visibility = vi.hoisted(() => ({ calls: [] as Array<string | null> }));
vi.mock('../configPolicyOwnership', async (orig) => ({
  ...(await orig<typeof import('../configPolicyOwnership')>()),
  withDevicePartnerPolicyVisibility: vi.fn(
    async (executor: any, partnerId: string | null, fn: any) => {
      visibility.calls.push(partnerId);
      return fn(executor);
    },
  ),
}));
import {
  resolveDeviceTimeSyncSettings,
  getDeviceTimeSyncSettings,
} from './settings';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const id = '11111111-1111-4111-8111-111111111111';
const device = {
  orgId: id,
  siteId: id,
  osType: 'windows',
  deviceRole: 'server',
};
const base = {
  policyId: id,
  policyName: 'Time policy',
  roleFilter: null,
  osFilter: null,
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 60,
  timezoneExpected: 'pinned',
  pinnedTimezone: 'UTC',
  timezoneAutoFix: true,
  assignmentPriority: 0,
  assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
};
beforeEach(() => {
  m.rows = [];
  visibility.calls = [];
  m.get.mockReset().mockResolvedValue(null);
  m.set.mockReset().mockResolvedValue('OK');
});
it('resolves defaults when no policy exists', async () => {
  m.rows = [[device], [{ partnerId: id }], [], []];
  expect(await resolveDeviceTimeSyncSettings(id)).toEqual({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: null,
  });
});
it('reads in the caller\'s own context: no accessible_partner_ids widening (#8142)', async () => {
  const partnerId = '22222222-2222-4222-8222-222222222222';
  m.rows = [[device], [{ partnerId }], [], [{ ...base, level: 'partner' }]];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(visibility.calls).toEqual([]);
  expect(result.settings.enforceNtp).toBe(true);
});
it('breaks equal level and priority ties by assignment creation time, not policy id', async () => {
  const older = { ...base, policyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', level: 'org', pollIntervalMinutes: 30, assignmentCreatedAt: new Date('2026-01-01T00:00:00Z') };
  const newer = { ...base, policyId: '00000000-0000-4000-8000-000000000000', level: 'org', pollIntervalMinutes: 45, assignmentCreatedAt: new Date('2026-02-01T00:00:00Z') };
  m.rows = [[device], [{ partnerId: id }], [], [newer, older]];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(result.settings.pollIntervalMinutes).toBe(30);
});
it('chooses closest eligible assignment, then smallest priority', async () => {
  m.rows = [
    [device],
    [{ partnerId: id }],
    [],
    [
      { ...base, level: 'partner' },
      {
        ...base,
        level: 'device',
        assignmentPriority: 2,
        pollIntervalMinutes: 120,
      },
      {
        ...base,
        level: 'device',
        assignmentPriority: 1,
        pollIntervalMinutes: 90,
      },
      { ...base, level: 'device', assignmentPriority: 0, osFilter: ['linux'] },
    ],
  ];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(result.settings.pollIntervalMinutes).toBe(90);
  expect(result.policy).toEqual({
    policyId: id,
    policyName: 'Time policy',
    expected: 'pinned',
    pinnedTimezone: 'UTC',
  });
});
it('caches validated settings for 120 seconds', async () => {
  m.rows = [[device], [device], [{ partnerId: id }], [], []];
  await getDeviceTimeSyncSettings(id);
  expect(m.set).toHaveBeenCalledWith(
    `timesync:settings:device:${id}`,
    JSON.stringify({ orgId: id, settings: TIME_SYNC_DEFAULTS, policy: null }),
    'EX',
    120,
  );
});
it('checks visibility before using cached policy data', async () => {
  m.rows = [[]];
  await expect(getDeviceTimeSyncSettings(id)).rejects.toThrow(
    'Time sync device not visible',
  );
  expect(m.get).not.toHaveBeenCalled();
});
it('ignores malformed cached data but propagates a bad stored policy', async () => {
  m.get.mockResolvedValue('{');
  m.rows = [
    [device],
    [device],
    [{ partnerId: id }],
    [],
    [{ ...base, level: 'device', pollIntervalMinutes: 1 }],
  ];
  await expect(getDeviceTimeSyncSettings(id)).rejects.toThrow();
  expect(m.set).not.toHaveBeenCalled();
});
it('does not return cached settings from a previous org', async () => {
  m.get.mockResolvedValue(
    JSON.stringify({
      orgId: '22222222-2222-4222-8222-222222222222',
      settings: TIME_SYNC_DEFAULTS,
      policy: null,
    }),
  );
  m.rows = [
    [device],
    [device],
    [{ partnerId: id }],
    [],
    [{ ...base, level: 'partner' }],
  ];
  expect((await getDeviceTimeSyncSettings(id)).settings.enforceNtp).toBe(true);
});
