import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';

// Three-phase contract (mirrors backupProviderSync.test.ts): vendor HTTP at
// context depth 0, every read/write at depth > 0.

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
const events: string[] = [];
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];
let connectionRow: Record<string, unknown>;
let reReadRow: Record<string, unknown> | undefined;
let tenantRows: Array<Record<string, unknown>>;

import { edrConnections, edrTenants } from '../db/schema';

function chain(resultFor: () => unknown) {
  const state: { table: unknown } = { table: null };
  const c: Record<string, unknown> = {};
  for (const m of ['where', 'limit', 'values', 'onConflictDoUpdate', 'returning']) c[m] = vi.fn(() => c);
  c.from = vi.fn((t: unknown) => { state.table = t; return c; });
  c.for = vi.fn(() => { events.push('for-update'); state.table = 'forUpdate'; return c; });
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    let result: unknown;
    if (state.table === 'forUpdate') result = [reReadRow ?? connectionRow];
    else if (state.table === edrConnections) result = [connectionRow];
    else if (state.table === edrTenants) result = [{ n: 0 }];
    else result = resultFor();
    return Promise.resolve(result).then(res, rej);
  };
  return c;
}

// First edr_tenants select (phase 1) returns the tenant list; later ones the open-detection sum.
let tenantSelects = 0;
vi.mock('../db', () => ({
  db: {
    select: vi.fn((..._a: unknown[]) => {
      dbCallDepths.push(contextDepth);
      const c = chain(() => []);
      const origFrom = c.from as (t: unknown) => unknown;
      c.from = vi.fn((t: unknown) => {
        origFrom(t);
        if (t === edrConnections) tenantSelects = 0; // each run's phase-1 connection load restarts the sequence
        if (t === edrTenants) {
          tenantSelects += 1;
          if (tenantSelects === 1) {
            (c as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(tenantRows).then(res);
          }
        }
        return c;
      });
      return c;
    }),
    update: vi.fn(() => { dbCallDepths.push(contextDepth); return chain(() => []); }),
    insert: vi.fn(() => chain(() => [])),
    delete: vi.fn(() => chain(() => [])),
    execute: vi.fn(() => { events.push('execute'); return Promise.resolve([]); }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    events.push('tx-begin');
    try { return await fn(); } finally { contextDepth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try { return fn(); } finally { contextDepth = saved; }
  }),
}));

const { FakeEdrError } = vi.hoisted(() => {
  class FakeEdrError extends Error {
    code: string; reauth: boolean; scope: string; retryAfterMs?: number;
    constructor(message: string, o: { code: string; reauth: boolean; scope: string }) {
      super(message);
      this.name = 'EdrProviderRequestError';
      this.code = o.code; this.reauth = o.reauth; this.scope = o.scope;
    }
  }
  return { FakeEdrError };
});

const m = vi.hoisted(() => ({
  listTenants: vi.fn(),
  listEndpoints: vi.fn(),
  countEndpoints: vi.fn(),
  enrichEndpoints: vi.fn(),
  listDetections: vi.fn(),
  upsertTenants: vi.fn(),
  autoMapEdrTenants: vi.fn(),
  persistInventory: vi.fn(),
  persistDetections: vi.fn(),
  pruneMissingTenantEndpoints: vi.fn(),
  matchEdrEndpoints: vi.fn(),
  refreshDetectionDeviceLinks: vi.fn(),
  isDeadlockError: vi.fn(),
  buildEdrAdapterContext: vi.fn(),
  enqueueOrReplaceStale: vi.fn(),
}));

vi.mock('../services/edrProviders/types', () => ({ EdrProviderRequestError: FakeEdrError }));
vi.mock('../services/edrProviders/registry', () => ({
  getEdrProvider: () => ({
    key: 'bitdefender',
    hostAllowlist: ['.gravityzone.bitdefender.com'],
    capabilities: {
      tenantModel: 'partner', detectionDelivery: 'poll', installer: 'none', actions: [],
      requestBudget: { perSecond: 10 }, tenantFetchConcurrency: 2,
      defaultIntervals: { detectionsMinutes: 5, inventoryMinutes: 60 },
    },
    listTenants: m.listTenants,
    listEndpoints: m.listEndpoints,
    countEndpoints: m.countEndpoints,
    enrichEndpoints: m.enrichEndpoints,
    listDetections: m.listDetections,
  }),
}));
vi.mock('../services/edrProviders/credentials', () => ({ decryptEdrSecret: vi.fn(() => ({ apiKey: 'k' })) }));
vi.mock('../services/edrProviders/context', () => ({ buildEdrAdapterContext: m.buildEdrAdapterContext }));
vi.mock('../services/edrProviders/persist', () => ({
  upsertTenants: m.upsertTenants,
  persistInventory: m.persistInventory,
  persistDetections: m.persistDetections,
  pruneMissingTenantEndpoints: m.pruneMissingTenantEndpoints,
  refreshDetectionDeviceLinks: m.refreshDetectionDeviceLinks,
  isDeadlockError: m.isDeadlockError,
}));
vi.mock('../services/edrProviders/mapping', () => ({ autoMapEdrTenants: m.autoMapEdrTenants }));
vi.mock('../services/edrProviders/deviceMatching', () => ({ matchEdrEndpoints: m.matchEdrEndpoints }));
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
vi.mock('../services/bullmqUtils', () => ({ enqueueOrReplaceStale: m.enqueueOrReplaceStale }));

import {
  edrSyncJobId, enqueueEdrSync, selectDueStreams, syncEdrDetections, syncEdrInventory,
} from './edrProviderSync';

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000e1';
const BASE_ROW = {
  id: CONNECTION_ID,
  partnerId: '11111111-1111-4111-8111-111111111111',
  provider: 'bitdefender',
  baseUrl: null,
  region: null,
  credentialsEncrypted: 'enc',
  vendorRootId: 'root-1',
  vendorRootType: 'partner',
  isActive: true,
  status: 'connected',
  detectionIntervalMinutes: null,
  inventoryIntervalMinutes: null,
};
const MAPPED = { id: 't-mapped', vendorTenantId: 'v-mapped', orgId: 'org-1', apiHost: null, detectionCursor: 'c0' };
const MAPPED2 = { id: 't-mapped2', vendorTenantId: 'v-mapped2', orgId: 'org-2', apiHost: null, detectionCursor: null };
const UNMAPPED = { id: 't-un', vendorTenantId: 'v-un', orgId: null, apiHost: null, detectionCursor: null };
const vt = (id: string) => ({ vendorTenantId: id, name: id, parentId: null, tenantType: null, externalCode: null, apiHost: null });
const lastConnectionUpdate = () =>
  [...updatePayloads].reverse().find((u) => 'lastSyncTenants' in u.payload || 'lastDetectionSyncAt' in u.payload);

const RUN_CACHE = new Map<string, Promise<unknown>>();

beforeEach(() => {
  vi.clearAllMocks();
  contextDepth = 0; tenantSelects = 0;
  fetchDepths.length = 0; dbCallDepths.length = 0; updatePayloads.length = 0; events.length = 0;
  connectionRow = { ...BASE_ROW };
  reReadRow = undefined;
  tenantRows = [MAPPED, UNMAPPED];
  m.buildEdrAdapterContext.mockReturnValue({ runCache: RUN_CACHE });
  m.listTenants.mockImplementation(async () => { fetchDepths.push(contextDepth); return [vt('v-mapped'), vt('v-un')]; });
  m.listEndpoints.mockImplementation(async () => { fetchDepths.push(contextDepth); return [{ vendorEndpointId: 'e1' }]; });
  m.countEndpoints.mockResolvedValue(7);
  m.enrichEndpoints.mockResolvedValue([]);
  m.listDetections.mockImplementation(async () => { fetchDepths.push(contextDepth); return { detections: [], cursor: 'c1', warnings: [] }; });
  m.upsertTenants.mockResolvedValue({ total: 2, unmapped: 1, newlyMissing: 0 });
  m.autoMapEdrTenants.mockResolvedValue({ mapped: 0, suggestions: [] });
  m.persistInventory.mockResolvedValue({ endpoints: 1, failedTenants: 0 });
  m.persistDetections.mockResolvedValue({ upserted: 0, failedTenants: 0, skipped: 0 });
  m.pruneMissingTenantEndpoints.mockResolvedValue(0);
  m.matchEdrEndpoints.mockResolvedValue({ linked: 1, ambiguous: 0 });
  m.refreshDetectionDeviceLinks.mockResolvedValue(undefined);
  m.isDeadlockError.mockImplementation((e: unknown) => (e as { code?: string })?.code === '40P01');
  m.enqueueOrReplaceStale.mockResolvedValue({ id: 'job-1' });
});

describe('selectDueStreams', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const row = (o: Partial<Parameters<typeof selectDueStreams>[0][number]>) => ({
    connectionId: 'a', lastInventorySyncAt: null, lastDetectionSyncAt: null,
    inventoryIntervalMinutes: 60, detectionIntervalMinutes: 5, ...o,
  });

  it('never-synced streams are due', () => {
    expect(selectDueStreams([row({})], NOW)).toEqual([
      { connectionId: 'a', stream: 'inventory' },
      { connectionId: 'a', stream: 'detections' },
    ]);
  });

  it('each stream uses its own interval', () => {
    const out = selectDueStreams([row({ lastInventorySyncAt: ago(30), lastDetectionSyncAt: ago(6) })], NOW);
    expect(out).toEqual([{ connectionId: 'a', stream: 'detections' }]);
    expect(selectDueStreams([row({ lastInventorySyncAt: ago(61), lastDetectionSyncAt: ago(2) })], NOW))
      .toEqual([{ connectionId: 'a', stream: 'inventory' }]);
  });
});

describe('enqueueEdrSync', () => {
  it('uses a separate job id per stream', async () => {
    expect(edrSyncJobId('inventory', 'x')).toBe('edr-inventory-x');
    expect(edrSyncJobId('detections', 'x')).toBe('edr-detections-x');
    await enqueueEdrSync('x', 'detections');
    expect(m.enqueueOrReplaceStale).toHaveBeenCalledWith(
      expect.anything(), 'sync-detections', 'edr-detections-x',
      { type: 'sync-detections', connectionId: 'x' }, expect.anything(), expect.any(String),
    );
  });
});

describe('syncEdrInventory', () => {
  it('vendor calls run outside any db context and no db call happens between phase 1 and phase 3', async () => {
    await syncEdrInventory(CONNECTION_ID);
    expect(fetchDepths.length).toBeGreaterThan(0);
    expect(fetchDepths.every((d) => d === 0)).toBe(true);
    // 2 txs total: load (tx-begin) then persist (tx-begin); the vendor fetch sits between with no db event.
    const begins = events.map((e, i) => (e === 'tx-begin' ? i : -1)).filter((i) => i >= 0);
    expect(begins).toHaveLength(2);
    expect(events.slice(begins[0]! + 1, begins[1]!).every((e) => e === 'execute')).toBe(true);
    expect(m.upsertTenants).toHaveBeenCalled();
    const upd = lastConnectionUpdate();
    expect(upd?.payload).toMatchObject({
      lastInventorySyncStatus: 'success', status: 'connected', lastSyncTenants: 2,
      lastSyncUnmappedTenants: 1, lastSyncEndpoints: 1, lastSyncLinkedEndpoints: 1,
      effectiveInventoryIntervalMinutes: 60, effectiveDetectionIntervalMinutes: 5,
    });
  });

  it('a tenant failing with scope tenant does not fail the job; others persist; connection stays connected (Review Focus 3)', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    m.listEndpoints.mockImplementation(async (_c: unknown, t: { vendorTenantId: string }) => {
      if (t.vendorTenantId === 'v-mapped') throw new FakeEdrError('permission denied for company', { code: 'permission', reauth: false, scope: 'tenant' });
      return [{ vendorEndpointId: 'e2' }];
    });
    m.persistInventory.mockResolvedValue({ endpoints: 1, failedTenants: 1 });
    await expect(syncEdrInventory(CONNECTION_ID)).resolves.toBeUndefined();
    const results = m.persistInventory.mock.calls[0]![2] as Array<{ vendorTenantId: string; ok: boolean }>;
    expect(results.find((r) => r.vendorTenantId === 'v-mapped')).toMatchObject({ ok: false });
    expect(results.find((r) => r.vendorTenantId === 'v-mapped2')).toMatchObject({ ok: true });
    const upd = lastConnectionUpdate()!.payload;
    expect(upd).toMatchObject({ status: 'connected', lastInventorySyncStatus: 'partial', lastSyncFailedTenants: 1 });
    expect(updatePayloads.some((u) => u.payload.status === 'reauth_required')).toBe(false);
  });

  it('a connection-scope reauth error marks reauth_required and throws UnrecoverableError on the FIRST attempt', async () => {
    m.listTenants.mockRejectedValue(new FakeEdrError('bad key', { code: 'unauthorized', reauth: true, scope: 'connection' }));
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: false })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(updatePayloads.some((u) => u.payload.status === 'reauth_required' && u.payload.lastInventorySyncStatus === 'error')).toBe(true);
    expect(m.upsertTenants).not.toHaveBeenCalled();
  });

  it.each(['rate_budget_exhausted', 'rate_limited'])('%s is retried by BullMQ and never marks reauth_required', async (code) => {
    const err = new FakeEdrError('slow down', { code, reauth: false, scope: 'connection' });
    m.listTenants.mockRejectedValue(err);
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: false })).rejects.toBe(err);
    expect(updatePayloads.some((u) => u.payload.status === 'reauth_required')).toBe(false);
    expect(updatePayloads.some((u) => u.payload.lastInventorySyncStatus === 'error')).toBe(false);
    expect(m.persistInventory).not.toHaveBeenCalled();
  });

  it('fence moved during phase 2 (credentials PATCHed) -> nothing written, no throw', async () => {
    reReadRow = { ...BASE_ROW, credentialsEncrypted: 'enc-rotated' };
    await expect(syncEdrInventory(CONNECTION_ID)).resolves.toBeUndefined();
    expect(m.upsertTenants).not.toHaveBeenCalled();
    expect(m.persistInventory).not.toHaveBeenCalled();
    expect(lastConnectionUpdate()).toBeUndefined();
  });

  it('unmapped tenants are counted via countEndpoints and never have endpoints fetched', async () => {
    await syncEdrInventory(CONNECTION_ID);
    expect(m.countEndpoints).toHaveBeenCalledTimes(1);
    expect(m.listEndpoints).toHaveBeenCalledTimes(1);
    expect(m.listEndpoints.mock.calls[0]![1]).toMatchObject({ vendorTenantId: 'v-mapped' });
    const results = m.persistInventory.mock.calls[0]![2] as Array<{ vendorTenantId: string; value: { endpoints: unknown[]; count?: number } }>;
    expect(results.find((r) => r.vendorTenantId === 'v-un')!.value).toMatchObject({ endpoints: [], count: 7 });
  });

  it('an earlier attempt failure leaves status running; the final attempt records error', async () => {
    m.listTenants.mockRejectedValue(new Error('vendor 503'));
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: false })).rejects.toThrow('vendor 503');
    expect(updatePayloads.some((u) => u.payload.lastInventorySyncStatus === 'error')).toBe(false);
    expect(updatePayloads.some((u) => u.payload.lastInventorySyncStatus === 'running')).toBe(true);

    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow('vendor 503');
    const rec = updatePayloads.find((u) => u.payload.lastInventorySyncStatus === 'error')!;
    expect(rec.depth).toBeGreaterThan(0);
    expect(rec.payload.status).toBeUndefined();
  });

  it('retries phase 3 on a 40P01 deadlock, re-reading the fence each time', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    m.persistInventory.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(deadlock);
    await expect(syncEdrInventory(CONNECTION_ID)).resolves.toBeUndefined();
    expect(m.persistInventory).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e === 'for-update')).toHaveLength(3);
    expect(m.listTenants).toHaveBeenCalledTimes(1);
    expect(lastConnectionUpdate()!.payload).toMatchObject({ lastInventorySyncStatus: 'success' });
  });

  it('gives up after 3 deadlock retries and rethrows; non-deadlock errors are not retried', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    m.persistInventory.mockRejectedValue(deadlock);
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: false })).rejects.toBe(deadlock);
    expect(m.persistInventory).toHaveBeenCalledTimes(4);

    m.persistInventory.mockReset();
    const other = new Error('boom');
    m.persistInventory.mockRejectedValue(other);
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: false })).rejects.toBe(other);
    expect(m.persistInventory).toHaveBeenCalledTimes(1);
  });
});

