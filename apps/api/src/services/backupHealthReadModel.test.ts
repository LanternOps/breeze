import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';
const PROVIDER_ROW = 'f1111111-1111-4111-8111-111111111111';

// Drizzle chain mock, same idiom as routes/backup/dashboard.test.ts:14-24 with
// innerJoin added.
//
// DEVIATION from the plan's literal transcription (docs/superpowers/plans/
// integrations/2026-09-15-backup-provider-integration-w03-read-model-web.md
// Task 3 Step 1, ~line 1381 for chainMock/queue, ~line 1460 for whereArg): the
// plan's chainMock queues results positionally by raw db.select() call order,
// but the real implementation (Task 3 Step 3) calls db.select() TWICE more per
// Breeze leg for latestJobSubquery/latestSuccessSubquery before the leg's own
// main select — those two extra calls are `.as()`-aliased SUBQUERIES that are
// never directly awaited by production code (they're only referenced as
// `.leftJoin()` targets / column sources), so positional queueing silently
// misassigns data meant for the main leg query onto a throwaway subquery call,
// and DATA never reaches the leg that's actually read.
//
// Fix, entirely inside this test file (the production SQL is correct and
// matches backupJobOrdering.ts's documented two-subquery rationale):
//   1. `chainMock` only resolves a queued dataset when the chain is actually
//      AWAITED (`.then()` invoked) — subqueries are built but never awaited,
//      so they never consume a slot meant for a leg's real data.
//   2. `.as(alias)` returns an object exposing each selected column as a
//      `'<alias>.<column>'` string stand-in (real Drizzle subqueries expose
//      selected columns as properties too), so conditions built from
//      `latest.deviceId` etc. serialise to a string containing the subquery's
//      alias — which a couple of assertions check for (e.g. 'bh_latest_job').
//   3. `whereArg(n)` now means "the n-th MAIN (non-subquery) call", found by
//      skipping any call whose chain had `.as()` invoked on it — so it keeps
//      meaning "breeze leg" / "provider leg" regardless of how many subquery
//      calls precede it.
let pendingData: unknown[][] = [];

function chainMock(columns?: Record<string, unknown>, fixed?: { value: unknown }) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.as = vi.fn((alias: string) => {
    const subquery: Record<string, any> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy', 'as']) {
      subquery[m] = chain[m];
    }
    subquery._alias = alias;
    if (columns) {
      for (const key of Object.keys(columns)) subquery[key] = `${alias}.${key}`;
    }
    // Deliberately no `.then` on the subquery object: production code never
    // awaits a subquery directly (only the leg's own final `.limit()` result
    // is awaited), and giving it one risks it silently absorbing a queued
    // dataset if something ever accidentally treats it as thenable.
    return subquery;
  });
  chain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
    Promise.resolve(fixed ? fixed.value : pendingData.length > 0 ? pendingData.shift() : []).then(ok, err);
  return chain;
}

const selectMock = vi.fn((columns?: Record<string, unknown>) => chainMock(columns));

