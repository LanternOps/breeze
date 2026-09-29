import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ settings: vi.fn(), site: null as any }));
vi.mock('./settings', () => ({ getDeviceTimeSyncSettings: m.settings }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const q: any = {
        then: (yes: any, no: any) =>
          Promise.resolve(m.site ? [m.site] : []).then(yes, no),
      };
      for (const k of ['from', 'innerJoin', 'where', 'limit']) q[k] = () => q;
      return q;
    },
  },
}));
import {
  buildResolvedTimeSyncConfigUpdate,
  canonicalTimeSyncJson,
} from './configUpdate';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  m.settings.mockReset().mockResolvedValue({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: null,
  });
  m.site = { id, name: 'Site', timezone: 'America/New_York' };
});
it('sends defaults and derives a site zone', async () => {
  const value = await buildResolvedTimeSyncConfigUpdate(id);
  const canonical =
    '{"enforce_ntp":false,"ntp_servers":[],"poll_interval_minutes":60,"timezone":{"auto_fix":false,"expected_windows_id":"Eastern Standard Time"}}';
  expect(value).toEqual({
    enforce_ntp: false,
    ntp_servers: [],
    poll_interval_minutes: 60,
    timezone: { expected_windows_id: 'Eastern Standard Time', auto_fix: false },
    fingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  });
});
it('sorts nested keys without sorting server preference order', () => {
  expect(canonicalTimeSyncJson({ b: { z: 2, a: 1 }, a: ['b', 'a'] })).toBe(
    '{"a":["b","a"],"b":{"a":1,"z":2}}',
  );
});
it('pinned UTC overrides the site and changes the fingerprint', async () => {
  const site = await buildResolvedTimeSyncConfigUpdate(id);
  m.settings.mockResolvedValue({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: {
      policyId: id,
      policyName: 'UTC servers',
      expected: 'pinned',
      pinnedTimezone: 'UTC',
    },
  });
  const pinned = await buildResolvedTimeSyncConfigUpdate(id);
  expect(pinned.timezone.expected_windows_id).toBe('UTC');
  expect(pinned.fingerprint).not.toBe(site.fingerprint);
});
it('returns null expectation for UTC-default site and never hides resolver errors', async () => {
  m.site.timezone = 'UTC';
  expect(
    (await buildResolvedTimeSyncConfigUpdate(id)).timezone.expected_windows_id,
  ).toBeNull();
  m.settings.mockRejectedValue(new Error('policy read failed'));
  await expect(buildResolvedTimeSyncConfigUpdate(id)).rejects.toThrow(
    'policy read failed',
  );
});
