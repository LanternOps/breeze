import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { OEM_UPDATES_POLICY_DEFAULTS } from '@breeze/shared';

// #11074: the real sweep and the real alerts.ts, over a mocked database. createAlert
// is mocked: its cooldown, dedupe and notifications are its own tests'.

const h = vi.hoisted(() => ({
  managedRows: [] as Array<Record<string, unknown>>,
  rebootRows: [] as Array<Record<string, unknown>>,
  gaveUpRows: [] as Array<Record<string, unknown>>,
  failingRows: [] as Array<Record<string, unknown>>,
  byIdRows: [] as Array<Record<string, unknown>>,
  openAlerts: {} as Record<string, Array<Record<string, unknown>>>,
  priorAlerts: [] as Array<Record<string, unknown>>,
  ruleActive: true as boolean | null,
  maintenance: { active: false, suppressAlerts: false },
  links: new Map<string, unknown>(),
  armed: true,
  open: ['driver'] as string[],
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}));

/** The page after a keyset cursor, so the paging loops run against something that ends. */
function afterCursor<T extends Record<string, unknown>>(
  rows: T[],
  query: { sql: string; params: unknown[] },
  column: string,
  key: keyof T,
): T[] {
  const match = query.sql.match(new RegExp(`${column} > \\$(\\d+)`));
  if (!match) return rows;
  const cursor = String(query.params[Number(match[1]) - 1]);
  return rows.filter((row) => String(row[key]) > cursor);
}

function rowsFor(shape: Record<string, unknown>, where: unknown): unknown[] {
  const query = where ? new PgDialect().sqlToQuery(where as never) : { sql: '', params: [] as unknown[] };
  h.queries.push(query);
  if ('alertId' in shape) {
    const ruleName = Object.keys(h.openAlerts).find((name) => query.params.includes(name));
    return ruleName ? afterCursor(h.openAlerts[ruleName]!, query, '"alerts"."id"', 'alertId') : [];
  }
  if ('dedupeKey' in shape) return h.priorAlerts;
  if ('isActive' in shape) return h.ruleActive === null ? [] : [{ isActive: h.ruleActive }];
  if ('manufacturer' in shape) {
    if (query.sql.includes('"reboot_pending_since"')) return afterCursor(h.rebootRows, query, '"devices"."id"', 'deviceId');
    if (query.sql.includes('"reason"')) return afterCursor(h.gaveUpRows, query, '"devices"."id"', 'deviceId');
    if (query.sql.includes('"last_outcome" in')) return afterCursor(h.failingRows, query, '"devices"."id"', 'deviceId');
    if (query.sql.includes('"devices"."id" in')) return h.byIdRows;
    return afterCursor(h.managedRows, query, '"devices"."id"', 'deviceId');
  }
  if ('hostname' in shape) return [{ hostname: 'host-1' }];
  if ('id' in shape) return [{ id: 'rule-1' }];
  return [];
}

vi.mock('../../db', () => {
  const chain = (shape: Record<string, unknown>) => {
    let seenWhere: unknown;
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: (condition: unknown) => { seenWhere = condition; return c; },
      orderBy: () => c,
      limit: (count: number) => Promise.resolve(rowsFor(shape, seenWhere).slice(0, count)),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rowsFor(shape, seenWhere)).then(resolve),
    };
    return c;
  };
  return {
    db: { select: vi.fn((shape: Record<string, unknown>) => chain(shape)) },
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  };
});

vi.mock('../alertService', () => ({
  createAlert: vi.fn(async () => 'alert-new'),
  resolveAlert: vi.fn(async () => true),
  RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'],
}));
vi.mock('../builtInAlertRules', () => ({ insertBuiltInAlertRule: vi.fn(async () => 'rule-new') }));
vi.mock('../featureConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../featureConfigResolver')>()),
  checkDeviceMaintenanceWindow: vi.fn(async () => h.maintenance),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

