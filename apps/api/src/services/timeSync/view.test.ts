import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const rows = m.rows.shift() ?? [];
      const q: any = {
        then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
      };
      for (const method of ['from', 'where', 'limit']) q[method] = () => q;
      return q;
    },
  },
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
}));
import { getDeviceTimeStatusView } from './view';
import { buildTimeStatusRow } from './ingest';
import { resolveTimeFindings } from './findings';
import { NOW, snapshot } from './testFixtures';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const site = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Main',
  timezone: 'UTC',
};
const device = { id: deviceId, orgId, siteId: site.id, osType: 'windows' };
function row() {
  const s = snapshot();
  s.status.sourceKind = 'local_clock';
  return buildTimeStatusRow(
    { deviceId, orgId, agentVersion: null, snapshot: s, receivedAt: NOW },
    undefined,
    null,
    resolveTimeFindings(s, {
      expectedTimezone: null,
      previousEventMarks: {},
    }),
  );
}
beforeEach(() => {
  m.rows = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
it('returns null for absent/RLS-hidden device', async () => {
  m.rows = [[]];
  expect(await getDeviceTimeStatusView(deviceId)).toBeNull();
});
it.each([
  ['windows', 'not_reported'],
  ['linux', 'unsupported_os'],
  ['macos', 'unsupported_os'],
])('distinguishes %s without a report', async (osType, state) => {
  m.rows = [[{ ...device, osType }], []];
  expect(await getDeviceTimeStatusView(deviceId)).toMatchObject({
    state,
    health: 'unknown',
    stale: false,
    findings: [],
    recentEvents: [],
    config: null,
    status: null,
    domain: null,
    timezone: null,
    enforcement: null,
  });
});
it('uses the UTC-default explanation and preserves non-timezone findings', async () => {
  m.rows = [[device], [row()], [site]];
  const view = await getDeviceTimeStatusView(deviceId);
  expect(view!.timezone).toMatchObject({
    expected: null,
    expectedUnsetReason: 'site_utc_default',
  });
  expect(view!.findings.map((f) => f.code)).toEqual(['source_local_clock']);
  expect(view!.config!.ntpServerHosts).toEqual(['pool.ntp.org']);
  expect(view!.receivedAt).toBe(NOW.toISOString());
});
it('recomputes mismatch on site edits in both directions without mutating the stored row', async () => {
  const stored = row();
  m.rows = [[device], [stored], [{ ...site, timezone: 'America/Detroit' }]];
  const mismatch = await getDeviceTimeStatusView(deviceId);
  expect(mismatch!.timezone!.expected).toMatchObject({
    source: 'site',
    sourceName: 'Main',
    iana: 'America/Detroit',
  });
  expect(mismatch!.findings.map((f) => f.code)).toEqual([
    'source_local_clock',
    'timezone_mismatch',
  ]);
  stored.findings.push('timezone_mismatch');
  stored.findingDetails.timezone_mismatch = { expected: 'old' };
  m.rows = [[device], [stored], [{ ...site, timezone: 'America/Los_Angeles' }]];
  expect(
    (await getDeviceTimeStatusView(deviceId))!.findings.map((f) => f.code),
  ).toEqual(['source_local_clock']);
  expect(stored.findings).toContain('timezone_mismatch');
});
it.each([
  [[], 'no_site'],
  [[{ ...site, timezone: 'Antarctica/Troll' }], 'unmapped'],
] as const)('explains missing mapping %s', async (sites, reason) => {
  m.rows = [[device], [row()], [...sites]];
  expect(
    (await getDeviceTimeStatusView(deviceId))!.timezone!.expectedUnsetReason,
  ).toBe(reason);
});
it('marks received time stale only after the exact boundary', async () => {
  vi.setSystemTime(new Date(+NOW + 5_400_000));
  m.rows = [[device], [row()], [site]];
  expect((await getDeviceTimeStatusView(deviceId))!.stale).toBe(false);
  vi.setSystemTime(new Date(+NOW + 5_400_001));
  m.rows = [[device], [row()], [site]];
  expect((await getDeviceTimeStatusView(deviceId))!.stale).toBe(true);
});
