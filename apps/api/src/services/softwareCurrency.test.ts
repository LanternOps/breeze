import { beforeEach, describe, it, expect, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve(selectResults.shift() ?? [])),
  };

  return {
    selectResults,
    chain,
    select: vi.fn(() => chain),
  };
});

vi.mock('../db', () => ({
  db: {
    select: dbMocks.select,
  },
}));

import {
  compareVersions,
  isDeviceSoftwareCurrent,
  resolveLatestVersionsByCatalogId,
} from './softwareCurrency';

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.select.mockClear();
  dbMocks.chain.from.mockClear();
  dbMocks.chain.innerJoin.mockClear();
  dbMocks.chain.where.mockClear();
});

describe('compareVersions', () => {
  it('orders dotted-numeric versions', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('126.0.1', '126.0.0')).toBe(1);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.3', '1.2.9')).toBe(1);
  });

  it('returns null when a version is unparseable', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', '')).toBeNull();
  });
});

describe('resolveLatestVersionsByCatalogId', () => {
  it('returns latest version info keyed by catalog id', async () => {
    dbMocks.selectResults.push([
      {
        version: {
          id: 'ver-1',
          catalogId: 'cat-1',
          version: '126.0.0',
          isLatest: true,
        },
        catalogName: 'Chrome',
      },
    ]);

    const result = await resolveLatestVersionsByCatalogId(['cat-1']);

    expect(result.get('cat-1')).toEqual({
      version: {
        id: 'ver-1',
        catalogId: 'cat-1',
        version: '126.0.0',
        isLatest: true,
      },
      catalogName: 'Chrome',
    });
    expect(dbMocks.chain.innerJoin).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map without querying when no catalog ids are supplied', async () => {
    const result = await resolveLatestVersionsByCatalogId([]);

    expect(result.size).toBe(0);
    expect(dbMocks.select).not.toHaveBeenCalled();
  });
});

describe('isDeviceSoftwareCurrent', () => {
  it('is true when an installed version is >= latest', async () => {
    dbMocks.selectResults.push([{ version: '126.0.1' }]);

    expect(await isDeviceSoftwareCurrent('dev-1', 'cat-1', '126.0.0')).toBe(true);
  });

  it('is false when installed is older than latest', async () => {
    dbMocks.selectResults.push([{ version: '126.0.1' }]);

    expect(await isDeviceSoftwareCurrent('dev-1', 'cat-1', '127.0.0')).toBe(false);
  });

  it('is false when no inventory row exists (deploy is the safe default)', async () => {
    dbMocks.selectResults.push([]);

    expect(await isDeviceSoftwareCurrent('dev-2', 'cat-1', '1.0.0')).toBe(false);
  });

  it('is false when the installed version is unparseable', async () => {
    dbMocks.selectResults.push([{ version: 'latest' }]);

    expect(await isDeviceSoftwareCurrent('dev-3', 'cat-1', '1.0.0')).toBe(false);
  });
});
