import { beforeEach, describe, expect, it, vi } from 'vitest';

const tiles = vi.hoisted(() => ({
  securityScoreTile: vi.fn(),
  devicesProtectedTile: vi.fn(),
  patchesAppliedTile: vi.fn(),
  backupTile: vi.fn(),
  supportTile: vi.fn(),
  actionItemsTile: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') dbState.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(dbState.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

vi.mock('./securityReadModel', () => ({
  securityScoreTile: tiles.securityScoreTile,
  devicesProtectedTile: tiles.devicesProtectedTile,
}));
vi.mock('./patchReadModel', () => ({
  patchesAppliedTile: tiles.patchesAppliedTile,
}));
vi.mock('./backupReadModel', () => ({ backupTile: tiles.backupTile }));
vi.mock('./ticketReadModel', () => ({ supportTile: tiles.supportTile }));
vi.mock('./actionItemsReadModel', () => ({
  actionItemsTile: tiles.actionItemsTile,
}));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { awaitingYouTile, dashboardForOrg } from './dashboard';

describe('portal dashboard read model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.wheres = [];
  });

  it('counts only reviewable proposals and invoices with balance due', async () => {
    dbState.rows.push([{ count: 2 }], [{ count: 3 }]);
    const now = new Date('2026-09-02T12:00:00Z');

    await expect(awaitingYouTile('org-1', now)).resolves.toEqual({
      status: 'ok',
      proposals: 2,
      invoices: 3,
      asOf: now.toISOString(),
    });

    expect(dbState.wheres).toHaveLength(2);
    const queries = dbState.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    for (const query of queries) {
      expect(query.sql).toMatch(/"(quotes|invoices)"\."org_id" = \$1/);
      expect(query.params).toContain('org-1');
    }
    expect(queries[1]!.sql).toContain('in ($2, $3, $4)');
    expect(queries[1]!.params).toEqual([
      'org-1',
      'sent',
      'partially_paid',
      'overdue',
      '0',
    ]);
  });

  it('runs all dashboard tiles and preserves independent statuses', async () => {
    const now = new Date('2026-09-02T12:00:00Z');
    tiles.securityScoreTile.mockResolvedValue({
      status: 'stale', score: 77, band: 'good', delta30d: -2,
      capturedAt: '2026-08-31T12:00:00.000Z',
    });
    tiles.devicesProtectedTile.mockResolvedValue({
      status: 'ok', protected: 8, unprotected: 1, unknown: 1,
      total: 10, asOf: now.toISOString(),
    });
    tiles.patchesAppliedTile.mockResolvedValue({
      status: 'ok', applied: 14, devicesWithOutstandingCritical: 1,
      month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
    });
    tiles.backupTile.mockResolvedValue({
      status: 'not_configured', completedAt: null, verificationType: null,
      configured: 0, total: 10, asOf: now.toISOString(),
    });
    tiles.supportTile.mockResolvedValue({
      status: 'no_data', openTickets: 0, averageFirstResponseMinutes: null,
      sampleSize: 0, month: '2026-09', timezone: 'America/Denver',
      asOf: now.toISOString(),
    });
    tiles.actionItemsTile.mockResolvedValue({
      status: 'ok', count: 2, topIssues: [], asOf: now.toISOString(),
    });
    dbState.rows.push([{ count: 1 }], [{ count: 2 }]);

    const dto = await dashboardForOrg('org-1', {
      timezone: 'America/Denver',
      now,
    });

    expect(dto).toEqual({
      asOf: now.toISOString(),
      timezone: 'America/Denver',
      securityScore: {
        status: 'stale', score: 77, band: 'good', delta30d: -2,
        capturedAt: '2026-08-31T12:00:00.000Z',
      },
      devicesProtected: {
        status: 'ok', protected: 8, unprotected: 1, unknown: 1,
        total: 10, asOf: now.toISOString(),
      },
      patchesApplied: {
        status: 'ok', applied: 14, devicesWithOutstandingCritical: 1,
        month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
      },
      backup: {
        status: 'not_configured', completedAt: null, verificationType: null,
        configured: 0, total: 10, asOf: now.toISOString(),
      },
      support: {
        status: 'no_data', openTickets: 0,
        averageFirstResponseMinutes: null, sampleSize: 0,
        month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
      },
      actionItems: {
        status: 'ok', count: 2, topIssues: [], asOf: now.toISOString(),
      },
      awaitingYou: {
        status: 'ok', proposals: 1, invoices: 2, asOf: now.toISOString(),
      },
    });
    expect(tiles.securityScoreTile).toHaveBeenCalledWith('org-1', now);
    expect(tiles.devicesProtectedTile).toHaveBeenCalledWith('org-1', now);
    expect(tiles.patchesAppliedTile).toHaveBeenCalledWith('org-1', {
      timezone: 'America/Denver',
      now,
    });
    expect(tiles.backupTile).toHaveBeenCalledWith('org-1', now);
    expect(tiles.supportTile).toHaveBeenCalledWith('org-1', {
      timezone: 'America/Denver',
      now,
    });
    expect(tiles.actionItemsTile).toHaveBeenCalledWith('org-1', now);
  });
});
