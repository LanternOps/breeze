import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VendorCustomer, VendorDevice } from '../services/backupProviders/types';

// ---------------------------------------------------------------------------
// The three-phase contract (mirrors huntressSync.test.ts, #1697): vendor HTTP
// must run at context depth 0 while every read/write runs at depth > 0. We
// model the depth with a counter that withSystemDbAccessContext increments and
// runOutsideDbContext zeroes.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];
let connectionRow: Record<string, unknown>;
let reReadRow: Record<string, unknown> | undefined;

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoUpdate', 'for', 'returning']) {
    c[m] = vi.fn(() => c);
  }
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

let selectCall = 0;
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      // 1st: phase-1 load. 2nd: phase-3 FOR UPDATE re-read.
      const result = selectCall++ === 0 ? [connectionRow] : [reReadRow ?? connectionRow];
      return chain(result);
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain([{ updatedAt: connectionRow.updatedAt }]);
    }),
    insert: vi.fn(() => chain([])),
    delete: vi.fn(() => chain([])),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try { return await fn(); } finally { contextDepth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try { return fn(); } finally { contextDepth = saved; }
  }),
}));

const { FakeProviderRequestError } = vi.hoisted(() => {
  class FakeProviderRequestError extends Error {
    code: string;
    reauth: boolean;
    constructor(message: string, reauth: boolean) {
      super(message);
      this.name = 'ProviderRequestError';
      this.code = 'vendor_error';
      this.reauth = reauth;
    }
  }
  return { FakeProviderRequestError };
});

const { listCustomers, listDevices, persistVendorSnapshot, evaluateProviderAlerts } = vi.hoisted(() => ({
  listCustomers: vi.fn(async (): Promise<VendorCustomer[]> => []),
  listDevices: vi.fn(async () => ({ devices: [] as VendorDevice[], failedCustomerIds: [] as string[] })),
  persistVendorSnapshot: vi.fn(async () => ({
    customers: 2, unmappedCustomers: 1, devices: 3, unmappedDevices: 4, linked: 2, ambiguous: 1,
  })),
  evaluateProviderAlerts: vi.fn(async () => ({ raised: 0, resolved: 0 })),
}));

listCustomers.mockImplementation(async () => { fetchDepths.push(contextDepth); return []; });
listDevices.mockImplementation(async () => { fetchDepths.push(contextDepth); return { devices: [], failedCustomerIds: [] }; });

vi.mock('../services/backupProviders/types', () => ({ ProviderRequestError: FakeProviderRequestError }));
vi.mock('../services/backupProviders/registry', () => ({
  getBackupProvider: () => ({ key: 'cove', label: 'Cove Data Protection', listCustomers, listDevices }),
}));
vi.mock('../services/backupProviders/credentials', () => ({
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));
vi.mock('../services/backupProviders/persist', () => ({ persistVendorSnapshot }));
vi.mock('../services/backupProviders/alerts', () => ({ evaluateProviderAlerts }));
vi.mock('../services/backupProviders/mapping', () => ({ autoMapCustomers: vi.fn(async () => 0) }));
vi.mock('../services/backupProviders/deviceMatching', () => ({ matchProviderDevices: vi.fn(async () => ({ linked: 0, ambiguous: 0 })) }));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: vi.fn(async () => ({ id: 'job-1' })),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('../services/bullmqUtils', () => ({
  enqueueOrReplaceStale: vi.fn(async () => ({ id: 'job-1' })),
}));

import { selectDueConnections, syncConnectionById, processSyncConnection } from './backupProviderSync';
import { makeRealJob } from './__helpers__/realBullJob';

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
const BASE_ROW = {
  id: CONNECTION_ID,
  partnerId: '11111111-1111-4111-8111-111111111111',
  provider: 'cove',
  name: 'OliveTech Cove',
  baseUrl: 'https://api.backup.management/jsonapi',
  credentialsEncrypted: 'enc',
  vendorRootId: '1234',
  isActive: true,
  status: 'connected',
  syncIntervalMinutes: 30,
  showProviderNameInPortal: false,
  updatedAt: new Date('2026-09-15T10:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  contextDepth = 0;
  selectCall = 0;
  fetchDepths.length = 0;
  dbCallDepths.length = 0;
  updatePayloads.length = 0;
  connectionRow = { ...BASE_ROW };
  reReadRow = undefined;
  persistVendorSnapshot.mockResolvedValue({
    customers: 2, unmappedCustomers: 1, devices: 3, unmappedDevices: 4, linked: 2, ambiguous: 1,
  });
  evaluateProviderAlerts.mockResolvedValue({ raised: 0, resolved: 0 });
});

describe('selectDueConnections', () => {
  const NOW = new Date('2026-09-15T12:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it('includes a connection that has never synced', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: null, syncIntervalMinutes: 30 }], NOW))
      .toEqual([{ id: 'a', lastSyncAt: null, syncIntervalMinutes: 30 }]);
  });

  it('includes a connection whose interval has elapsed', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(31), syncIntervalMinutes: 30 }], NOW))
      .toHaveLength(1);
  });

  it('excludes a connection inside its interval', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(10), syncIntervalMinutes: 30 }], NOW))
      .toEqual([]);
  });

  it('respects a per-connection interval shorter than the scan cadence', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(6), syncIntervalMinutes: 5 }], NOW))
      .toHaveLength(1);
  });
});

