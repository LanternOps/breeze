import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import type { BackupHealth, BackupHealthRow, ExternalBackupStatus } from '@breeze/shared';

/**
 * The db mock answers each select by `<table>:<sorted selection keys>` rather
 * than by call order: backupOverview runs backupTile, three evidence queries
 * and the ledger-health load concurrently, and a positional queue would make
 * every test depend on promise-scheduling order.
 */
const state = vi.hoisted(() => ({
  byKey: {} as Record<string, unknown[][]>,
  keys: [] as string[],
  wheres: [] as unknown[],
  joins: [] as unknown[],
  orderBys: [] as unknown[],
  selections: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => {
      state.selections.push(selection);
      const chain: Record<string, unknown> = {};
      let key = '';
      chain.from = vi.fn((table: Table) => {
        key = `${getTableName(table)}:${Object.keys(selection).sort().join(',')}`;
        state.keys.push(key);
        return chain;
      });
      for (const method of ['innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        chain[method] = vi.fn((arg: unknown, on?: unknown) => {
          if ((method === 'innerJoin' || method === 'leftJoin') && on) state.joins.push(on);
          if (method === 'where') state.wheres.push(arg);
          if (method === 'orderBy') state.orderBys.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(state.byKey[key]?.shift() ?? []).then(resolve, reject);
      return chain;
    }),
  },
}));

// The unified read model is its own module. `listBackupHealthRows` is faked
// with the REAL label rule (backupHealthRows.providerLabelFor): the vendor name
// is only ever returned to a caller that did not ask for portal labels, or for
// a row whose connection turned the portal-name toggle on (spec D5). A read
// model that forgot `labels: 'portal'` therefore leaks "Cove Data Protection"
// in these tests exactly as it would in production.
type FakeProviderRow = Partial<BackupHealthRow> & { portalShowProviderName?: boolean };
const health = vi.hoisted(() => ({
  providerRows: [] as unknown[],
  pageSize: 0,
  firstParty: new Map<string, unknown>(),
  listBackupHealthRows: vi.fn(),
  getFirstPartyCoverageForDevices: vi.fn(),
}));
vi.mock('../backupHealthReadModel', () => ({
  listBackupHealthRows: health.listBackupHealthRows,
  getFirstPartyCoverageForDevices: health.getFirstPartyCoverageForDevices,
}));

import { backupDevicesPage, backupOverview, backupTile } from './backupReadModel';
import { db } from '../../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-02T12:00:00Z');

function rows(key: string, ...batches: unknown[][]) {
  (state.byKey[key] ??= []).push(...batches);
}

const K = {
  tileTotal: 'devices:total',
  tileActiveConfig: 'backup_configs:id',
  tileConfigured: 'backup_jobs:configured',
  tileVerification: 'backup_verifications:completedAt,verificationType',
  branding: 'portal_branding:enableBackups',
  providerCounts: 'backup_provider_devices:linkedOnly,unlinked',
  restore: 'backup_verifications:completedAt,status',
  breaches: 'backup_sla_events:eventType',
  readiness: 'devices:meanReadinessScore,readinessCount,totalDevices',
  ledgerIds: 'devices:id',
  pageCount: 'devices:count',
  pageRows:
    'devices:configured,displayName,estimatedRpoMinutes,estimatedRtoMinutes,hostname,id,lastBackupAt,lastBackupStatus,openBreaches,readinessScore,restoreTimeSeconds,testRestoreAt,testRestoreStatus',
} as const;

function providerRow(over: FakeProviderRow = {}): FakeProviderRow {
  return {
    key: 'provider:p-1',
    source: 'provider',
    providerKey: 'cove',
    orgId: ORG_ID,
    orgName: 'Acme',
    siteId: null,
    deviceId: null,
    name: 'BACKUP-SVR',
    accountType: 'endpoint',
    status: 'completed',
    health: 'healthy',
    covered: true,
    stale: false,
    lastSuccessAt: '2026-09-02T03:00:00.000Z',
    portalShowProviderName: false,
    ...over,
  };
}

