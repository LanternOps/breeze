import { beforeEach, expect, it, vi } from 'vitest';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as any[],
  deleted: [] as unknown[],
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = {
      then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
    };
    for (const key of [
      'from',
      'where',
      'limit',
      'orderBy',
      'returning',
      'for',
      'innerJoin',
    ])
      c[key] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({
    set: () => result([{ id: '11111111-1111-4111-8111-111111111111' }]),
  });
  tx.delete = (table: unknown) => ({
    where: () => {
      m.deleted.push(table);
      return result([]);
    },
  });
  tx.insert = (table: unknown) => ({
    values: (value: unknown) => {
      m.inserted.push({ table, value });
      return result([]);
    },
  });
  return {
    db: tx,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
  };
});
import {
  listFeatureLinks,
  updateFeatureLink,
  validateFeaturePolicyExists,
} from './configurationPolicy';
import { configPolicyTimeSyncSettings } from '../db/schema';
const id = '11111111-1111-4111-8111-111111111111';
const settings = {
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 120,
  timezone: {
    expected: 'pinned' as const,
    pinnedTimezone: 'UTC',
    autoFix: true,
  },
};
const flat = {
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 120,
  timezoneExpected: 'pinned',
  pinnedTimezone: 'UTC',
  timezoneAutoFix: true,
};
const link = {
  id,
  configPolicyId: id,
  featureType: 'time_sync',
  featurePolicyId: null,
  inlineSettings: TIME_SYNC_DEFAULTS,
};
beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.deleted = [];
});
it('reads typed columns instead of the stale mirror', async () => {
  m.rows = [[link], [flat]];
  expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual(settings);
});
it('replaces the flat row and keeps nested timezone on the API', async () => {
  m.rows = [[link]];
  await updateFeatureLink(id, { inlineSettings: settings }, id);
  expect(m.deleted).toContain(configPolicyTimeSyncSettings);
  expect(m.inserted).toContainEqual({
    table: configPolicyTimeSyncSettings,
    value: { featureLinkId: id, ...flat },
  });
});
it('rejects invalid enforcement before deleting existing settings', async () => {
  m.rows = [[link]];
  await expect(
    updateFeatureLink(id, { inlineSettings: { enforceNtp: true } }, id),
  ).rejects.toThrow();
  expect(m.deleted).toEqual([]);
});
it.each([
  { orgId: id, partnerId: null },
  { orgId: null, partnerId: id },
])('is inline-only for %j', async (owner) => {
  // A same-org configuration policy row is available to the whole-policy
  // fall-through, so only the inline-only branch can refuse the id.
  m.rows = [[{ id }]];
  expect(await validateFeaturePolicyExists('time_sync', null, owner)).toEqual({
    valid: true,
  });
  expect(
    (await validateFeaturePolicyExists('time_sync', id, owner)).valid,
  ).toBe(false);
});