describe('syncConnectionById — phase boundaries', () => {
  it('fetches from the vendor with NO DB context held, and reads/writes inside one', async () => {
    await syncConnectionById(CONNECTION_ID);
    expect(listCustomers).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(fetchDepths).toEqual([0, 0]);
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) expect(depth).toBeGreaterThan(0);
  });

  it('keeps the fetch outside the transaction even under an OUTER context', async () => {
    const dbm = await import('../db');
    await dbm.withSystemDbAccessContext(async () => { await syncConnectionById(CONNECTION_ID); });
    expect(fetchDepths).toEqual([0, 0]);
  });

  it('marks the connection running before fetching and successful after persisting', async () => {
    await syncConnectionById(CONNECTION_ID);
    expect(updatePayloads[0]!.payload).toMatchObject({ lastSyncStatus: 'running', lastSyncError: null });
    const success = updatePayloads.find((u) => u.payload.lastSyncStatus === 'success');
    expect(success).toBeDefined();
    expect(success!.payload).toMatchObject({
      status: 'connected',
      lastSyncCustomers: 2,
      lastSyncUnmappedCustomers: 1,
      lastSyncDevices: 3,
      lastSyncUnmappedDevices: 4,
      lastSyncLinkedDevices: 2,
      lastSyncAmbiguousDevices: 1,
    });
  });
});

describe('syncConnectionById — abort guards', () => {
  it('writes nothing when the connection was deactivated during the fetch', async () => {
    reReadRow = { ...BASE_ROW, isActive: false };
    await syncConnectionById(CONNECTION_ID);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'success')).toBe(false);
  });

  it('writes nothing when updated_at changed during the fetch (credentials PATCHed)', async () => {
    reReadRow = { ...BASE_ROW, updatedAt: new Date('2026-09-15T10:05:00Z') };
    await syncConnectionById(CONNECTION_ID);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'success')).toBe(false);
  });

  it('writes nothing and never fetches when the connection is inactive at phase 1', async () => {
    connectionRow = { ...BASE_ROW, isActive: false };
    await syncConnectionById(CONNECTION_ID);
    expect(listCustomers).not.toHaveBeenCalled();
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
  });
});

import { nudgeConnectionHealth } from '../services/connectionHealth/nudge';

