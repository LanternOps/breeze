import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { pgErrorCode } from '@breeze/shared/pgErrors';

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
  c.for = vi.fn(() => { phase3Started = true; events.push('for-update'); state.table = 'forUpdate'; return c; });
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
// Phase-3 per-tenant fence read (the first edr_tenants select after the FOR UPDATE re-read).
let phase3Started = false;
let phase3TenantSelects = 0;
let phase3TenantRows: Array<Record<string, unknown>> | undefined;
// Rows the phase-1 endpoint query (db.execute) returns.
let executeRows: Array<Record<string, unknown>> = [];
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
          if (phase3Started) {
            phase3TenantSelects += 1;
            if (phase3TenantSelects === 1) {
              (c as { then: unknown }).then = (res: (v: unknown) => unknown) =>
                Promise.resolve(phase3TenantRows ?? tenantRows).then(res);
            }
            return c;
          }
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
    execute: vi.fn(() => { events.push('execute'); return Promise.resolve(executeRows); }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    phase3Started = false; phase3TenantSelects = 0;
    events.push('tx-begin');
    try { return await fn(); } finally { contextDepth -= 1; }
  }),
  runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try { return await fn(); } finally { contextDepth = saved; }
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
const SECRET_KEY = 'sk-distinctive-secret-9f3a';
vi.mock('../services/edrProviders/credentials', () => ({ decryptEdrSecret: vi.fn(() => ({ apiKey: SECRET_KEY })) }));
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
  edrSyncJobId, enqueueEdrSync, isFinalSyncAttempt, selectDueStreams, syncEdrDetections, syncEdrInventory,
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
  contextDepth = 0; tenantSelects = 0; executeRows = [];
  fetchDepths.length = 0; dbCallDepths.length = 0; updatePayloads.length = 0; events.length = 0;
  connectionRow = { ...BASE_ROW };
  reReadRow = undefined; phase3Started = false; phase3TenantSelects = 0; phase3TenantRows = undefined;
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
  m.isDeadlockError.mockImplementation((e: unknown) => pgErrorCode(e) === '40P01');
  m.enqueueOrReplaceStale.mockResolvedValue({ id: 'job-1' });
});