vi.mock('./candidates', async (importOriginal) => {
  const { sql } = await import('drizzle-orm');
  return {
    ...(await importOriginal<typeof import('./candidates')>()),
    armedScope: vi.fn(async () => (h.armed ? sql`true` : null)),
  };
});
vi.mock('./resolver', () => ({
  resolveOemUpdatesLinksForDevices: vi.fn(async () => h.links),
}));
vi.mock('./toolManifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toolManifest')>()),
  openCategoriesForLane: vi.fn(() => h.open),
}));

import { createAlert, resolveAlert } from '../alertService';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { captureException } from '../sentry';
import { resetOemOverdueCursorsForTests, runOemOverdueSweep } from './overdueSweep';

const NOW = new Date('2027-03-01T12:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const FOUR_DAYS_AGO = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);

const OVERDUE = 'Vendor update: device overdue';
const REBOOT_OVERDUE = 'Vendor update: restart overdue';
const GAVE_UP = 'Vendor update: schedule not handed back';
const NOT_RETURNED = 'Vendor update: device did not come back';
const RUN_FAILING = 'Vendor update: run failing';

const link = {
  linkId: 'link-1',
  configPolicyId: 'policy-1',
  assignedPolicyId: 'policy-1',
  invalidStoredSettings: false,
  armedAt: LONG_AGO,
  settings: {
    ...OEM_UPDATES_POLICY_DEFAULTS,
    enabled: true,
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
  },
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: 'd1',
    orgId: 'o1',
    partnerId: 'p1',
    osType: 'windows',
    isVirtual: false,
    deviceRole: 'workstation',
    enrolledAt: LONG_AGO,
    manufacturer: 'Dell Inc.',
    model: 'Latitude',
    siteTimezone: 'UTC',
    orgSettings: null,
    partnerTimezone: 'UTC',
    partnerSettings: null,
    lane: 'dell',
    applicability: 'applicable',
    reason: null,
    lastOutcome: 'success',
    occurrenceKey: '2027-01',
    attempts: 1,
    lastAttemptAt: LONG_AGO,
    lastSuccessAt: LONG_AGO,
    rebootPendingSince: null,
    returnDeadlineAt: null,
    lastCommandId: 'cmd-1',
    lastTrigger: 'scheduled',
    ...overrides,
  };
}

// Priors arrive with their real status, and the status set comes from the alertService mock.
const raised = () => vi.mocked(createAlert).mock.calls.map(([params]) => params);

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  resetOemOverdueCursorsForTests();
  h.queries = [];
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  h.managedRows = [];
  h.rebootRows = [];
  h.gaveUpRows = [];
  h.failingRows = [];
  h.byIdRows = [];
  h.openAlerts = {};
  h.priorAlerts = [];
  h.ruleActive = true;
  h.maintenance = { active: false, suppressAlerts: false };
  h.links = new Map([['d1', link]]);
  h.armed = true;
  h.open = ['driver'];
  vi.mocked(createAlert).mockReset();
  vi.mocked(createAlert).mockResolvedValue('alert-new');
  vi.mocked(resolveAlert).mockReset();
  vi.mocked(resolveAlert).mockResolvedValue(true);
  vi.mocked(checkDeviceMaintenanceWindow).mockClear();
  vi.mocked(captureException).mockClear();
});