function firstParty(
  deviceId: string,
  status: ExternalBackupStatus,
  healthValue: BackupHealth,
  lastSuccessAt: string | null,
) {
  health.firstParty.set(deviceId, { covered: healthValue === 'healthy', health: healthValue, status, lastSuccessAt });
}

function pageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    hostname: 'file01',
    displayName: null,
    configured: false,
    lastBackupAt: null,
    lastBackupStatus: null,
    testRestoreStatus: null,
    testRestoreAt: null,
    restoreTimeSeconds: null,
    openBreaches: [],
    readinessScore: null,
    estimatedRtoMinutes: null,
    estimatedRpoMinutes: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.byKey = {};
  state.keys.length = 0;
  state.wheres.length = 0;
  state.joins.length = 0;
  state.orderBys.length = 0;
  state.selections.length = 0;
  health.providerRows = [];
  health.pageSize = 0;
  health.firstParty = new Map();

  health.listBackupHealthRows.mockImplementation(
    async (_scope: unknown, opts: { labels?: 'vendor' | 'portal'; page: { limit: number; cursor?: string | null } }) => {
      const size = health.pageSize || opts.page.limit;
      const start = opts.page.cursor ? Number(opts.page.cursor) : 0;
      const slice = (health.providerRows as FakeProviderRow[]).slice(start, start + size);
      const labelled = slice.map(({ portalShowProviderName, ...row }) => ({
        ...row,
        providerLabel:
          (opts.labels ?? 'vendor') === 'portal' && !portalShowProviderName
            ? 'Managed cloud backup'
            : 'Cove Data Protection',
      }));
      const next = start + size < health.providerRows.length ? String(start + size) : null;
      return { rows: labelled, nextCursor: next };
    },
  );
  health.getFirstPartyCoverageForDevices.mockImplementation(async (_orgId: string, ids: string[]) => {
    const out = new Map();
    for (const id of ids) {
      out.set(id, health.firstParty.get(id) ?? { covered: false, health: 'critical', status: 'no_backups', lastSuccessAt: null });
    }
    return out;
  });
});

function compiledWheres() {
  return state.wheres.map((where) => new PgDialect().sqlToQuery(where as SQL));
}

// ── backupTile ─────────────────────────────────────────────────────────────