vi.mock('../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...(a as [])) } }));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.org_id', siteId: 'devices.site_id', hostname: 'devices.hostname', displayName: 'devices.display_name', deviceRole: 'devices.device_role', status: 'devices.status', isEphemeral: 'devices.is_ephemeral' },
  organizations: { id: 'organizations.id', name: 'organizations.name' },
  backupJobs: { id: 'backup_jobs.id', orgId: 'backup_jobs.org_id', deviceId: 'backup_jobs.device_id', status: 'backup_jobs.status', startedAt: 'backup_jobs.started_at', createdAt: 'backup_jobs.created_at', completedAt: 'backup_jobs.completed_at', totalSize: 'backup_jobs.total_size', errorCount: 'backup_jobs.error_count' },
  RESTORABLE_BACKUP_JOB_STATUSES: ['completed', 'partial'] as const,
  backupProviderDevices: { id: 'bpd.id', orgId: 'bpd.org_id', connectionId: 'bpd.connection_id', customerId: 'bpd.customer_id', provider: 'bpd.provider', portalShowProviderName: 'bpd.portal_show_provider_name', vendorDeviceName: 'bpd.vendor_device_name', computerName: 'bpd.computer_name', osType: 'bpd.os_type', accountType: 'bpd.account_type', dataSources: 'bpd.data_sources', status: 'bpd.status', lastSessionAt: 'bpd.last_session_at', lastSuccessAt: 'bpd.last_success_at', selectedBytes: 'bpd.selected_bytes', usedBytes: 'bpd.used_bytes', errorsCount: 'bpd.errors_count', breezeDeviceId: 'bpd.breeze_device_id' },
  backupProviderCustomers: { id: 'bpc.id', vendorCustomerName: 'bpc.vendor_customer_name' },
  backupProviderConnections: { id: 'bpn.id', partnerId: 'bpn.partner_id', isActive: 'bpn.is_active', lastSyncAt: 'bpn.last_sync_at', syncIntervalMinutes: 'bpn.sync_interval_minutes' },
  backupProviderDeviceHistory: { providerDeviceId: 'bpdh.provider_device_id', day: 'bpdh.day', status: 'bpdh.status' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', conditions: c.filter(Boolean) }),
  or: (...c: unknown[]) => ({ op: 'or', conditions: c.filter(Boolean) }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  desc: (column: unknown) => ({ op: 'desc', column }),
  isNull: (column: unknown) => ({ op: 'isNull', column }),
  isNotNull: (column: unknown) => ({ op: 'isNotNull', column }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  ilike: (column: unknown, value: unknown) => ({ op: 'ilike', column, value }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values, as: (alias: string) => ({ op: 'sql', strings, values, alias }) }),
    { raw: (s: string) => ({ op: 'raw', s }) },
  ),
}));

import {
  BACKUP_HEALTH_MAX_BATCHES,
  getFirstPartyCoverageForDevices,
  getProviderAttentionItems,
  getProviderCoverageForDevices,
  listBackupHealthRows,
  summarizeBackupHealth,
} from './backupHealthReadModel';
import { decodeBackupHealthCursor } from './backupHealthCursor';

const NOW = new Date('2026-09-15T12:00:00.000Z');

// DEVIATION from the plan's literal transcription (~line 1434-1450): both leg
// fixtures below omitted `key`, which the real SQL computes
// (`breezeKeyExpr`/`providerKeyExpr`) but a plain JS mock object never does on
// its own. Without it every row's `key` was `undefined`, which
// mergeSortedRows/cursorFromRow silently tolerated (comparisons on `undefined`
// don't throw) but attachHistory's `r.key.slice('provider:'.length)` does not
// — `TypeError: Cannot read properties of undefined (reading 'slice')`. Each
// factory now derives `key` the same way the SQL does, from the id it was
// actually given (post-override), so a test overriding `deviceId`/`id` still
// gets a consistent key.
const breezeRow = (o: Record<string, unknown> = {}) => {
  const merged = {
    orgId: ORG_A, orgName: 'Acme', siteId: SITE_A, deviceId: DEVICE_1,
    name: 'SRV01', computerName: 'srv01', deviceRole: 'server', deviceStatus: 'online',
    jobStatus: 'completed', lastSessionAt: '2026-09-15T02:00:00.000Z',
    lastSuccessAt: '2026-09-15T02:30:00.000Z', totalSize: 1024, errorsCount: 0, hasJobs: true,
    ...o,
  } as { deviceId: string; key?: string };
  return { key: `breeze:${merged.deviceId}`, ...merged };
};

const providerRow = (o: Record<string, unknown> = {}) => {
  const merged = {
    id: PROVIDER_ROW, orgId: ORG_A, orgName: 'Acme', provider: 'cove', portalShowProviderName: false,
    name: 'ACME-SRV02', computerName: 'srv02', osType: 'workstation', accountType: 'backup_manager',
    dataSources: ['files'], status: 'completed', lastSessionAt: '2026-09-15T01:00:00.000Z',
    lastSuccessAt: '2026-09-15T01:00:00.000Z', selectedBytes: 10, usedBytes: 20, errorsCount: 0,
    breezeDeviceId: null, deviceStatus: null, deviceSiteId: null,
    connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30,
    ...o,
  } as { id: string; key?: string };
  return { key: `provider:${merged.id}`, ...merged };
};

/** Queue leg results in AWAIT order: breeze leg, provider leg, then the two
 *  history queries. Subquery calls (never awaited) do not consume a slot. */
function queue(...results: unknown[][]) {
  selectMock.mockReset();
  pendingData = [...results];
  selectMock.mockImplementation((columns?: Record<string, unknown>) => chainMock(columns));
}