describe('isFinalSyncAttempt', () => {
  // BullMQ 5 bumps attemptsMade only when an attempt finishes or is retried, so inside the
  // processor it is 0-based: the 3rd of 3 attempts runs with attemptsMade === 2.
  it('is true on the last configured attempt', () => {
    expect(isFinalSyncAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
  });
  it('is false on earlier attempts', () => {
    expect(isFinalSyncAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalSyncAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
  });
  it('a job with no retry budget is always on its final attempt', () => {
    expect(isFinalSyncAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });
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
  it('enriches an endpoint in the run that first stores it, ahead of the stalest known ones', async () => {
    // Live 2026-10-08: without this, a newly mapped company showed health/online/last-seen
    // as unknown until the NEXT inventory run (an hour later by default).
    executeRows = [
      { tenant_id: 't-mapped', vendor_endpoint_id: 'old-stale', rn: 1 },
      { tenant_id: 't-mapped', vendor_endpoint_id: 'old-fresh', rn: 2 },
    ];
    m.listEndpoints.mockImplementation(async () => [
      { vendorEndpointId: 'new-1' }, { vendorEndpointId: 'old-stale' }, { vendorEndpointId: 'old-fresh' },
    ]);
    await syncEdrInventory(CONNECTION_ID);
    expect(m.enrichEndpoints).toHaveBeenCalledTimes(1);
    expect(m.enrichEndpoints.mock.calls[0]![2]).toEqual(['new-1', 'old-stale', 'old-fresh']);
  });

  it('never writes capabilities_snapshot (only a connection test does)', async () => {
    await syncEdrInventory(CONNECTION_ID);
    expect(lastConnectionUpdate()?.payload).toBeDefined();
    expect(updatePayloads.some((u) => 'capabilitiesSnapshot' in u.payload)).toBe(false);
  });

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

describe('phase-3 per-tenant fence (review #1)', () => {
  const REMAPPED = { ...MAPPED, orgId: 'org-NEW' };

  it('inventory: a tenant remapped between phases is not persisted and the stream is re-enqueued', async () => {
    tenantRows = [MAPPED, MAPPED2];
    phase3TenantRows = [REMAPPED, MAPPED2];
    m.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    await syncEdrInventory(CONNECTION_ID);
    const results = m.persistInventory.mock.calls[0]![2] as Array<{ vendorTenantId: string }>;
    expect(results.map((r) => r.vendorTenantId)).toEqual(['v-mapped2']);
    expect(m.enqueueOrReplaceStale).toHaveBeenCalledWith(
      expect.anything(), 'sync-inventory', `edr-inventory-${CONNECTION_ID}-rerun`,
      expect.anything(), expect.anything(), expect.any(String),
    );
    // NOT the running job's own id: enqueueOrReplaceStale returns an ACTIVE job unchanged, so
    // re-using it would queue nothing (review finding).
    expect(m.enqueueOrReplaceStale.mock.calls.map((c) => c[2])).not.toContain(`edr-inventory-${CONNECTION_ID}`);
  });

  it('inventory: unchanged tenants are all persisted and nothing is re-enqueued', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    await syncEdrInventory(CONNECTION_ID);
    expect((m.persistInventory.mock.calls[0]![2] as unknown[]).length).toBe(2);
    expect(m.enqueueOrReplaceStale).not.toHaveBeenCalled();
  });

  it('inventory: a tenant auto-mapped in phase 3 (was unmapped in phase 1) is dropped too', async () => {
    phase3TenantRows = [MAPPED, { ...UNMAPPED, orgId: 'org-auto' }];
    await syncEdrInventory(CONNECTION_ID);
    const results = m.persistInventory.mock.calls[0]![2] as Array<{ vendorTenantId: string }>;
    expect(results.map((r) => r.vendorTenantId)).toEqual(['v-mapped']);
    expect(m.enqueueOrReplaceStale).toHaveBeenCalledTimes(1);
  });

  it('detections: a remapped org OR a reset cursor drops that tenant; the other persists; re-enqueued', async () => {
    const A = { ...MAPPED, id: 'a', vendorTenantId: 'va', detectionCursor: 'c0' };
    const B = { ...MAPPED, id: 'b', vendorTenantId: 'vb', detectionCursor: 'c0' };
    const C = { ...MAPPED, id: 'c', vendorTenantId: 'vc', detectionCursor: 'c0' };
    tenantRows = [A, B, C];
    phase3TenantRows = [{ ...A, orgId: 'org-NEW' }, { ...B, detectionCursor: null }, C];
    await syncEdrDetections(CONNECTION_ID);
    const results = m.persistDetections.mock.calls[0]![2] as Array<{ vendorTenantId: string }>;
    expect(results.map((r) => r.vendorTenantId)).toEqual(['vc']);
    expect(m.enqueueOrReplaceStale).toHaveBeenCalledWith(
      expect.anything(), 'sync-detections', `edr-detections-${CONNECTION_ID}-rerun`,
      expect.anything(), expect.anything(), expect.any(String),
    );
  });

  it('detections: unchanged tenants persist and nothing is re-enqueued; an enqueue failure does not fail the run', async () => {
    await syncEdrDetections(CONNECTION_ID);
    expect(m.enqueueOrReplaceStale).not.toHaveBeenCalled();
    phase3TenantRows = [{ ...MAPPED, orgId: 'org-NEW' }];
    m.enqueueOrReplaceStale.mockRejectedValue(new Error('redis down'));
    await expect(syncEdrDetections(CONNECTION_ID)).resolves.toBeUndefined();
  });
});

describe('a connection-level fence trip releases the running status (review)', () => {
  const lastStatusWrite = (key: string) => [...updatePayloads].reverse().find((u) => key in u.payload)?.payload;

  it('inventory: deactivated mid-fetch -> nothing persisted, status restored from running to its prior value', async () => {
    connectionRow = { ...BASE_ROW, lastInventorySyncStatus: 'success', lastInventorySyncError: null };
    reReadRow = { ...BASE_ROW, isActive: false };
    await syncEdrInventory(CONNECTION_ID);
    expect(m.persistInventory).not.toHaveBeenCalled();
    expect(lastStatusWrite('lastInventorySyncStatus')).toMatchObject({ lastInventorySyncStatus: 'success', lastInventorySyncError: null });
  });

  it('detections: re-credentialled mid-fetch -> status restored, prior error kept', async () => {
    connectionRow = { ...BASE_ROW, lastDetectionSyncStatus: 'partial', lastDetectionSyncError: '1 tenant(s) failed to sync' };
    reReadRow = { ...BASE_ROW, credentialsEncrypted: 'enc-rotated' };
    await syncEdrDetections(CONNECTION_ID);
    expect(m.persistDetections).not.toHaveBeenCalled();
    expect(lastStatusWrite('lastDetectionSyncStatus')).toMatchObject({
      lastDetectionSyncStatus: 'partial', lastDetectionSyncError: '1 tenant(s) failed to sync',
    });
  });
});

describe('all tenants failed -> fail closed (H3)', () => {
  const tenantErr = (m_: string) => new FakeEdrError(m_, { code: 'permission', reauth: false, scope: 'tenant' });

  it('inventory: every fetch failing throws with the first tenant error; final attempt records error', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    m.listEndpoints.mockRejectedValue(tenantErr('company denied'));
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow('company denied');
    expect(m.persistInventory).not.toHaveBeenCalled();
    const rec = updatePayloads.find((u) => u.payload.lastInventorySyncStatus === 'error')!;
    expect(rec.payload.lastInventorySyncError).toContain('company denied');
    expect(updatePayloads.some((u) => u.payload.status === 'connected')).toBe(false);
  });

  it('inventory: zero tenants is not "all failed"', async () => {
    tenantRows = [];
    m.listTenants.mockResolvedValue([]);
    await expect(syncEdrInventory(CONNECTION_ID)).resolves.toBeUndefined();
    expect(m.persistInventory).toHaveBeenCalled();
  });

  it('detections: every fetch failing throws with the first tenant error; zero mapped tenants is fine', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listDetections.mockRejectedValue(tenantErr('incidents denied'));
    await expect(syncEdrDetections(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow('incidents denied');
    expect(m.persistDetections).not.toHaveBeenCalled();
    expect(updatePayloads.find((u) => u.payload.lastDetectionSyncStatus === 'error')!.payload.lastDetectionSyncError)
      .toContain('incidents denied');

    tenantRows = [UNMAPPED];
    await expect(syncEdrDetections(CONNECTION_ID)).resolves.toBeUndefined();
  });
});

describe('detection warnings + skipped (M1, M3)', () => {
  it('page warnings make the connection partial with de-duplicated warnings as the error', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listDetections.mockImplementation(async () => ({ detections: [], cursor: 'c1', warnings: ['quarantine: API not enabled', 'x'] }));
    await syncEdrDetections(CONNECTION_ID);
    expect(lastConnectionUpdate()!.payload).toMatchObject({
      lastDetectionSyncStatus: 'partial',
      lastDetectionSyncError: 'quarantine: API not enabled; x',
    });
  });

  it('tenant failures and warnings combine', async () => {
    m.persistDetections.mockResolvedValue({ upserted: 0, failedTenants: 1, skipped: 0 });
    m.listDetections.mockImplementation(async () => ({ detections: [], cursor: 'c1', warnings: ['w1'] }));
    await syncEdrDetections(CONNECTION_ID);
    expect(lastConnectionUpdate()!.payload).toMatchObject({
      lastDetectionSyncStatus: 'partial',
      lastDetectionSyncError: '1 tenant(s) failed to sync; w1',
    });
  });

  it('skipped detections are warned about with the connection id and count only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.persistDetections.mockResolvedValue({ upserted: 0, failedTenants: 0, skipped: 3 });
    await syncEdrDetections(CONNECTION_ID);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('skipped'));
    expect(line).toContain(CONNECTION_ID);
    expect(line).toContain('3');
    warn.mockRestore();
  });
});

describe('failure writes are fenced on the credential tuple (review #4)', () => {
  it('a stale job cannot flip a re-credentialled connection to reauth_required / error', async () => {
    reReadRow = { ...BASE_ROW, credentialsEncrypted: 'enc-rotated' };
    m.listTenants.mockRejectedValue(new FakeEdrError('bad key', { code: 'unauthorized', reauth: true, scope: 'connection' }));
    await expect(syncEdrInventory(CONNECTION_ID)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(updatePayloads.some((u) => u.payload.status === 'reauth_required')).toBe(false);
    expect(updatePayloads.some((u) => u.payload.lastInventorySyncStatus === 'error')).toBe(false);

    m.listDetections.mockRejectedValue(new Error('vendor 503'));
    await expect(syncEdrDetections(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow('vendor 503');
    expect(updatePayloads.some((u) => u.payload.lastDetectionSyncStatus === 'error')).toBe(false);
  });
});

describe('detections resilience + secret scrubbing (test gap)', () => {
  it('retries a 40P01 deadlock twice then succeeds: 3 persist calls, one connection write', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    m.persistDetections.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(deadlock);
    await expect(syncEdrDetections(CONNECTION_ID)).resolves.toBeUndefined();
    expect(m.persistDetections).toHaveBeenCalledTimes(3);
    expect(updatePayloads.filter((u) => 'lastDetectionSyncAt' in u.payload)).toHaveLength(1);
    expect(m.listDetections).toHaveBeenCalledTimes(1);
  });

  it('never persists the decrypted credential, even when a vendor error echoes it', async () => {
    tenantRows = [MAPPED, MAPPED2];
    m.listDetections.mockImplementation(async (_c: unknown, t: { vendorTenantId: string }) => {
      if (t.vendorTenantId === 'v-mapped') throw new FakeEdrError(`bad auth ${SECRET_KEY} here`, { code: 'permission', reauth: false, scope: 'tenant' });
      return { detections: [], cursor: 'c1', warnings: [] };
    });
    await syncEdrDetections(CONNECTION_ID);
    const results = m.persistDetections.mock.calls[0]![2];
    expect(JSON.stringify(results)).not.toContain(SECRET_KEY);

    m.listTenants.mockRejectedValue(new Error(`GET failed with key=${SECRET_KEY}`));
    await expect(syncEdrInventory(CONNECTION_ID, { isFinalAttempt: true })).rejects.toThrow();
    expect(JSON.stringify(updatePayloads)).not.toContain(SECRET_KEY);
    expect(updatePayloads.find((u) => u.payload.lastInventorySyncStatus === 'error')).toBeDefined();
  });
});
