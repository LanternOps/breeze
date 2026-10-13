import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ selects: [] as string[][], rows: {} as Record<string, unknown[]> }));
vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => {
      const keys = Object.keys(columns);
      mocks.selects.push(keys);
      const kind = keys.includes('total') ? 'total' : keys.includes('title') ? 'patch' : 'device';
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(mocks.rows[kind] ?? []).then(resolve, reject);
      return chain;
    },
  },
}));

import { patchDetailDevicePage, patchDetailSummary } from './patchDetailReadModel';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-10T04:00:00Z');
const EXCLUDED = ['lastError', 'failureCount', 'rollbackAvailable', 'scope', 'reportedSeverity', 'reportedCategory', 'description', 'downloadUrl', 'installCommand', 'cveIds', 'metadata'];

beforeEach(() => {
  mocks.selects = [];
  mocks.rows = {};
});

describe('patch detail closed projections', () => {
  it('returns null for a device outside the organization', async () => {
    expect(await patchDetailDevicePage(ORG, DEVICE, { page: 1, limit: 50, now: NOW })).toBeNull();
    expect(mocks.selects).toEqual([['id']]);
  });

  it('emits only the allowlisted device fields and never selects excluded columns', async () => {
    mocks.rows.device = [{ id: DEVICE }];
    mocks.rows.total = [{ total: 3 }];
    mocks.rows.patch = [{
      title: 'KB5001', severity: 'critical', version: '1.2', kbArticleUrl: 'https://example.test/kb',
      status: 'pending', installedAt: null, installedVersion: null, availableVersion: '1.3', lastCheckedAt: NOW,
      lastError: 'SECRET', failureCount: 9, rollbackAvailable: true, scope: 'user',
    }];
    const result = (await patchDetailDevicePage(ORG, DEVICE, { page: 2, limit: 1, now: NOW }))!;
    expect(result.data[0]).toEqual({
      title: 'KB5001', severity: 'critical', version: '1.2', kbArticleUrl: 'https://example.test/kb',
      status: 'pending', installedAt: null, installedVersion: null, availableVersion: '1.3',
      lastCheckedAt: NOW.toISOString(),
    });
    expect(result.pagination).toEqual({ page: 2, limit: 1, total: 3 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const key of EXCLUDED) expect(mocks.selects.flat()).not.toContain(key);
  });

  it('serialises installedAt and nulls missing optional values', async () => {
    mocks.rows.device = [{ id: DEVICE }];
    mocks.rows.total = [{ total: 1 }];
    mocks.rows.patch = [{
      title: 'P', severity: null, version: null, kbArticleUrl: null, status: 'installed',
      installedAt: NOW, installedVersion: '2', availableVersion: null, lastCheckedAt: null,
    }];
    const row = (await patchDetailDevicePage(ORG, DEVICE, { page: 1, limit: 50, now: NOW }))!.data[0]!;
    expect(row.installedAt).toBe(NOW.toISOString());
    expect(row.severity).toBe('unknown');
    expect(row.lastCheckedAt).toBeNull();
  });

  it('aggregates the organization summary with a closed field list', async () => {
    mocks.rows.total = [{ total: 1 }];
    mocks.rows.patch = [{
      title: 'KB5001', severity: 'important', version: null, kbArticleUrl: null,
      pendingDevices: 2, failedDevices: 1, installedDevices: 5, lastCheckedAt: NOW, lastError: 'SECRET',
    }];
    const result = await patchDetailSummary(ORG, { page: 1, limit: 50, now: NOW });
    expect(Object.keys(result.data[0]!).sort()).toEqual([
      'failedDevices', 'installedDevices', 'kbArticleUrl', 'lastCheckedAt', 'pendingDevices', 'severity', 'title', 'version',
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const key of EXCLUDED) expect(mocks.selects.flat()).not.toContain(key);
  });

  it('keeps whole-population status for an empty page', async () => {
    mocks.rows.total = [{ total: 4 }];
    expect((await patchDetailSummary(ORG, { page: 99, limit: 50, now: NOW })).dataStatus).toBe('ok');
  });

  it('reports no_data when there are no rows', async () => {
    mocks.rows.device = [{ id: DEVICE }];
    const result = (await patchDetailDevicePage(ORG, DEVICE, { page: 1, limit: 50, now: NOW }))!;
    expect(result.dataStatus).toBe('no_data');
    expect(result.data).toEqual([]);
  });
});