describe('runOemOverdueSweep: overdue', () => {
  it('overdue device alerts once per occurrence', async () => {
    h.managedRows = [row()];

    await runOemOverdueSweep(NOW);

    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({
      ruleId: 'rule-1',
      deviceId: 'd1',
      orgId: 'o1',
      severity: 'medium',
      context: { source: 'oem-updates', occurrenceKey: '2027-02', dedupeKey: '2027-02' },
    });

    // The next tick finds that alert, even though a tech has since resolved it.
    vi.mocked(createAlert).mockClear();
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: '2027-02', status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('alerts again for the next occurrence', async () => {
    h.managedRows = [row()];
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: '2027-01', status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it('an alert still open from an earlier occurrence is the alert: nothing is asked of createAlert', async () => {
    h.managedRows = [row()];
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: '2027-01', status: 'active' }];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('suppressed in maintenance, and raised on a later tick when the window has passed', async () => {
    h.managedRows = [row()];
    h.maintenance = { active: true, suppressAlerts: true };

    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();

    h.maintenance = { active: false, suppressAlerts: false };
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it('a maintenance window that does not suppress alerts raises', async () => {
    h.managedRows = [row()];
    h.maintenance = { active: true, suppressAlerts: false };
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it.each([
    ['a device that finished this occurrence', () => { h.managedRows = [row({ occurrenceKey: '2027-02' })]; }],
    ['no link', () => { h.managedRows = [row()]; h.links = new Map(); }],
    ['every gate closed', () => { h.managedRows = [row()]; h.open = []; }],
    ['a lane on its kill switch', () => { h.managedRows = [row()]; vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell'); }],
    ['a policy armed after the last night', () => {
      h.managedRows = [row()];
      h.links = new Map([['d1', { ...link, armedAt: new Date('2027-02-26T00:00:00.000Z') }]]);
    }],
    ['a device enrolled after the last night', () => {
      h.managedRows = [row({ enrolledAt: new Date('2027-02-26T00:00:00.000Z') })];
    }],
    ['not supported by the tool', () => { h.managedRows = [row({ applicability: 'not_supported' })]; }],
    ['a device that owes a reboot', () => { h.managedRows = [row({ rebootPendingSince: new Date(NOW.getTime() - 60_000) })]; }],
  ])('raises nothing for %s', async (_label, arrange) => {
    arrange();
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('with the flag off, or nothing armed, it walks no device', async () => {
    h.managedRows = [row()];
    h.armed = false;
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();

    h.armed = true;
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('an org that switched the rule off costs one read, not one per device', async () => {
    h.managedRows = [row(), row({ deviceId: 'd2' }), row({ deviceId: 'd3' })];
    h.links = new Map([['d1', link], ['d2', link], ['d3', link]]);
    h.ruleActive = false;

    await runOemOverdueSweep(NOW);

    expect(createAlert).not.toHaveBeenCalled();
    expect(checkDeviceMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('caps the alerts raised in one tick, and the next tick carries on behind them', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '2');
    const ids = ['d1', 'd2', 'd3', 'd4'];
    h.managedRows = ids.map((deviceId) => row({ deviceId }));
    h.links = new Map(ids.map((id) => [id, link]));

    await runOemOverdueSweep(NOW);
    expect(raised().map((params) => params.deviceId)).toEqual(['d1', 'd2']);

    vi.mocked(createAlert).mockClear();
    h.priorAlerts = [
      { deviceId: 'd1', dedupeKey: '2027-02', status: 'active' },
      { deviceId: 'd2', dedupeKey: '2027-02', status: 'active' },
    ];
    await runOemOverdueSweep(NOW);
    expect(raised().map((params) => params.deviceId)).toEqual(['d3', 'd4']);
  });

  it('devices a window keeps quiet cannot starve the devices behind them', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '2');
    const ids = ['d1', 'd2', 'd3'];
    h.managedRows = ids.map((deviceId) => row({ deviceId }));
    h.links = new Map(ids.map((id) => [id, link]));
    vi.mocked(checkDeviceMaintenanceWindow).mockImplementation((async (deviceId: string) => (
      deviceId === 'd3' ? { active: false, suppressAlerts: false } : { active: true, suppressAlerts: true }
    )) as never);

    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();

    await runOemOverdueSweep(NOW);
    expect(raised().map((params) => params.deviceId)).toEqual(['d3']);
    vi.mocked(checkDeviceMaintenanceWindow).mockImplementation((async () => h.maintenance) as never);
  });

  it('one rule at its cap does not use up another rule\'s', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '1');
    h.rebootRows = [row({ deviceId: 'r1', rebootPendingSince: FOUR_DAYS_AGO })];
    h.managedRows = [row({ deviceId: 'd1' })];
    h.links = new Map([['r1', link], ['d1', link]]);

    await runOemOverdueSweep(NOW);

    expect(raised().map((params) => params.deviceId).sort()).toEqual(['d1', 'r1']);
  });

  it('walks past the first page, raising each device once, and stops', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '5000');
    const ids = Array.from({ length: 1001 }, (_, index) => `d${String(index).padStart(5, '0')}`);
    h.managedRows = ids.map((deviceId) => row({ deviceId }));
    h.links = new Map(ids.map((id) => [id, link]));

    await runOemOverdueSweep(NOW);

    expect(raised().map((params) => params.deviceId)).toEqual(ids);
  });

  it('asks only for the overdue rule\'s own alerts, from this source', async () => {
    h.managedRows = [row()];
    await runOemOverdueSweep(NOW);
    const prior = h.queries.filter((query) => query.params.includes(OVERDUE) && query.sql.includes('"device_id" in'));
    expect(prior).toHaveLength(1);
    expect(prior[0]!.sql).toContain("->>'source'");
    expect(prior[0]!.params).toContain('oem-updates');
  });

  it('one failure does not strand the rest, and reaches Sentry', async () => {
    h.managedRows = [row(), row({ deviceId: 'd2' })];
    h.links = new Map([['d1', link], ['d2', link]]);
    vi.mocked(createAlert).mockRejectedValueOnce(new Error('boom'));

    await runOemOverdueSweep(NOW);

    expect(raised().map((params) => params.deviceId)).toEqual(['d1', 'd2']);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('runOemOverdueSweep: resolving overdue', () => {
  const open = { alertId: 'a1', deviceId: 'BY-ID', orgId: 'o1', createdAt: new Date('2027-02-25T00:00:00.000Z') };

  it('resolves after a good run', async () => {
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID', lastSuccessAt: new Date('2027-02-26T00:00:00.000Z'), occurrenceKey: '2027-02' })];
    h.links = new Map([['BY-ID', link]]);

    await runOemOverdueSweep(NOW);

    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveAlert).mock.calls[0]).toEqual(['a1', expect.stringContaining('finished'), undefined, false, 'condition_cleared']);
  });

  it('stays open while no run has finished, into the next occurrence too', async () => {
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID' })];
    h.links = new Map([['BY-ID', link]]);

    // Mid-March: the March occurrence's nights are running, so the device does not read overdue.
    await runOemOverdueSweep(new Date('2027-03-18T12:00:00.000Z'));

    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it.each([
    ['the device has gone', () => { h.byIdRows = []; }],
    ['the policy no longer reaches it', () => { h.byIdRows = [row({ deviceId: 'BY-ID' })]; h.links = new Map(); }],
    ['the tool does not support it', () => { h.byIdRows = [row({ deviceId: 'BY-ID', applicability: 'not_supported' })]; h.links = new Map([['BY-ID', link]]); }],
  ])('resolves when %s', async (_label, arrange) => {
    h.openAlerts = { [OVERDUE]: [open] };
    arrange();
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveAlert).mock.calls[0]![1]).toContain('no longer');
  });

  it.each([
    ['a kill switch', () => { vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell'); }],
    ['a closed gate on a category it asks for', () => { h.open = []; }],
    ['stored settings that no longer parse', () => {
      h.links = new Map([['BY-ID', { ...link, invalidStoredSettings: true, settings: OEM_UPDATES_POLICY_DEFAULTS }]]);
    }],
  ])('stays open through %s: the device has not left management', async (_label, arrange) => {
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID' })];
    h.links = new Map([['BY-ID', link]]);
    arrange();
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves when the policy stops asking for anything', async () => {
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID' })];
    h.links = new Map([['BY-ID', {
      ...link,
      settings: { ...link.settings, vendors: { dell: { enabled: true, categories: {}, blockedUpdateIds: [] } } },
    }]]);
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
  });

  it('resolves with the flag off', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID' })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
  });

  it('settles past the first page, and stops', async () => {
    const opens = Array.from({ length: 501 }, (_, index) => ({ ...open, alertId: `a${String(index).padStart(4, '0')}` }));
    h.openAlerts = { [OVERDUE]: opens };
    h.byIdRows = [];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(501);
  });

  it('a failed resolve is reported and left open for the next tick', async () => {
    h.openAlerts = { [OVERDUE]: [open] };
    h.byIdRows = [];
    vi.mocked(resolveAlert).mockRejectedValueOnce(new Error('boom'));
    await runOemOverdueSweep(NOW);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('runOemOverdueSweep: reboot_overdue', () => {
  it('reboot_overdue alerts separately', async () => {
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];

    await runOemOverdueSweep(NOW);

    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({
      ruleId: 'rule-1',
      deviceId: 'd1',
      severity: 'medium',
      context: { source: 'oem-updates', dedupeKey: FOUR_DAYS_AGO.toISOString() },
    });
    expect(raised()[0]!.title).toMatch(/restart/i);
  });

  it('once per pending reboot', async () => {
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: FOUR_DAYS_AGO.toISOString(), status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('a policy that never reboots waits, and raises nothing', async () => {
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];
    h.links = new Map([['d1', { ...link, settings: { ...link.settings, reboot: 'never' } }]]);
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('raises with the flag off: the restart is still owed', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it('suppressed in maintenance', async () => {
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];
    h.maintenance = { active: true, suppressAlerts: true };
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('resolves once the restart is no longer owed, and not before', async () => {
    h.openAlerts = { [REBOOT_OVERDUE]: [{ alertId: 'a2', deviceId: 'BY-ID', orgId: 'o1', createdAt: NOW }] };
    h.byIdRows = [row({ deviceId: 'BY-ID', rebootPendingSince: FOUR_DAYS_AGO })];
    h.links = new Map([['BY-ID', link]]);
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).not.toHaveBeenCalled();

    h.byIdRows = [row({ deviceId: 'BY-ID', rebootPendingSince: null })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveAlert).mock.calls[0]![0]).toBe('a2');
  });
});

describe('runOemOverdueSweep: release_gave_up', () => {
  it('raises once per give-up, keyed on the run that took the schedule over', async () => {
    h.gaveUpRows = [row({ reason: 'release_gave_up' })];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({ context: { dedupeKey: LONG_AGO.toISOString() } });
    const selection = h.queries.find((query) => query.sql.includes('"reason"'));
    expect(selection!.params).toContain('release_gave_up');
    expect(selection!.sql).toContain('"lane" is not null');
    expect(raised()[0]!.title).toMatch(/schedule/i);

    vi.mocked(createAlert).mockClear();
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: LONG_AGO.toISOString(), status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('resolves once the release has gone through', async () => {
    h.openAlerts = { [GAVE_UP]: [{ alertId: 'a3', deviceId: 'BY-ID', orgId: 'o1', createdAt: NOW }] };
    h.byIdRows = [row({ deviceId: 'BY-ID', reason: 'release_gave_up' })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).not.toHaveBeenCalled();

    h.byIdRows = [row({ deviceId: 'BY-ID', reason: null })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
  });
});

describe('runOemOverdueSweep: run failing', () => {
  // NOW is past February's last night (the 24th), on the policy defaults: third Wednesday,
  // 01:00, four hours, seven catch-up nights. March's nights are the 17th to the 24th.
  const failing = (overrides: Record<string, unknown> = {}) => row({
    lastOutcome: 'failed',
    occurrenceKey: '2027-02',
    attempts: 1,
    ...overrides,
  });

  it('fires once the last night has passed and the scheduled run ended failing', async () => {
    h.failingRows = [failing()];

    await runOemOverdueSweep(NOW);

    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({
      ruleId: 'rule-1',
      deviceId: 'd1',
      orgId: 'o1',
      severity: 'medium',
      context: {
        source: 'oem-updates',
        occurrenceKey: '2027-02',
        dedupeKey: '2027-02',
        lastOutcome: 'failed',
        commandId: 'cmd-1',
      },
    });
    expect(raised()[0]!.title).toMatch(/failing/i);
    expect(h.queries.some((query) => query.params.includes(RUN_FAILING))).toBe(true);
  });

  it('selects on the outcomes the screens call Failing, and no others', async () => {
    h.failingRows = [failing()];
    await runOemOverdueSweep(NOW);
    const selection = h.queries.find((query) => query.sql.includes('"last_outcome" in'))!;
    expect(selection.params).toEqual(expect.arrayContaining(['failed', 'partial', 'tool_unavailable', 'interrupted', 'blocked_no_recovery_key']));
    for (const notFailing of ['success', 'no_updates', 'retry_later', 'blocked_on_battery', 'blocked_reboot_pending', 'not_supported']) {
      expect(selection.params).not.toContain(notFailing);
    }
  });

  it.each(['failed', 'partial', 'tool_unavailable', 'interrupted', 'blocked_no_recovery_key'])('fires on %s', async (lastOutcome) => {
    h.failingRows = [failing({ lastOutcome })];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it.each([
    ['failed', 'failed'],
    ['partial', 'finished only in part'],
    ['tool_unavailable', 'could not get its tool'],
    ['interrupted', 'was interrupted'],
    ['blocked_no_recovery_key', 'had no recovery key'],
  ])('says %s in words, and keeps the outcome in the context', async (lastOutcome, words) => {
    h.failingRows = [failing({ lastOutcome })];
    await runOemOverdueSweep(NOW);
    expect(raised()[0]!.message).toContain(` ${words},`);
    expect(raised()[0]!.message).not.toMatch(/[a-z]+_[a-z]+/);
    expect(raised()[0]!.context).toMatchObject({ lastOutcome });
  });

  it.each([
    ['night 1 of 7, in its window', '2027-03-18T02:00:00.000Z'],
    ['night 1 of 7, between windows', '2027-03-18T12:00:00.000Z'],
    ['the last night, in its window', '2027-03-24T04:59:00.000Z'],
  ])('does not fire on %s after a failure: retries are still possible', async (_label, at) => {
    h.failingRows = [failing({ occurrenceKey: '2027-03' })];
    await runOemOverdueSweep(new Date(at));
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('fires the moment the last window has closed', async () => {
    h.failingRows = [failing({ occurrenceKey: '2027-03' })];
    await runOemOverdueSweep(new Date('2027-03-24T05:00:00.000Z'));
    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({ context: { dedupeKey: '2027-03' } });
  });

  it.each([
    ['Run Now', 'on_demand'],
    ['a run whose trigger cannot be read', null],
  ])('does not fire when the last run was %s', async (_label, lastTrigger) => {
    h.failingRows = [failing({ lastTrigger })];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('a failure from an earlier occurrence is not this occurrence\'s run', async () => {
    h.failingRows = [failing({ occurrenceKey: '2027-01' })];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('once per occurrence, even after a tech has closed it', async () => {
    h.failingRows = [failing()];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);

    vi.mocked(createAlert).mockClear();
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: '2027-02', status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('fires again for the next occurrence', async () => {
    h.failingRows = [failing()];
    h.priorAlerts = [{ deviceId: 'd1', dedupeKey: '2027-01', status: 'resolved' }];
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it('suppressed in maintenance, and raised on a later tick when the window has passed', async () => {
    h.failingRows = [failing()];
    h.maintenance = { active: true, suppressAlerts: true };
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();

    h.maintenance = { active: false, suppressAlerts: false };
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  it('a maintenance window that does not suppress alerts raises', async () => {
    h.failingRows = [failing()];
    h.maintenance = { active: true, suppressAlerts: false };
    await runOemOverdueSweep(NOW);
    expect(raised()).toHaveLength(1);
  });

  describe('Overdue XOR Failing', () => {
    it('attempts used up reads Overdue: the overdue rule fires and this one does not', async () => {
      const exhausted = failing({ attempts: 3 });
      h.managedRows = [exhausted];
      h.failingRows = [exhausted];

      await runOemOverdueSweep(NOW);

      expect(raised()).toHaveLength(1);
      expect(raised()[0]!.title).toMatch(/overdue/i);
    });

    it('attempts left reads Failing: this rule fires and the overdue rule does not', async () => {
      const tryLeft = failing({ attempts: 2 });
      h.managedRows = [tryLeft];
      h.failingRows = [tryLeft];

      await runOemOverdueSweep(NOW);

      expect(raised()).toHaveLength(1);
      expect(raised()[0]!.title).toMatch(/failing/i);
    });

    it('a device that owes an overdue restart raises only the restart rule', async () => {
      const owes = failing({ rebootPendingSince: FOUR_DAYS_AGO });
      h.rebootRows = [owes];
      h.failingRows = [owes];

      await runOemOverdueSweep(NOW);

      expect(raised()).toHaveLength(1);
      expect(raised()[0]!.title).toMatch(/restart/i);
    });
  });

  it.each([
    ['no link', () => { h.links = new Map(); }],
    ['every gate closed', () => { h.open = []; }],
    ['a lane on its kill switch', () => { vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell'); }],
    ['stored settings that no longer parse', () => {
      h.links = new Map([['d1', { ...link, invalidStoredSettings: true, settings: OEM_UPDATES_POLICY_DEFAULTS }]]);
    }],
    ['a policy armed after the last night opened', () => {
      h.links = new Map([['d1', { ...link, armedAt: new Date('2027-02-24T02:00:00.000Z') }]]);
    }],
  ])('raises nothing for %s', async (_label, arrange) => {
    h.failingRows = [failing()];
    arrange();
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('raises nothing for a device enrolled after the last night opened', async () => {
    h.failingRows = [failing({ enrolledAt: new Date('2027-02-24T02:00:00.000Z') })];
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('with the flag off, or nothing armed, it walks no device', async () => {
    h.failingRows = [failing()];
    h.armed = false;
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
    expect(h.queries.some((query) => query.sql.includes('"last_outcome" in'))).toBe(false);

    h.armed = true;
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await runOemOverdueSweep(NOW);
    expect(createAlert).not.toHaveBeenCalled();
    expect(h.queries.some((query) => query.sql.includes('"last_outcome" in'))).toBe(false);
  });

  it('an org that switched the rule off costs one read, not one per device', async () => {
    h.failingRows = [failing(), failing({ deviceId: 'd2' }), failing({ deviceId: 'd3' })];
    h.links = new Map([['d1', link], ['d2', link], ['d3', link]]);
    h.ruleActive = false;

    await runOemOverdueSweep(NOW);

    expect(createAlert).not.toHaveBeenCalled();
    expect(checkDeviceMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('caps the alerts raised in one tick, and the next tick carries on behind them', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '2');
    const ids = ['d1', 'd2', 'd3', 'd4'];
    h.failingRows = ids.map((deviceId) => failing({ deviceId }));
    h.links = new Map(ids.map((id) => [id, link]));

    await runOemOverdueSweep(NOW);
    expect(raised().map((params) => params.deviceId)).toEqual(['d1', 'd2']);

    vi.mocked(createAlert).mockClear();
    h.priorAlerts = [
      { deviceId: 'd1', dedupeKey: '2027-02', status: 'active' },
      { deviceId: 'd2', dedupeKey: '2027-02', status: 'active' },
    ];
    await runOemOverdueSweep(NOW);
    expect(raised().map((params) => params.deviceId)).toEqual(['d3', 'd4']);
  });

  it('its cap is its own: another rule at its cap does not use it up', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '1');
    h.managedRows = [row({ deviceId: 'o1' })];
    h.failingRows = [failing({ deviceId: 'f1' })];
    h.links = new Map([['o1', link], ['f1', link]]);

    await runOemOverdueSweep(NOW);

    expect(raised().map((params) => params.deviceId).sort()).toEqual(['f1', 'o1']);
  });

  describe('resolving', () => {
    const open = { alertId: 'a5', deviceId: 'BY-ID', orgId: 'o1', dedupeKey: '2027-02', createdAt: new Date('2027-02-25T00:00:00.000Z') };
    const notes = () => vi.mocked(resolveAlert).mock.calls.map((call) => call[1]);

    beforeEach(() => {
      h.openAlerts = { [RUN_FAILING]: [open] };
      h.links = new Map([['BY-ID', link]]);
    });

    it('resolves after a good run', async () => {
      h.byIdRows = [failing({ deviceId: 'BY-ID', lastSuccessAt: new Date('2027-02-26T00:00:00.000Z') })];
      await runOemOverdueSweep(NOW);
      expect(vi.mocked(resolveAlert).mock.calls[0]).toEqual(['a5', expect.stringContaining('finished'), undefined, false, 'condition_cleared']);
    });

    it('stays open while the same occurrence has had no good run', async () => {
      h.byIdRows = [failing({ deviceId: 'BY-ID' })];
      await runOemOverdueSweep(NOW);
      expect(resolveAlert).not.toHaveBeenCalled();
    });

    it('a good run from before the alert does not resolve it', async () => {
      h.byIdRows = [failing({ deviceId: 'BY-ID', lastSuccessAt: new Date('2027-02-24T23:59:00.000Z') })];
      await runOemOverdueSweep(NOW);
      expect(resolveAlert).not.toHaveBeenCalled();
    });

    it('stays open up to the moment the next occurrence starts, and resolves at it', async () => {
      h.byIdRows = [failing({ deviceId: 'BY-ID' })];
      await runOemOverdueSweep(new Date('2027-03-17T00:59:00.000Z'));
      expect(resolveAlert).not.toHaveBeenCalled();

      await runOemOverdueSweep(new Date('2027-03-17T01:00:00.000Z'));
      expect(resolveAlert).toHaveBeenCalledTimes(1);
      expect(notes()[0]).toContain('next');
    });

    it('resolving at the next occurrence does not raise for it while its nights are running', async () => {
      h.byIdRows = [failing({ deviceId: 'BY-ID' })];
      h.failingRows = [failing({ deviceId: 'BY-ID' })];
      await runOemOverdueSweep(new Date('2027-03-18T12:00:00.000Z'));
      expect(resolveAlert).toHaveBeenCalledTimes(1);
      expect(createAlert).not.toHaveBeenCalled();
    });

    it.each([
      ['the device has gone', () => { h.byIdRows = []; }],
      ['the policy no longer reaches it', () => { h.byIdRows = [failing({ deviceId: 'BY-ID' })]; h.links = new Map(); }],
      ['the tool does not support it', () => { h.byIdRows = [failing({ deviceId: 'BY-ID', applicability: 'not_supported' })]; }],
    ])('resolves when %s', async (_label, arrange) => {
      arrange();
      await runOemOverdueSweep(NOW);
      expect(resolveAlert).toHaveBeenCalledTimes(1);
      expect(notes()[0]).toContain('no longer');
    });

    it.each([
      ['a kill switch', () => { vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell'); }],
      ['a closed gate on a category it asks for', () => { h.open = []; }],
      ['stored settings that no longer parse', () => {
        h.links = new Map([['BY-ID', { ...link, invalidStoredSettings: true, settings: OEM_UPDATES_POLICY_DEFAULTS }]]);
      }],
    ])('stays open through %s, into the next occurrence too', async (_label, arrange) => {
      h.byIdRows = [failing({ deviceId: 'BY-ID' })];
      arrange();
      await runOemOverdueSweep(new Date('2027-03-18T12:00:00.000Z'));
      expect(resolveAlert).not.toHaveBeenCalled();
    });

    it('resolves with the flag off', async () => {
      vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
      h.byIdRows = [failing({ deviceId: 'BY-ID' })];
      await runOemOverdueSweep(NOW);
      expect(resolveAlert).toHaveBeenCalledTimes(1);
    });
  });
});

describe('runOemOverdueSweep: a not-returned alert the result path could not resolve', () => {
  const open = { alertId: 'a4', deviceId: 'BY-ID', orgId: 'o1', createdAt: NOW };

  it('resolves once the monitor has disarmed', async () => {
    h.openAlerts = { [NOT_RETURNED]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID', returnDeadlineAt: null })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
  });

  it('stays open while the monitor is still armed', async () => {
    h.openAlerts = { [NOT_RETURNED]: [open] };
    h.byIdRows = [row({ deviceId: 'BY-ID', returnDeadlineAt: NOW })];
    await runOemOverdueSweep(NOW);
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});

describe('runOemOverdueSweep: isolation', () => {
  it('a failing step does not stop the ones after it', async () => {
    const { db } = await import('../../db');
    h.rebootRows = [row({ rebootPendingSince: FOUR_DAYS_AGO })];
    // The first read of the sweep throws.
    vi.mocked(db.select).mockImplementationOnce(() => { throw new Error('boom'); });

    await runOemOverdueSweep(NOW);

    expect(captureException).toHaveBeenCalled();
    expect(raised()).toHaveLength(1);
  });
});