describe('backupTile', () => {
  it('returns latest passed verification and configured-device counts', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileActiveConfig, [{ id: 'active-config' }]);
    rows(K.tileConfigured, [{ configured: 7 }]);
    rows(K.tileVerification, [{ completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'test_restore' }]);

    await expect(backupTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'ok',
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'test_restore',
      configured: 7,
      total: 10,
      asOf: NOW.toISOString(),
    });

    for (const query of compiledWheres()) expect(query.params).toContain(ORG_ID);

    const verificationPredicate = compiledWheres().find(({ sql }) => sql.includes('"backup_verifications"."status"'));
    expect(verificationPredicate?.params).toContain('passed');

    const configJoin = state.joins
      .map((join) => new PgDialect().sqlToQuery(join as SQL))
      .find(({ sql }) => sql.includes('"backup_configs"."org_id"'));
    expect(configJoin?.sql).toContain('"backup_configs"."org_id" = $');
    expect(configJoin?.params).toContain(ORG_ID);
  });

  it('returns no_data when an active config exists but no job or verification has run', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileActiveConfig, [{ id: 'active-config' }]);
    rows(K.tileConfigured, [{ configured: 0 }]);
    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({
      status: 'no_data', completedAt: null, configured: 0, total: 10, asOf: NOW.toISOString(),
    });
  });

  it('returns not_configured only when the organization has no active config', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileConfigured, [{ configured: 0 }]);
    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({
      status: 'not_configured', completedAt: null, configured: 0, total: 10,
    });
    expect(compiledWheres().some(({ sql, params }) =>
      sql.includes('"backup_configs"."org_id" =') && params.includes(ORG_ID))).toBe(true);
  });

  it('never reads third-party backup rows while portal Backups is off (tile gate, #6012)', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileConfigured, [{ configured: 0 }]);
    rows(K.branding, [{ enableBackups: false }]);
    rows(K.providerCounts, [{ linkedOnly: 4, unlinked: 2 }]);

    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({
      status: 'not_configured', configured: 0, total: 10,
    });
    expect(state.keys).not.toContain(K.providerCounts);
  });

  it('keeps an org with Backups on but no third-party rows exactly as before', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileActiveConfig, [{ id: 'active-config' }]);
    rows(K.tileConfigured, [{ configured: 7 }]);
    rows(K.branding, [{ enableBackups: true }]);
    rows(K.providerCounts, [{ linkedOnly: 0, unlinked: 0 }]);

    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({ status: 'no_data', configured: 7, total: 10 });
  });

  it('counts a device backed up only by a third party as configured once Backups is on', async () => {
    rows(K.tileTotal, [{ total: 10 }]);
    rows(K.tileActiveConfig, [{ id: 'active-config' }]);
    rows(K.tileConfigured, [{ configured: 3 }]);
    rows(K.branding, [{ enableBackups: true }]);
    rows(K.providerCounts, [{ linkedOnly: 2, unlinked: 1 }]);

    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({ configured: 6, total: 11 });

    const providerQuery = compiledWheres().find(({ sql }) => sql.includes('"backup_provider_devices"."org_id"'));
    expect(providerQuery?.params).toEqual([ORG_ID]);
    // The linked-device join is org-pinned too, so a stale cross-org link can
    // never count one org's device toward another org's coverage.
    const deviceJoin = state.joins
      .map((join) => new PgDialect().sqlToQuery(join as SQL))
      .find(({ sql }) => sql.includes('"backup_provider_devices"."breeze_device_id"'));
    expect(deviceJoin?.sql).toContain('"devices"."org_id" = $');
    expect(deviceJoin?.params).toContain(ORG_ID);
  });

  it('is configured, not not_configured, for a third-party-only org — but never claims a verification', async () => {
    rows(K.tileTotal, [{ total: 4 }]);
    rows(K.tileConfigured, [{ configured: 0 }]);
    rows(K.branding, [{ enableBackups: true }]);
    rows(K.providerCounts, [{ linkedOnly: 0, unlinked: 3 }]);

    await expect(backupTile(ORG_ID, NOW)).resolves.toMatchObject({
      status: 'no_data', completedAt: null, verificationType: null, configured: 3, total: 7,
    });
  });
});

// ── backupOverview ─────────────────────────────────────────────────────────

