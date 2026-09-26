import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));
vi.mock('../db/schema', () => ({
  backupConfigs: { id: 'bc.id', orgId: 'bc.org_id', provider: 'bc.provider' },
  backupSnapshots: { orgId: 'bs.org_id', deviceId: 'bs.device_id', configId: 'bs.config_id', size: 'bs.size' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions: conditions.filter(Boolean) }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  sql: () => ({ op: 'sql' }),
}));

import { buildStorageProviders, getStorageByProvider } from './backupStorageByProvider';

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;
function chainMock(result: unknown): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'leftJoin', 'groupBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return chain;
}

describe('buildStorageProviders (#2562 item 5)', () => {
  it('returns a row for a configured destination that has no usage yet', () => {
    // The bug: the Overview panel read "No storage providers configured yet"
    // for an org with a real destination, because nothing sent provider rows.
    expect(buildStorageProviders([{ provider: 'backblaze', configs: 1 }], [])).toEqual([
      { id: 'backblaze', name: 'Backblaze B2', usedBytes: 0, snapshots: 0, configs: 1 },
    ]);
  });

  it('merges usage into the configured provider rows, largest first', () => {
    const rows = buildStorageProviders(
      [
        { provider: 's3', configs: 2 },
        { provider: 'backblaze', configs: 1 },
      ],
      [
        { provider: 's3', bytes: 100, snapshots: 1 },
        { provider: 'backblaze', bytes: '5000', snapshots: 3 },
      ],
    );
    expect(rows).toEqual([
      { id: 'backblaze', name: 'Backblaze B2', usedBytes: 5000, snapshots: 3, configs: 1 },
      { id: 's3', name: 'S3', usedBytes: 100, snapshots: 1, configs: 2 },
    ]);
  });

  it('keeps usage whose config was deleted so the panel sums to Storage Used', () => {
    const rows = buildStorageProviders([], [{ provider: null, bytes: 42, snapshots: 1 }]);
    expect(rows).toEqual([{ id: 'unknown', name: 'Unknown', usedBytes: 42, snapshots: 1, configs: 0 }]);
  });

  it('returns no rows when the org has no destinations and no usage', () => {
    expect(buildStorageProviders([], [])).toEqual([]);
  });
});

describe('getStorageByProvider query scoping', () => {
  const ORG = 'org-1';
  let configsChain: Chain;
  let usageChain: Chain;

  beforeEach(() => {
    selectMock.mockReset();
    configsChain = chainMock([{ provider: 'backblaze', configs: 1 }]);
    usageChain = chainMock([{ provider: 'backblaze', bytes: '10', snapshots: 1 }]);
    selectMock.mockReturnValueOnce(configsChain).mockReturnValueOnce(usageChain);
  });

  it('filters both queries by org and leaves an unrestricted caller unscoped by device', async () => {
    const rows = await getStorageByProvider(ORG, null);

    expect(rows).toEqual([{ id: 'backblaze', name: 'Backblaze B2', usedBytes: 10, snapshots: 1, configs: 1 }]);
    expect(configsChain.where).toHaveBeenCalledWith({ op: 'eq', column: 'bc.org_id', value: ORG });
    expect(usageChain.leftJoin).toHaveBeenCalledWith(expect.objectContaining({ id: 'bc.id' }), { op: 'eq', column: 'bs.config_id', value: 'bc.id' });
    expect(usageChain.where).toHaveBeenCalledWith({
      op: 'and',
      conditions: [{ op: 'eq', column: 'bs.org_id', value: ORG }],
    });
    expect(configsChain.groupBy).toHaveBeenCalledWith('bc.provider');
    expect(usageChain.groupBy).toHaveBeenCalledWith('bc.provider');
  });

  it('narrows snapshot usage to the site-scoped device list', async () => {
    await getStorageByProvider(ORG, ['dev-a']);

    expect(usageChain.where).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', column: 'bs.org_id', value: ORG },
        { op: 'inArray', column: 'bs.device_id', values: ['dev-a'] },
      ],
    });
  });

  it('skips the snapshot query for a caller who can see no devices but keeps destinations', async () => {
    const rows = await getStorageByProvider(ORG, []);

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ id: 'backblaze', name: 'Backblaze B2', usedBytes: 0, snapshots: 0, configs: 1 }]);
  });
});