describe('syncConnectionById — failure handling', () => {
  it('keeps a failed customer’s old rows and updates the other customer in a successful sync', async () => {
    const customers: VendorCustomer[] = ['revoked-customer', 'working-customer'].map((id) => ({
      vendorCustomerId: id, name: id, parentId: null, level: 'business', externalCode: null,
    }));
    const device: VendorDevice = {
      vendorDeviceId: 'working:mail', vendorCustomerId: 'working-customer', name: 'Mail',
      computerName: null, osType: 'unknown', osVersion: null, clientVersion: null,
      macAddresses: [], accountType: 'm365', dataSources: ['m365_mail'], status: 'completed',
      vendorStatusCode: null, lastSessionAt: null, lastSuccessAt: null, lastCompletedAt: null,
      selectedBytes: null, usedBytes: 100, errorsCount: 0, vendorCreatedAt: null, vendorExpiresAt: null, raw: {},
    };
    listCustomers.mockResolvedValueOnce(customers);
    listDevices.mockResolvedValueOnce({ devices: [device], failedCustomerIds: ['revoked-customer'] });
    const actualPersist = await vi.importActual<typeof import('../services/backupProviders/persist')>(
      '../services/backupProviders/persist',
    );
    const inserted: Array<Record<string, unknown>> = [];
    const selections = [
      [{ id: 'c-old', vendorCustomerId: 'revoked-customer' }, { id: 'c-good', vendorCustomerId: 'working-customer' }],
      [{ id: 'c-old', vendorCustomerId: 'revoked-customer', orgId: BASE_ROW.partnerId },
        { id: 'c-good', vendorCustomerId: 'working-customer', orgId: BASE_ROW.partnerId }],
      [{ id: 'old-row', vendorDeviceId: 'revoked:mail', customerId: 'c-old', accountType: 'gws' },
        { id: 'good-row', vendorDeviceId: 'working:mail', customerId: 'c-good' }],
    ];
    const returns = [[{ id: 'c-good', vendorCustomerId: 'working-customer' }], [{ id: 'good-row', orgId: BASE_ROW.partnerId }]];
    const tx = {
      select: vi.fn(() => chain(selections.shift() ?? [])),
      insert: vi.fn(() => {
        const builder = chain(returns.shift() ?? []);
        builder.values = vi.fn((rows: Array<Record<string, unknown>>) => { inserted.push(...rows); return builder; });
        return builder;
      }),
      update: vi.fn(() => chain([])), delete: vi.fn(() => chain([])), execute: vi.fn(async () => []),
    };
    persistVendorSnapshot.mockImplementationOnce(async (...args: unknown[]) => actualPersist.persistVendorSnapshot(
      tx as never, args[1] as Parameters<typeof actualPersist.persistVendorSnapshot>[1],
      args[2] as Parameters<typeof actualPersist.persistVendorSnapshot>[2],
    ));
    await syncConnectionById(CONNECTION_ID);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(inserted.filter((row) => 'vendorDeviceId' in row))
      .toMatchObject([{ vendorDeviceId: 'working:mail', customerId: 'c-good', usedBytes: 100 }]);
    expect(updatePayloads.find((u) => u.payload.lastSyncStatus === 'success')?.payload)
      .toMatchObject({ status: 'connected', lastSyncDevices: 0, lastSyncUnmappedDevices: 0, lastSyncLinkedDevices: 0, lastSyncAmbiguousDevices: 0, lastSyncError: '1 customer(s) skipped: access denied or unavailable' });
  });

  it('does not persist anything when the vendor enumeration fails, and records the error', async () => {
    const boom = new Error('cove page 3 of 7 failed');
    listDevices.mockRejectedValueOnce(boom);
    await expect(syncConnectionById(CONNECTION_ID)).rejects.toBe(boom);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.depth).toBeGreaterThan(0);
  });

  it('leaves the row running on a NON-final retry attempt', async () => {
    listDevices.mockRejectedValueOnce(new Error('transient'));
    await expect(syncConnectionById(CONNECTION_ID, { isFinalAttempt: false })).rejects.toThrow('transient');
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'running')).toBe(true);
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'error')).toBe(false);
  });

  it('nudges connection health only when a terminal failure is recorded (W4)', async () => {
    listDevices.mockRejectedValueOnce(new Error('transient'));
    await expect(syncConnectionById(CONNECTION_ID, { isFinalAttempt: false })).rejects.toThrow('transient');
    expect(nudgeConnectionHealth).not.toHaveBeenCalled();

    listDevices.mockRejectedValueOnce(new Error('exhausted'));
    await expect(syncConnectionById(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow('exhausted');
    expect(nudgeConnectionHealth).toHaveBeenCalledTimes(1);
    expect(nudgeConnectionHealth).toHaveBeenCalledWith('backup_provider');
  });

  it('nudges connection health on a mid-retry reauth failure (W4)', async () => {
    listCustomers.mockRejectedValueOnce(new FakeProviderRequestError('credentials rejected', true));
    await syncConnectionById(CONNECTION_ID, { isFinalAttempt: false }).then(() => null, (e: unknown) => e);
    expect(nudgeConnectionHealth).toHaveBeenCalledWith('backup_provider');
  });

  it('on a reauth failure sets status reauth_required and throws UnrecoverableError even mid-retry', async () => {
    const { UnrecoverableError } = await import('bullmq');
    listCustomers.mockRejectedValueOnce(new FakeProviderRequestError('credentials rejected', true));
    const rejected = await syncConnectionById(CONNECTION_ID, { isFinalAttempt: false })
      .then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(UnrecoverableError);
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite!.payload).toMatchObject({ status: 'reauth_required' });
  });

  it('fails unrecoverably when the connection has no vendor root id', async () => {
    const { UnrecoverableError } = await import('bullmq');
    connectionRow = { ...BASE_ROW, vendorRootId: null };
    const rejected = await syncConnectionById(CONNECTION_ID).then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(UnrecoverableError);
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it('marks the sync PARTIAL (never failed) when alert evaluation throws after the commit', async () => {
    evaluateProviderAlerts.mockRejectedValueOnce(new Error('alert bus down'));
    await expect(syncConnectionById(CONNECTION_ID)).resolves.toBeUndefined();
    expect(persistVendorSnapshot).toHaveBeenCalledTimes(1);
    const partial = updatePayloads.find((u) => u.payload.lastSyncStatus === 'partial');
    expect(partial).toBeDefined();
    expect(String(partial!.payload.lastSyncError)).toContain('alert bus down');
  });

  it('evaluates alerts only AFTER the inventory transaction has committed', async () => {
    const order: string[] = [];
    persistVendorSnapshot.mockImplementationOnce(async () => {
      order.push(`persist@${contextDepth}`);
      return { customers: 0, unmappedCustomers: 0, devices: 0, unmappedDevices: 0, linked: 0, ambiguous: 0 };
    });
    evaluateProviderAlerts.mockImplementationOnce(async () => {
      order.push(`alerts@${contextDepth}`);
      return { raised: 0, resolved: 0 };
    });
    await syncConnectionById(CONNECTION_ID);
    expect(order[0]).toMatch(/^persist@[1-9]/);
    expect(order[1]).toBe('alerts@0');
  });
});

describe('processSyncConnection — final-attempt detection with a real BullMQ Job (#8351)', () => {
  const data = { type: 'sync-connection' as const, connectionId: CONNECTION_ID };

  it('leaves the row running on the first of three attempts (attemptsMade 0)', async () => {
    listDevices.mockRejectedValueOnce(new Error('transient'));
    await expect(processSyncConnection(data, makeRealJob(data, { attemptsMade: 0, attempts: 3 })))
      .rejects.toThrow('transient');
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'error')).toBe(false);
  });

  it('records the terminal error on the third of three attempts (attemptsMade 2)', async () => {
    listDevices.mockRejectedValueOnce(new Error('exhausted'));
    await expect(processSyncConnection(data, makeRealJob(data, { attemptsMade: 2, attempts: 3 })))
      .rejects.toThrow('exhausted');
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'error')).toBe(true);
  });
});