describe('syncEdrDetections', () => {
  it('only mapped tenants are fetched, with their cursor; unmapped never are', async () => {
    await syncEdrDetections(CONNECTION_ID);
    expect(m.listDetections).toHaveBeenCalledTimes(1);
    expect(m.listDetections.mock.calls[0]![1]).toMatchObject({ vendorTenantId: 'v-mapped' });
    expect(m.listDetections.mock.calls[0]![2]).toBe('c0');
    expect(fetchDepths.every((d) => d === 0)).toBe(true);
    expect(m.persistDetections).toHaveBeenCalled();
    expect(lastConnectionUpdate()!.payload).toMatchObject({ lastDetectionSyncStatus: 'success' });
  });

  it('passes the SAME runCache Map to listDetections for every tenant in a run', async () => {
    tenantRows = [MAPPED, MAPPED2];
    await syncEdrDetections(CONNECTION_ID);
    expect(m.buildEdrAdapterContext).toHaveBeenCalledTimes(1);
    expect(m.listDetections).toHaveBeenCalledTimes(2);
    const caches = m.listDetections.mock.calls.map((c) => (c[0] as { runCache: unknown }).runCache);
    expect(caches[0]).toBe(RUN_CACHE);
    expect(caches[1]).toBe(caches[0]);
  });

  it('a tenant-scope failure does not fail the run; rate_limited at connection scope does and advances nothing', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listDetections.mockImplementation(async (_c: unknown, t: { vendorTenantId: string }) => {
      if (t.vendorTenantId === 'v-mapped') throw new FakeEdrError('denied', { code: 'permission', reauth: false, scope: 'tenant' });
      return { detections: [], cursor: 'c1', warnings: [] };
    });
    await expect(syncEdrDetections(CONNECTION_ID)).resolves.toBeUndefined();
    const results = m.persistDetections.mock.calls[0]![2] as Array<{ ok: boolean }>;
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);

    m.persistDetections.mockClear();
    const limited = new FakeEdrError('429', { code: 'rate_limited', reauth: false, scope: 'connection' });
    m.listDetections.mockRejectedValue(limited);
    await expect(syncEdrDetections(CONNECTION_ID, { isFinalAttempt: false })).rejects.toBe(limited);
    expect(m.persistDetections).not.toHaveBeenCalled();
    expect(updatePayloads.some((u) => u.payload.status === 'reauth_required')).toBe(false);
  });

  it('fence moved -> nothing written', async () => {
    reReadRow = { ...BASE_ROW, baseUrl: 'https://other.gravityzone.bitdefender.com' };
    await expect(syncEdrDetections(CONNECTION_ID)).resolves.toBeUndefined();
    expect(m.persistDetections).not.toHaveBeenCalled();
  });
});
