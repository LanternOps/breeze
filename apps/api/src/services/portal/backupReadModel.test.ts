// apps/api/src/services/portal/backupReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { backupTile } from './backupReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('backupTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns latest passed verification and configured-device counts', async () => {
    state.rows.push(
      [{ total: 10 }],
      [{ configured: 7 }],
      [{
        completedAt: new Date('2026-09-02T09:00:00Z'),
        verificationType: 'test_restore',
      }],
    );

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'test_restore',
      configured: 7,
      total: 10,
      asOf: now.toISOString(),
    });

    for (const where of state.wheres) {
      const query = new PgDialect().sqlToQuery(where as SQL);
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('returns not_configured when no active config has device evidence', async () => {
    state.rows.push([{ total: 10 }], [{ configured: 0 }], []);
    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toMatchObject({
      status: 'not_configured',
      completedAt: null,
      configured: 0,
      total: 10,
      asOf: now.toISOString(),
    });
  });
});

// W06 — backup overview + per-device backup evidence
const { getBackupHealthSummaryMock } = vi.hoisted(() => ({
  getBackupHealthSummaryMock: vi.fn(),
}));
vi.mock('../../routes/backup/readinessCalculator', () => ({
  getBackupHealthSummary: getBackupHealthSummaryMock,
}));

import { backupDevicesPage, backupOverview } from './backupReadModel';
import { db } from '../../db';

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0;
  state.wheres.length = 0;
});

it('returns overview verification, restore, breach, and readiness evidence', async () => {
  state.rows.push(
    [{ total: 3 }],
    [{ configured: 2 }],
    [{ completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'integrity' }],
    [{ completedAt: new Date('2026-09-01T09:00:00Z') }],
    [{ eventType: 'rpo_breach' }, { eventType: 'rto_breach' }, { eventType: 'missed_backup' }],
    [{ readinessCount: 2 }],
  );
  getBackupHealthSummaryMock.mockResolvedValue({
    verification: {}, readiness: { averageScore: 83 }, escalations: {},
  });

  await expect(backupOverview(ORG_ID, {
    timezone: 'America/Denver',
    now: new Date('2026-09-02T12:00:00Z'),
  })).resolves.toEqual({
    asOf: '2026-09-02T12:00:00.000Z',
    dataStatus: 'ok',
    protected: 2,
    unprotected: 1,
    total: 3,
    lastPassedVerification: {
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'integrity',
    },
    lastTestRestoreAt: '2026-09-01T09:00:00.000Z',
    openRpoBreaches: 2, // rpo_breach + missed_backup (RPO family)
    openRtoBreaches: 1,
    meanReadinessScore: 83,
  });
  expect(getBackupHealthSummaryMock).toHaveBeenCalledWith(ORG_ID);

  for (const where of state.wheres) {
    expect(
      new PgDialect().sqlToQuery(where as SQL).params,
    ).toContain(ORG_ID);
  }
});

it('returns every enrolled device, including not configured', async () => {
  state.rows.push(
    [{ count: 2 }],
    [{
      id: 'd-1',
      hostname: 'Laptop',
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
    }],
  );

  await expect(
    backupDevicesPage(ORG_ID, {
      page: 1,
      limit: 25,
      timezone: 'America/Denver',
      now: new Date('2026-09-02T12:00:00Z'),
    }),
  ).resolves.toEqual({
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
    }],
    pagination: { page: 1, limit: 25, total: 2 },
  });

  const compiled = state.wheres.map((where) =>
    new PgDialect().sqlToQuery(where as SQL),
  );
  expect(compiled.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);
  for (const query of compiled) expect(query.params).toContain(ORG_ID);

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
});

it('reports ok when an out-of-range page is empty but the org has devices', async () => {
  state.rows.push([{ count: 2 }], []);

  await expect(backupDevicesPage(ORG_ID, {
    page: 2,
    limit: 25,
    timezone: 'America/Denver',
    now: new Date('2026-09-02T12:00:00Z'),
  })).resolves.toMatchObject({
    dataStatus: 'ok',
    data: [],
    pagination: { page: 2, limit: 25, total: 2 },
  });
});

it('returns null breach counts when backups are not configured', async () => {
  state.rows.push(
    [{ total: 3 }],
    [{ configured: 0 }],
    [],
    [],
    [],
    [{ readinessCount: 0 }],
  );
  getBackupHealthSummaryMock.mockResolvedValue({
    verification: {}, readiness: { averageScore: 0 }, escalations: {},
  });

  await expect(backupOverview(ORG_ID, {
    timezone: 'America/Denver',
    now: new Date('2026-09-02T12:00:00Z'),
  })).resolves.toMatchObject({
    dataStatus: 'not_configured',
    openRpoBreaches: null,
    openRtoBreaches: null,
    meanReadinessScore: null,
  });
});