/** True when `.as(alias)` was ever invoked on this call's chain — i.e. it
 *  built a subquery rather than being a leg's own terminal, awaited query. */
function isSubqueryCall(i: number): boolean {
  return selectMock.mock.results[i]!.value.as.mock.calls.length > 0;
}

/** The n-th MAIN (non-subquery) db.select() call, 0-indexed — "breeze leg"
 *  is main call 0, "provider leg" is main call 1, regardless of how many
 *  subquery calls (latestJobSubquery/latestSuccessSubquery) preceded them. */
function mainCallIndex(n: number): number {
  let seen = -1;
  for (let i = 0; i < selectMock.mock.results.length; i += 1) {
    if (!isSubqueryCall(i)) {
      seen += 1;
      if (seen === n) return i;
    }
  }
  throw new Error(`no main call #${n} (only ${seen + 1} main call(s) seen)`);
}

const whereArg = (n: number) => selectMock.mock.results[mainCallIndex(n)]!.value.where.mock.calls[0][0];
const flatConditions = (node: any): any[] =>
  node?.op === 'and' || node?.op === 'or' ? node.conditions.flatMap(flatConditions) : [node];

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  pendingData = [];
  selectMock.mockImplementation((columns?: Record<string, unknown>) => chainMock(columns));
});

describe('listBackupHealthRows — scope', () => {
  it('returns nothing without querying when the org scope is empty', async () => {
    const out = await listBackupHealthRows({ orgIds: [] }, { page: { limit: 10 }, now: NOW });
    expect(out).toEqual({ rows: [], nextCursor: null });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns nothing when the caller is site-restricted to zero sites', async () => {
    const out = await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [] }, { page: { limit: 10 }, now: NOW });
    expect(out).toEqual({ rows: [], nextCursor: null });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('constrains both legs to the scope org ids', async () => {
    queue([breezeRow()], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A, ORG_B] }, { page: { limit: 10 }, now: NOW });
    for (const call of [0, 1]) {
      expect(flatConditions(whereArg(call))).toContainEqual(
        expect.objectContaining({ op: 'inArray', values: [ORG_A, ORG_B] }),
      );
    }
  });
});

describe('listBackupHealthRows — site authority', () => {
  it('narrows the Breeze leg to the allowed sites', async () => {
    queue([breezeRow()], []);
    await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [SITE_A] }, { page: { limit: 10 }, now: NOW });
    expect(flatConditions(whereArg(0))).toContainEqual(
      expect.objectContaining({ op: 'inArray', column: 'devices.site_id', values: [SITE_A] }),
    );
  });

  it('requires a linked, in-site device for provider rows when the caller is site-restricted', async () => {
    queue([], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [SITE_A] }, { page: { limit: 10 }, now: NOW });
    const conditions = flatConditions(whereArg(1));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'isNotNull', column: 'bpd.breeze_device_id' }));
    expect(conditions).toContainEqual(
      expect.objectContaining({ op: 'inArray', column: 'devices.site_id', values: [SITE_A] }),
    );
  });

  it('places no site condition on either leg for an unrestricted caller', async () => {
    queue([breezeRow()], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    for (const call of [0, 1]) {
      expect(flatConditions(whereArg(call))).not.toContainEqual(
        expect.objectContaining({ column: 'devices.site_id' }),
      );
    }
  });
});

