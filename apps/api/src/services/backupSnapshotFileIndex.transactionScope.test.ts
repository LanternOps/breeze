import { beforeEach, describe, expect, it, vi } from 'vitest';

// Proves a structural property: the manifest
// network fetch must not run while a DB access context (a held pooled
// connection / transaction) is open. `withSystemDbAccessContext` is
// instrumented to track nesting depth instead of being a bare pass-through,
// so `fetchManifestBytes` can assert on the depth at the moment it's called.

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'leftJoin', 'innerJoin', 'for']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const {
  selectMock, insertMock, updateMock, deleteMock, transactionMock,
  resolveSnapshotProviderConfigMock, contextDepth,
} = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  deleteMock: vi.fn<(...args: unknown[]) => any>(),
  transactionMock: vi.fn<(cb: (tx: unknown) => unknown) => unknown>(),
  resolveSnapshotProviderConfigMock: vi.fn<(...args: unknown[]) => any>(),
  contextDepth: { current: 0 },
}));

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  };
  return {
    db: { ...tx, transaction: (cb: (t: typeof tx) => unknown) => transactionMock(cb as (t: unknown) => unknown) },
    // Real behavior modeled just enough to track nesting: runOutsideDbContext
    // drops the depth to 0 for the duration of fn (mirroring the AsyncLocalStorage
    // .exit() semantics), withSystemDbAccessContext increments/decrements around fn.
    // Uses Promise#finally rather than a synchronous try/finally: `fn` is an
    // async callback that suspends at its own internal `await`s, so a plain
    // synchronous finally would restore the depth before those awaits ever
    // resume, racing every other in-flight context. Chaining onto the
    // returned promise instead tracks the depth for the callback's actual
    // async lifetime.
    runOutsideDbContext: vi.fn((fn: () => any) => {
      const saved = contextDepth.current;
      contextDepth.current = 0;
      return Promise.resolve(fn()).finally(() => {
        contextDepth.current = saved;
      });
    }),
    withSystemDbAccessContext: vi.fn((fn: () => any) => {
      contextDepth.current += 1;
      return Promise.resolve(fn()).finally(() => {
        contextDepth.current -= 1;
      });
    }),
  };
});

vi.mock('./recoveryBootstrap', () => ({
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
}));

import { hydrateSnapshotFileIndex } from './backupSnapshotFileIndex';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STORAGE_IDENTITY = 'local::/srv/backups';

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_DB_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: 'snap-current',
    jobId: 'job-1', configId: 'config-1', storageIdentity: STORAGE_IDENTITY,
    fileIndexStatus: 'none', fileIndexHydratedAt: null, referencedFiles: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  contextDepth.current = 0;
  selectMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  updateMock.mockImplementation(() => chainMock([snapshotRow({ fileIndexStatus: 'hydrating' })]));
  deleteMock.mockImplementation(() => chainMock([]));
  transactionMock.mockImplementation(async (cb: any) => cb({
    select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock,
  }));
  resolveSnapshotProviderConfigMock.mockResolvedValue({
    snapshot: snapshotRow(),
    config: null,
    providerType: 'local',
    providerConfig: { path: '/srv/backups' },
  });
});

describe('hydrateSnapshotFileIndex manifest-fetch transaction scope', () => {
  it('fetches the manifest with no DB access context held', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));

    let depthDuringFetch: number | null = null;
    const deps = {
      fetchManifestBytes: vi.fn(async () => {
        depthDuringFetch = contextDepth.current;
        return Buffer.from(JSON.stringify({ id: 'snap-current', files: [] }), 'utf8');
      }),
    };

    const outcome = await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    expect(outcome.status).toBe('complete');
    expect(deps.fetchManifestBytes).toHaveBeenCalledTimes(1);
    expect(depthDuringFetch).toBe(0);
  });

  it('opens a fresh (not the claim) DB context to write, after the fetch has already returned', async () => {
    selectMock.mockReturnValueOnce(chainMock([snapshotRow()]));
    selectMock.mockReturnValueOnce(chainMock([{ referencedFiles: 5 }]));

    const contextCallOrder: string[] = [];
    const deps = {
      fetchManifestBytes: vi.fn(async () => {
        contextCallOrder.push('fetch');
        return Buffer.from(JSON.stringify({ id: 'snap-current', files: [] }), 'utf8');
      }),
    };

    updateMock.mockImplementation((...args: unknown[]) => {
      contextCallOrder.push('write');
      return chainMock([snapshotRow({ fileIndexStatus: 'hydrating' })]);
    });

    await hydrateSnapshotFileIndex(SNAPSHOT_DB_ID, { deps });

    // The CAS claim write happens before the fetch; the final status write
    // happens after — fetch must sit strictly between them.
    const fetchIndex = contextCallOrder.indexOf('fetch');
    expect(fetchIndex).toBeGreaterThan(0);
    expect(contextCallOrder.slice(fetchIndex + 1)).toContain('write');
  });
});