describe('backupOverview', () => {
  function seedOverview() {
    rows(K.tileTotal, [{ total: 3 }]);
    rows(K.tileActiveConfig, [{ id: 'active-config' }]);
    rows(K.tileConfigured, [{ configured: 2 }]);
    rows(K.tileVerification, [{ completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'integrity' }]);
    rows(K.branding, [{ enableBackups: true }]);
    rows(K.providerCounts, [{ linkedOnly: 0, unlinked: 1 }]);
    rows(K.restore, [{ completedAt: new Date('2026-09-01T09:00:00Z'), status: 'failed' }]);
    rows(K.breaches, [{ eventType: 'rpo_breach' }, { eventType: 'rto_breach' }, { eventType: 'missed_backup' }]);
    rows(K.readiness, [{ readinessCount: 2, totalDevices: 3, meanReadinessScore: 83 }]);
  }

  it('returns verification, restore, breach and readiness evidence plus the ledger health breakdown', async () => {
    seedOverview();
    rows(K.ledgerIds, [{ id: 'd-1' }, { id: 'd-2' }, { id: 'd-3' }]);
    firstParty('d-1', 'completed', 'healthy', '2026-09-02T02:00:00.000Z');
    firstParty('d-2', 'failed', 'critical', null);
    // d-3: no first-party jobs, linked to a third-party row that is healthy.
    health.providerRows = [
      providerRow({ key: 'provider:p-3', deviceId: 'd-3', name: 'd-3' }),
      providerRow({ key: 'provider:p-9', deviceId: null, status: 'failed', health: 'critical' }),
    ];

    await expect(backupOverview(ORG_ID, { timezone: 'America/Denver', now: NOW })).resolves.toEqual({
      asOf: '2026-09-02T12:00:00.000Z',
      dataStatus: 'ok',
      // 3 managed devices + 1 unlinked third-party row = the 4 table rows (#7505).
      protected: 3,
      unprotected: 1,
      total: 4,
      lastPassedVerification: { completedAt: '2026-09-02T09:00:00.000Z', verificationType: 'integrity' },
      lastTestRestoreAt: '2026-09-01T09:00:00.000Z',
      lastTestRestoreStatus: 'failed',
      openRpoBreaches: 2, // rpo_breach + missed_backup (RPO family)
      openRtoBreaches: 1,
      meanReadinessScore: 83,
      readinessScoredDevices: 2,
      readinessTotalDevices: 3,
      // d-1 healthy, d-3 healthy (via provider), d-2 critical, external p-9 critical.
      byHealth: { healthy: 2, warning: 0, critical: 2, unknown: 0 },
      externalProviders: ['Managed cloud backup'],
    });

    for (const query of compiledWheres()) expect(query.params).toContain(ORG_ID);
    expect(health.listBackupHealthRows).toHaveBeenCalledWith(
      { orgIds: [ORG_ID] },
      expect.objectContaining({ sources: ['provider'], labels: 'portal' }),
    );
    expect(health.getFirstPartyCoverageForDevices).toHaveBeenCalledWith(ORG_ID, ['d-1', 'd-2', 'd-3'], { now: NOW });

    const restorePredicate = compiledWheres().find(({ params }) => params.includes('test_restore'));
    expect(restorePredicate).toBeDefined();
    expect(restorePredicate!.params).not.toContain('passed');

    const verificationOrderings = state.orderBys
      .map((orderBy) => new PgDialect().sqlToQuery(orderBy as SQL).sql)
      .filter((query) => query.includes('backup_verifications'));
    expect(verificationOrderings).toContainEqual(expect.stringContaining('desc nulls last'));

    const readinessSelection = state.selections
      .map((selection) => selection as Record<string, unknown>)
      .find((selection) => 'meanReadinessScore' in selection);
    expect(new PgDialect().sqlToQuery(readinessSelection?.meanReadinessScore as SQL).sql)
      .toContain('avg("recovery_readiness"."readiness_score")');
    expect(new PgDialect().sqlToQuery(readinessSelection?.totalDevices as SQL).sql).toContain('count("devices"."id")');

    const readinessJoin = state.joins
      .map((join) => new PgDialect().sqlToQuery(join as SQL))
      .find(({ sql }) => sql.includes('"recovery_readiness"."org_id"'));
    expect(readinessJoin?.sql).toContain('"recovery_readiness"."org_id" = $');
    expect(readinessJoin?.params).toContain(ORG_ID);
  });

  it('never names the vendor while the connection keeps the portal-name toggle off (D5)', async () => {
    seedOverview();
    rows(K.ledgerIds, []);
    health.providerRows = [providerRow({ portalShowProviderName: false })];

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(overview.externalProviders).toEqual(['Managed cloud backup']);
    expect(JSON.stringify(overview)).not.toContain('Cove');
  });

  it('names the vendor once the MSP turns the toggle on, de-duplicated and sorted', async () => {
    seedOverview();
    rows(K.ledgerIds, []);
    health.providerRows = [
      providerRow({ key: 'provider:a', portalShowProviderName: true }),
      providerRow({ key: 'provider:b', portalShowProviderName: true }),
      providerRow({ key: 'provider:c', portalShowProviderName: false }),
    ];

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(overview.externalProviders).toEqual(['Cove Data Protection', 'Managed cloud backup']);
  });

  it('drops any row the read model returns for another org (defence in depth)', async () => {
    seedOverview();
    rows(K.ledgerIds, []);
    health.providerRows = [
      providerRow({ key: 'provider:mine', health: 'healthy' }),
      providerRow({ key: 'provider:theirs', orgId: OTHER_ORG_ID, health: 'critical', portalShowProviderName: true }),
    ];

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(overview.byHealth).toEqual({ healthy: 1, warning: 0, critical: 0, unknown: 0 });
    expect(overview.externalProviders).toEqual(['Managed cloud backup']);
    expect(health.listBackupHealthRows.mock.calls.every(([scope]) =>
      JSON.stringify(scope) === JSON.stringify({ orgIds: [ORG_ID] }))).toBe(true);
  });

  it('leaves devices with no backup from any source out of the health breakdown', async () => {
    seedOverview();
    rows(K.ledgerIds, [{ id: 'd-1' }, { id: 'd-2' }]);
    firstParty('d-1', 'completed', 'healthy', '2026-09-02T02:00:00.000Z');

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(overview.byHealth).toEqual({ healthy: 1, warning: 0, critical: 0, unknown: 0 });
    expect(overview.externalProviders).toEqual([]);
  });

  it('walks every page of third-party rows, not just the first', async () => {
    seedOverview();
    rows(K.ledgerIds, []);
    health.pageSize = 2;
    health.providerRows = Array.from({ length: 5 }, (_, i) =>
      providerRow({ key: `provider:p-${i}`, health: i === 4 ? 'critical' : 'healthy' }));

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(overview.byHealth).toEqual({ healthy: 4, warning: 0, critical: 1, unknown: 0 });
    expect(health.listBackupHealthRows).toHaveBeenCalledTimes(3);
  });

  it('retains real breach counts when backups are not configured', async () => {
    rows(K.tileTotal, [{ total: 3 }]);
    rows(K.tileConfigured, [{ configured: 0 }]);
    rows(K.breaches, [{ eventType: 'missed_backup' }, { eventType: 'rto_breach' }]);
    rows(K.readiness, [{ readinessCount: 0, totalDevices: 3, meanReadinessScore: null }]);
    await expect(backupOverview(ORG_ID, { timezone: 'America/Denver', now: NOW })).resolves.toMatchObject({
      dataStatus: 'not_configured',
      openRpoBreaches: 1,
      openRtoBreaches: 1,
      meanReadinessScore: null,
      readinessScoredDevices: 0,
      readinessTotalDevices: 3,
    });
  });
});