describe('listBackupHealthRows — the all-devices contract', () => {
  it('returns a row for a device with no jobs at all, as no_backups', async () => {
    queue([breezeRow({ jobStatus: null, lastSessionAt: null, lastSuccessAt: null, totalSize: null, hasJobs: false })], []);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'breeze', status: 'no_backups', covered: false });
  });

  it('excludes ephemeral and decommissioned devices from the Breeze leg', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    const conditions = flatConditions(whereArg(0));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'eq', column: 'devices.is_ephemeral', value: false }));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'ne', column: 'devices.status', value: 'decommissioned' }));
  });

  it('emits TWO rows for a device that is both first-party backed up and provider-linked', async () => {
    queue([breezeRow()], [providerRow({ breezeDeviceId: DEVICE_1, deviceStatus: 'online', deviceSiteId: SITE_A })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deviceId === DEVICE_1)).toHaveLength(2);
  });

  // D11: the mocked DB ignores WHERE, so pin the SQL shape here; the row-level
  // behaviour (linked + no jobs => provider row only; linked + jobs => both
  // rows) is proven against real Postgres in
  // backupHealthReadModel.integration.test.ts.
  it('drops only the no-jobs placeholder of a provider-linked device from the Breeze leg', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    const top = whereArg(0);
    const topConditions: any[] = top?.op === 'and' ? top.conditions : [top];
    const exclusion = topConditions.find(
      (c) => c?.op === 'or' && JSON.stringify(c).includes('not exists (select 1 from '),
    );
    expect(exclusion).toBeDefined();
    // One branch keeps any device that has a first-party job.
    expect(JSON.stringify(exclusion)).toContain(' is not null');
  });

  it('merges the two legs into one (lower(name), key) order', async () => {
    queue(
      [breezeRow({ name: 'bravo', deviceId: DEVICE_2 }), breezeRow({ name: 'Delta' })],
      [providerRow({ name: 'ALPHA' }), providerRow({ name: 'charlie', id: 'f2222222-2222-4222-8222-222222222222' })],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows.map((r) => r.name)).toEqual(['ALPHA', 'bravo', 'charlie', 'Delta']);
  });
});

describe('listBackupHealthRows — filters', () => {
  it('sources: ["provider"] skips the Breeze leg entirely', async () => {
    queue([providerRow()]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { sources: ['provider'], page: { limit: 10 }, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('provider');
    expect(selectMock).toHaveBeenCalledTimes(2); // provider leg + its history query
  });

  it('onlyWithBackup drops Breeze devices with no jobs at the SQL layer', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { onlyWithBackup: true, page: { limit: 10 }, now: NOW });
    expect(JSON.stringify(whereArg(0))).toContain('bh_latest_job');
  });

  it('status=completed_with_errors selects partial jobs on the Breeze leg, never failed', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { filter: { status: ['completed_with_errors'] }, page: { limit: 10 }, now: NOW });
    const serialised = JSON.stringify(whereArg(0));
    expect(serialised).toContain('partial');
    expect(serialised).not.toContain('"failed"');
  });

  it('search escapes LIKE metacharacters before building the ILIKE pattern', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { filter: { search: '100%_srv' }, page: { limit: 10 }, now: NOW });
    expect(JSON.stringify(whereArg(0))).toContain('100\\\\%\\\\_srv');
  });

  it('filters health in memory and keeps fetching batches until the page is full', async () => {
    // DEVIATION: the plan's batch 1 supplied only 2 breeze rows, but with
    // `limit: 2` and a health filter, the production batchSize is
    // `(limit+1)*4 = 12` — 2 rows is "short" by the exhaustion heuristic
    // (`breezeRows.length < batchSize`), so the scan concluded it had reached
    // the end of the feed after batch 1 and never issued batch 2, silently
    // dropping the row this test meant to prove batch 2 supplies. A real
    // LIMIT-12 query genuinely returning only 2 rows WOULD mean "no more data"
    // — the fix is a batch 1 that actually fills batchSize (12), which is what
    // "not exhausted yet" looks like, so batch 2 legitimately fires.
    const limit = 2;
    const batchSize = (limit + 1) * 4; // 12, mirrors the production formula
    const batch1 = Array.from({ length: batchSize }, (_, i) =>
      breezeRow({
        name: i === 0 ? 'a' : `pad${i}`,
        deviceId: i === 0 ? DEVICE_1 : `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`,
        jobStatus: i === 0 ? 'failed' : 'completed',
      }),
    );
    const batch2 = [breezeRow({ name: 'c', jobStatus: 'failed', deviceId: DEVICE_2 })];
    queue(batch1, [], batch2, []);
    const { rows } = await listBackupHealthRows(
      { orgIds: [ORG_A] },
      { filter: { health: ['critical'] }, page: { limit }, now: NOW },
    );
    expect(rows.map((r) => r.name)).toEqual(['a', 'c']);
  });

  it('gives up after BACKUP_HEALTH_MAX_BATCHES but still returns a cursor, never a silently short fleet', async () => {
    // DEVIATION: the plan's fixture fed a single row to every call. Two
    // problems: (1) the exhaustion heuristic (`breezeRows.length < batchSize`)
    // needs each batch to return at LEAST batchSize rows — `(limit+1)*4 = 44`
    // for `limit: 10` — to keep looking like "more data might exist"; a
    // single row reads as exhaustion after batch 1, same bug as the test
    // above. (2) the single row was breeze-shaped only, but every call
    // (including the provider leg) got it, so the provider leg's own
    // projector read `status: undefined` as an unrecognised vendor status and
    // returned health 'unknown' — exactly this test's filter — so it started
    // matching immediately instead of never. A batch of 44 rows carrying both
    // legs' "healthy" fields survives both problems: never exhausted, never
    // 'unknown' under either projector.
    const limit = 10;
    const batchSize = (limit + 1) * 4; // 44
    const neverEndingBatch = Array.from({ length: batchSize }, () => ({
      ...breezeRow({ name: `n${Math.random()}` }),
      ...providerRow({ name: `n${Math.random()}` }),
    }));
    selectMock.mockImplementation((columns?: Record<string, unknown>) =>
      chainMock(columns, { value: neverEndingBatch }),
    );
    const { rows, nextCursor } = await listBackupHealthRows(
      { orgIds: [ORG_A] },
      { filter: { health: ['unknown'] }, page: { limit }, now: NOW },
    );
    expect(rows).toHaveLength(0);
    expect(nextCursor).not.toBeNull();
    // Per batch: breeze leg is 2 subqueries + 1 main call, provider leg is 1
    // main call (it has none of its own) = 4 db.select() calls/batch.
    expect(selectMock.mock.calls.length).toBeLessThanOrEqual(BACKUP_HEALTH_MAX_BATCHES * 4);
  });
});

