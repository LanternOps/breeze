import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ selects: [] as string[][], rows: {} as Record<string, unknown[]> }));
vi.mock('../../db', () => ({ db: { select: (columns: Record<string, unknown>) => {
  const keys = Object.keys(columns); mocks.selects.push(keys);
  const kind = keys.includes('total') ? 'total' : keys.includes('name') ? 'software' : 'device';
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(mocks.rows[kind] ?? []).then(resolve, reject);
  return chain;
} } }));
import { softwareInventoryDevicePage, softwareInventorySummary } from './softwareInventoryReadModel';
const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-10T04:00:00Z');
beforeEach(() => { mocks.selects = []; mocks.rows = {}; });
describe('software inventory closed projections', () => {
  it('returns null for another organization device', async () => {
    expect(await softwareInventoryDevicePage(ORG, DEVICE, { page: 1, limit: 50, now: NOW })).toBeNull();
    expect(mocks.selects).toEqual([['id']]);
  });
  it('emits only the five allowed device fields and never selects excluded columns', async () => {
    mocks.rows.device = [{ id: DEVICE }]; mocks.rows.total = [{ total: 3 }];
    mocks.rows.software = [{ name: 'Example', version: '1', vendor: 'Vendor', installDate: '2026-10-01', lastSeen: NOW, installLocation: 'SECRET', fileHash: 'SECRET', uninstallString: 'SECRET' }];
    const result = (await softwareInventoryDevicePage(ORG, DEVICE, { page: 2, limit: 1, now: NOW }))!;
    expect(result.data[0]).toEqual({ name: 'Example', version: '1', vendor: 'Vendor', installDate: '2026-10-01', lastSeen: NOW.toISOString() });
    expect(result.pagination).toEqual({ page: 2, limit: 1, total: 3 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const key of ['installLocation', 'uninstallString', 'fileHash', 'hashAlgorithm', 'observationId', 'isManaged', 'catalogId']) expect(mocks.selects.flat()).not.toContain(key);
  });
  it('aggregates organization software with a closed field list', async () => {
    mocks.rows.total = [{ total: 1 }];
    mocks.rows.software = [{ name: 'Example', version: null, vendor: null, installDate: null, lastSeen: null }];
    const result = await softwareInventorySummary(ORG, { page: 1, limit: 50, now: NOW });
    expect(Object.keys(result.data[0]!).sort()).toEqual(['installDate', 'lastSeen', 'name', 'vendor', 'version']);

  });
  it('keeps whole-population status for an empty page', async () => {
    mocks.rows.total = [{ total: 4 }];
    expect((await softwareInventorySummary(ORG, { page: 99, limit: 50, now: NOW })).dataStatus).toBe('ok');
  });
  it('reports no_data for empty inventory', async () => {
    mocks.rows.device = [{ id: DEVICE }];
    const result = (await softwareInventoryDevicePage(ORG, DEVICE, { page: 1, limit: 50, now: NOW }))!;
    expect(result.dataStatus).toBe('no_data'); expect(result.data).toEqual([]);
  });
});