// ── backupDevicesPage ──────────────────────────────────────────────────────

describe('backupDevicesPage', () => {
  const args = (over: Partial<{ page: number; limit: number }> = {}) => ({
    page: 1, limit: 25, timezone: 'America/Denver', now: NOW, ...over,
  });

  it('serializes raw-SQL timestamps that postgres-js returns as strings (#4562)', async () => {
    rows(K.pageCount, [{ count: 1 }]);
    rows(K.pageRows, [pageRow({
      configured: true, lastBackupAt: '2026-09-02 09:00:00+00', lastBackupStatus: 'completed',
      testRestoreStatus: 'passed', testRestoreAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120,
    })]);
    firstParty('d-1', 'completed', 'healthy', '2026-09-02T09:00:00.000Z');

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data[0]).toMatchObject({
      lastRestorePointAt: '2026-09-02T09:00:00.000Z',
      lastTestRestore: { status: 'passed', completedAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120 },
    });
  });

  it('marks a completed_with_errors restore point as degraded (#5396)', async () => {
    rows(K.pageCount, [{ count: 1 }]);
    rows(K.pageRows, [pageRow({
      configured: true, lastBackupAt: '2026-09-02 09:00:00+00', lastBackupStatus: 'completed_with_errors',
    })]);
    firstParty('d-1', 'completed_with_errors', 'warning', '2026-09-02T09:00:00.000Z');

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data[0]!.lastRestorePointDegraded).toBe(true);
  });

  it('returns every enrolled device, including one with no backup from any source', async () => {
    rows(K.pageCount, [{ count: 2 }]);
    rows(K.pageRows, [pageRow({ hostname: 'Laptop' })]);

    await expect(backupDevicesPage(ORG_ID, args())).resolves.toEqual({
      dataStatus: 'ok',
      asOf: '2026-09-02T12:00:00.000Z',
      data: [{
        id: 'd-1',
        name: 'Laptop',
        configured: false,
        lastRestorePointAt: null,
        lastRestorePointDegraded: false,
        lastTestRestore: null,
        openBreaches: [],
        readinessScore: null,
        estimatedRtoMinutes: null,
        estimatedRpoMinutes: null,
        source: 'breeze',
        providerLabel: null,
        status: 'no_backups',
        // A device nobody backs up is not a health verdict on the customer's
        // page — the row itself says "No backup has run for this device yet".
        health: 'unknown',
        lastSuccessAt: null,
      }],
      pagination: { page: 1, limit: 25, total: 2 },
    });

    const compiled = compiledWheres();
    expect(compiled.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);
    for (const query of compiled) expect(query.params).toContain(ORG_ID);

    const readinessJoin = state.joins
      .map((join) => new PgDialect().sqlToQuery(join as SQL))
      .find(({ sql }) => sql.includes('"recovery_readiness"."org_id"'));
    expect(readinessJoin?.sql).toContain('"recovery_readiness"."org_id" = $');
    expect(readinessJoin?.params).toContain(ORG_ID);

    const deviceSelection = vi.mocked(db.select).mock.calls
      .map(([selection]) => selection as Record<string, unknown>)
      .find((selection) => 'configured' in selection);
    expect(deviceSelection).toBeDefined();
    const expectedOrgPredicates = {
      configured: 2,
      lastBackupAt: 1,
      lastBackupStatus: 1,
      testRestoreStatus: 1,
      testRestoreAt: 1,
      restoreTimeSeconds: 1,
      openBreaches: 1,
    } as const;
    for (const [field, expectedCount] of Object.entries(expectedOrgPredicates)) {
      const query = new PgDialect().sqlToQuery(deviceSelection?.[field] as SQL);
      expect(
        query.params.filter((param) => param === ORG_ID),
        `${field} must retain every organization predicate`,
      ).toHaveLength(expectedCount);
    }
    expect(health.getFirstPartyCoverageForDevices).toHaveBeenCalledWith(ORG_ID, ['d-1'], { now: NOW });
  });

  it('merges a device backed up by both: first-party status wins, the fresher restore point and the provider label ride along', async () => {
    rows(K.pageCount, [{ count: 1 }]);
    rows(K.pageRows, [pageRow({
      configured: true, lastBackupAt: '2026-09-01 00:00:00+00', lastBackupStatus: 'completed',
      testRestoreStatus: 'passed', testRestoreAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120, readinessScore: 92,
    })]);
    firstParty('d-1', 'completed', 'warning', '2026-09-01T00:00:00.000Z');
    health.providerRows = [providerRow({
      key: 'provider:p-1', deviceId: 'd-1', status: 'completed_with_errors', health: 'warning',
      lastSuccessAt: '2026-09-02T03:00:00.000Z',
    })];

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data).toHaveLength(1); // one row per Breeze device, never two
    expect(page.data[0]).toMatchObject({
      id: 'd-1',
      configured: true,
      source: 'breeze',
      providerLabel: 'Managed cloud backup',
      status: 'completed',
      health: 'warning',
      lastRestorePointAt: '2026-09-02T03:00:00.000Z',
      lastSuccessAt: '2026-09-02T03:00:00.000Z',
      // The newest restore point is the provider's, and it had errors.
      lastRestorePointDegraded: true,
      lastTestRestore: { status: 'passed' },
      readinessScore: 92,
    });
    expect(page.pagination.total).toBe(1);
  });

  it('shows a device only a third party backs up as configured, with the provider status', async () => {
    rows(K.pageCount, [{ count: 1 }]);
    rows(K.pageRows, [pageRow()]);
    health.providerRows = [providerRow({
      key: 'provider:p-1', deviceId: 'd-1', status: 'failed', health: 'critical', lastSuccessAt: '2026-08-30T00:00:00.000Z',
    })];

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data[0]).toMatchObject({
      // A managed device, but its backup — and so its status — is the third party's.
      id: 'd-1', configured: true, source: 'external', status: 'failed', health: 'critical',
      providerLabel: 'Managed cloud backup', lastRestorePointAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('lists third-party rows with no Breeze device after the devices, as external rows', async () => {
    rows(K.pageCount, [{ count: 1 }]);
    rows(K.pageRows, [pageRow({ configured: true })]);
    firstParty('d-1', 'completed', 'healthy', '2026-09-02T02:00:00.000Z');
    health.providerRows = [providerRow({
      key: 'provider:p-9', deviceId: null, name: 'BACKUP-SVR', status: 'failed', health: 'critical',
      lastSuccessAt: '2026-08-30T00:00:00.000Z', portalShowProviderName: true,
    })];

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data.map((d) => d.id)).toEqual(['d-1', 'provider:p-9']);
    expect(page.data[1]).toEqual({
      id: 'provider:p-9',
      name: 'BACKUP-SVR',
      configured: true,
      lastRestorePointAt: '2026-08-30T00:00:00.000Z',
      lastRestorePointDegraded: false,
      lastTestRestore: null,
      openBreaches: [],
      readinessScore: null,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
      source: 'external',
      providerLabel: 'Cove Data Protection',
      status: 'failed',
      health: 'critical',
      lastSuccessAt: '2026-08-30T00:00:00.000Z',
    });
    expect(page.pagination.total).toBe(2);
  });

  it('pages across devices then external rows without repeating or dropping any', async () => {
    health.providerRows = [
      providerRow({ key: 'provider:x-1', deviceId: null, name: 'EXT-1' }),
      providerRow({ key: 'provider:x-2', deviceId: null, name: 'EXT-2' }),
    ];
    // 1 device, limit 2: page 1 = [d-1, x-1], page 2 = [x-2].
    rows(K.pageCount, [{ count: 1 }], [{ count: 1 }]);
    rows(K.pageRows, [pageRow({ configured: true })], []);

    const first = await backupDevicesPage(ORG_ID, args({ page: 1, limit: 2 }));
    expect(first.data.map((d) => d.id)).toEqual(['d-1', 'provider:x-1']);
    const second = await backupDevicesPage(ORG_ID, args({ page: 2, limit: 2 }));
    expect(second.data.map((d) => d.id)).toEqual(['provider:x-2']);
    expect(first.pagination.total).toBe(3);
    expect(second.pagination.total).toBe(3);
  });

  it('keeps external rows off a page that is entirely managed devices, and starts them where the devices end', async () => {
    health.providerRows = [
      providerRow({ key: 'provider:x-1', deviceId: null, name: 'EXT-1' }),
      providerRow({ key: 'provider:x-2', deviceId: null, name: 'EXT-2' }),
    ];
    // 3 devices, limit 2: page 1 = [d-1, d-2], page 2 = [d-3, x-1], page 3 = [x-2].
    rows(K.pageCount, [{ count: 3 }], [{ count: 3 }], [{ count: 3 }]);
    rows(
      K.pageRows,
      [pageRow({ id: 'd-1' }), pageRow({ id: 'd-2' })],
      [pageRow({ id: 'd-3' })],
      [],
    );

    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await backupDevicesPage(ORG_ID, args({ page, limit: 2 })));
    expect(pages.map((p) => p.data.map((d) => d.id))).toEqual([
      ['d-1', 'd-2'],
      ['d-3', 'provider:x-1'],
      ['provider:x-2'],
    ]);
    expect(new Set(pages.map((p) => p.pagination.total))).toEqual(new Set([5]));
  });

  it('never lists another org\'s third-party row', async () => {
    rows(K.pageCount, [{ count: 0 }]);
    rows(K.pageRows, []);
    health.providerRows = [providerRow({ key: 'provider:theirs', orgId: OTHER_ORG_ID, deviceId: null })];

    const page = await backupDevicesPage(ORG_ID, args());
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(page.dataStatus).toBe('no_data');
  });

  it('reports ok when an out-of-range page is empty but the org has devices', async () => {
    rows(K.pageCount, [{ count: 2 }]);
    rows(K.pageRows, []);
    await expect(backupDevicesPage(ORG_ID, args({ page: 2 }))).resolves.toMatchObject({
      dataStatus: 'ok', data: [], pagination: { page: 2, limit: 25, total: 2 },
    });
  });
});