describe('listBackupHealthRows — pagination', () => {
  it('emits a nextCursor that decodes to the last returned row', async () => {
    queue(
      [breezeRow({ name: 'a' }), breezeRow({ name: 'b', deviceId: DEVICE_2 })],
      [providerRow({ name: 'c' })],
    );
    const { rows, nextCursor } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 2 }, now: NOW });
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(decodeBackupHealthCursor(nextCursor)).toEqual({ v: 1, n: 'b', k: `breeze:${DEVICE_2}` });
  });

  it('emits a null nextCursor once both legs run dry', async () => {
    queue([breezeRow({ name: 'a' })], []);
    const { nextCursor } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(nextCursor).toBeNull();
  });

  it('applies the incoming cursor as a keyset predicate on both legs', async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, n: 'b', k: `breeze:${DEVICE_2}` }), 'utf8').toString('base64url');
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10, cursor }, now: NOW });
    for (const call of [0, 1]) expect(JSON.stringify(whereArg(call))).toContain(`breeze:${DEVICE_2}`);
  });

  it('treats a malformed cursor as no cursor rather than throwing', async () => {
    queue([breezeRow()], []);
    const out = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10, cursor: 'not a token!!' } , now: NOW });
    expect(out.rows).toHaveLength(1);
  });
});

describe('listBackupHealthRows — connection visibility', () => {
  it('treats an invisible connection row (org token) as active and fresh', async () => {
    queue([], [providerRow({ connectionIsActive: null, connectionLastSyncAt: null, connectionSyncIntervalMinutes: null })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]).toMatchObject({ stale: false, health: 'healthy', covered: true });
  });

  it('withdraws the verdict when a visible connection has gone stale', async () => {
    queue([], [providerRow({ connectionLastSyncAt: '2026-09-15T08:00:00.000Z' })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]).toMatchObject({ stale: true, health: 'unknown', covered: false });
  });
});

describe('listBackupHealthRows — 28-day history', () => {
  it('fills provider cells from the ledger and leaves unobserved days null', async () => {
    queue(
      [], [providerRow()],
      [{ providerDeviceId: PROVIDER_ROW, day: '2026-09-14', status: 'failed' }],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]!.history28d).toHaveLength(28);
    expect(rows[0]!.history28d.at(-1)).toEqual({ day: '2026-09-15', status: null });
    expect(rows[0]!.history28d.at(-2)).toEqual({ day: '2026-09-14', status: 'failed' });
  });

  it('folds first-party jobs into the worst status per UTC day', async () => {
    queue(
      [breezeRow()], [],
      [
        { deviceId: DEVICE_1, status: 'completed', at: '2026-09-14T23:00:00.000Z' },
        { deviceId: DEVICE_1, status: 'failed', at: '2026-09-14T01:00:00.000Z' },
      ],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]!.history28d.at(-2)).toEqual({ day: '2026-09-14', status: 'failed' });
  });

  it('issues no history query when the page is empty', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    // Breeze leg = 2 subqueries + 1 main call; provider leg = 1 main call
    // (no subqueries of its own) = 4. Neither history query fires.
    expect(selectMock).toHaveBeenCalledTimes(4);
  });
});

describe('summarizeBackupHealth', () => {
  it('counts a dual-source device once and ORs its coverage', async () => {
    queue(
      [breezeRow({ jobStatus: null, lastSuccessAt: null, hasJobs: false })],
      [providerRow({ breezeDeviceId: DEVICE_1, deviceStatus: 'online', deviceSiteId: SITE_A })],
    );
    const summary = await summarizeBackupHealth({ orgIds: [ORG_A] }, { now: NOW });
    expect(summary.endpoints).toEqual({ total: 1, covered: 1, uncovered: 0 });
    expect(summary.byStatus.no_backups).toBe(1);
    expect(summary.byStatus.completed).toBe(1);
  });

  it('is the all-zero shape for an empty scope, without querying', async () => {
    const summary = await summarizeBackupHealth({ orgIds: [] });
    expect(summary.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('getProviderCoverageForDevices', () => {
  it('maps linked device ids to their provider coverage', async () => {
    queue([{ breezeDeviceId: DEVICE_1, status: 'completed', lastSuccessAt: '2026-09-15T01:00:00.000Z', errorsCount: 0, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 }]);
    const map = await getProviderCoverageForDevices(ORG_A, [DEVICE_1, DEVICE_2], { now: NOW });
    expect(map.get(DEVICE_1)).toEqual({ covered: true, health: 'healthy' });
    expect(map.has(DEVICE_2)).toBe(false);
  });

  it('short-circuits on an empty device list', async () => {
    expect((await getProviderCoverageForDevices(ORG_A, [])).size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('getProviderAttentionItems', () => {
  it('names the vendor device and its customer, and falls back to the org name when the customer row is invisible', async () => {
    queue([
      { id: PROVIDER_ROW, name: 'ACME-SRV02', customerName: 'Acme North', orgName: 'Acme', status: 'failed', lastSuccessAt: null, errorsCount: 2, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 },
      { id: 'f3333333-3333-4333-8333-333333333333', name: 'ACME-WS09', customerName: null, orgName: 'Acme', status: 'no_backups', lastSuccessAt: null, errorsCount: 0, connectionIsActive: null, connectionLastSyncAt: null, connectionSyncIntervalMinutes: null },
    ]);
    const items = await getProviderAttentionItems(ORG_A, { allowedDeviceIds: null, limit: 20, now: NOW });
    expect(items[0]).toMatchObject({ id: `provider:${PROVIDER_ROW}`, severity: 'critical' });
    expect(items[0]!.description).toBe('ACME-SRV02 (Acme North) — failed');
    expect(items[1]!.description).toBe('ACME-WS09 (Acme) — no_backups');
  });

  it('drops non-critical rows', async () => {
    queue([{ id: PROVIDER_ROW, name: 'ok', customerName: 'Acme', orgName: 'Acme', status: 'completed', lastSuccessAt: '2026-09-15T01:00:00.000Z', errorsCount: 0, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 }]);
    expect(await getProviderAttentionItems(ORG_A, { allowedDeviceIds: null, limit: 20, now: NOW })).toEqual([]);
  });

  it('hides unlinked rows from a site-restricted caller', async () => {
    queue([]);
    await getProviderAttentionItems(ORG_A, { allowedDeviceIds: [DEVICE_1], limit: 20, now: NOW });
    const conditions = flatConditions(whereArg(0));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'inArray', column: 'bpd.breeze_device_id', values: [DEVICE_1] }));
  });
});

describe('getFirstPartyCoverageForDevices', () => {
  it('reports covered for a device whose newest restorable job is inside 48h', async () => {
    queue([{ deviceId: DEVICE_1, jobStatus: 'completed', lastSuccessAt: '2026-09-15T02:00:00.000Z', errorsCount: 0, hasJobs: true }]);
    const map = await getFirstPartyCoverageForDevices(ORG_A, [DEVICE_1], { now: NOW });
    expect(map.get(DEVICE_1)).toMatchObject({ covered: true, status: 'completed' });
  });
});
