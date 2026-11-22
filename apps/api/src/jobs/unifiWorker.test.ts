import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { workerCloseMock, workerConstructorMock, queueCloseMock, queueConstructorMock, queueAddMock, dbState } = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueCloseMock: vi.fn(),
  queueConstructorMock: vi.fn(),
  queueAddMock: vi.fn(async () => {}),
  dbState: { integrations: [] as Array<{ id: string; partnerId: string }>, wheres: [] as unknown[] },
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => {
    queueConstructorMock();
    return {
      close: queueCloseMock,
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(async () => {}),
      add: queueAddMock,
    };
  }),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
// select().from(t).where(w): records w; integrations for the scheduler, [] (no
// mappings) for everything else.
vi.mock('../db', async () => {
  const schema = await import('../db/schema');
  return {
    db: {
      select: () => {
        let table: unknown;
        const chain: any = {
          from(t: unknown) { table = t; return chain; },
          where(w: unknown) {
            dbState.wheres.push(w);
            return Promise.resolve(table === schema.unifiIntegrations ? dbState.integrations : []);
          },
        };
        return chain;
      },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unifi/unifiClient', () => ({ createUnifiClient: vi.fn(() => ({ fake: 'client' })) }));
vi.mock('../services/unifi/unifiConnectionService', () => ({
  markStatus: vi.fn(),
  markSynced: vi.fn(),
}));
vi.mock('../services/unifi/unifiKeyService', () => ({
  getSyncKeys: vi.fn(),
  recordKeyResults: vi.fn(),
  unifiKeyLast4: (k: string) => k.slice(-4),
}));
vi.mock('../services/unifi/unifiSyncService', () => ({
  collectSyncData: vi.fn(),
  applySyncData: vi.fn(),
}));

import { createUnifiClient } from '../services/unifi/unifiClient';
import { markStatus, markSynced } from '../services/unifi/unifiConnectionService';
import { getSyncKeys, recordKeyResults } from '../services/unifi/unifiKeyService';
import type { CollectedSync, KeyRunResult } from '../services/unifi/unifiSyncService';
import { applySyncData, collectSyncData } from '../services/unifi/unifiSyncService';
import {
  getUnifiSyncQueue,
  initializeUnifiWorker,
  shutdownUnifiWorker,
} from './unifiWorker';

describe('shutdownUnifiWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the worker and the lazily-created sync queue exactly once after initialize', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('a second shutdown call is a no-op (handles already nulled)', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();
    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when called before initialize or queue creation', async () => {
    await expect(shutdownUnifiWorker()).resolves.toBeUndefined();
    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
  });

  it('closes the sync queue when it was created lazily via getUnifiSyncQueue() without ever initializing the worker', async () => {
    getUnifiSyncQueue();

    await shutdownUnifiWorker();

    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });
});

const INTEGRATION = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

async function processor(): Promise<(job: { data: unknown }) => Promise<unknown>> {
  await initializeUnifiWorker();
  const calls = workerConstructorMock.mock.calls;
  return calls[calls.length - 1]![1] as (job: { data: unknown }) => Promise<unknown>;
}

function syncJob() {
  return { data: { type: 'sync-integration', integrationId: INTEGRATION, partnerId: PARTNER, trigger: 'scheduled' } };
}

function okKey(id: string, apiKey: string) {
  return { id, label: id, apiKey, keyLast4: null, lastSeenHostIds: null };
}

function collected(over: Partial<CollectedSync> = {}): CollectedSync {
  return {
    hostsSeen: 1, byMapping: new Map(), keyResults: [], uncertainHostIds: new Set(), protectedDeviceIds: new Set(),
    allKeysSucceeded: true, ...over,
  };
}
function keyResult(over: Partial<KeyRunResult>): KeyRunResult {
  return { keyId: 'key-1', label: 'Global', status: 'success', authFailure: false, hostsSeen: 1, sitesSeen: 1, hostIds: ['h1'], error: null, ...over };
}
const runResult = (over: Record<string, unknown> = {}) => ({
  hostsSeen: 1, devicesCreated: 0, devicesUpdated: 0, devicesUnchanged: 0, devicesRemoved: 0, status: 'success' as const, ...over,
});

describe('unifi worker syncs every enabled key (#11808)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    dbState.integrations = [];
    dbState.wheres = [];
    await shutdownUnifiWorker();
    vi.mocked(collectSyncData).mockResolvedValue(collected());
    vi.mocked(applySyncData).mockResolvedValue(runResult());
  });

  it('the scheduler queues cloud integrations only', async () => {
    dbState.integrations = [{ id: INTEGRATION, partnerId: PARTNER }];
    const run = await processor();
    await expect(run({ data: { type: 'sync-scheduler' } })).resolves.toEqual({ queued: 1 });
    const rendered = new PgDialect().sqlToQuery(dbState.wheres[0] as any);
    expect(rendered.sql).toContain('"unifi_integrations"."is_active" = $');
    expect(rendered.sql).toContain('"unifi_integrations"."connection_type" = $');
    expect(rendered.params).toEqual(expect.arrayContaining([true, 'cloud']));
  });

  it('builds one client per key and collects them all; a key that does not decrypt has no client', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({
      baseUrl: 'https://api.ui.com',
      keys: [
        okKey('key-1', 'alpha-1234'),
        { id: 'key-2', label: 'Broken', apiKey: null, decryptError: 'The stored API key could not be decrypted', lastSeenHostIds: ['h2'] },
        { ...okKey('key-3', 'gamma-9999'), keyLast4: '9999' },
      ],
    });
    const run = await processor();
    await run(syncJob());
    expect(createUnifiClient).toHaveBeenCalledTimes(2);
    expect(createUnifiClient).toHaveBeenNthCalledWith(1, { baseUrl: 'https://api.ui.com', apiKey: 'alpha-1234' });
    expect(createUnifiClient).toHaveBeenNthCalledWith(2, { baseUrl: 'https://api.ui.com', apiKey: 'gamma-9999' });
    const [keys] = vi.mocked(collectSyncData).mock.calls[0]!;
    expect(keys.map((k) => [k.id, k.label, k.client === null, k.decryptError, k.lastSeenHostIds])).toEqual([
      ['key-1', 'key-1', false, undefined, null],
      ['key-2', 'Broken', true, 'The stored API key could not be decrypted', ['h2']],
      ['key-3', 'key-3', false, undefined, null],
    ]);
    // key_last4 is offered only for a key that has none stored.
    const recorded = vi.mocked(recordKeyResults).mock.calls[0]![1];
    expect(recorded.keyLast4ById).toEqual(new Map([['key-1', '1234']]));
    expect(recorded.runStartedAt).toBeInstanceOf(Date);
  });

  it('records key results, then the run, then the integration status, in that order', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'new')] });
    const results = [keyResult({})];
    vi.mocked(collectSyncData).mockResolvedValue(collected({ keyResults: results }));
    const run = await processor();
    await run(syncJob());
    expect(recordKeyResults).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      integrationId: INTEGRATION, partnerId: PARTNER, results,
    }));
    const order = [recordKeyResults, markSynced, markStatus].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'connected', null);
  });

  it('worker: every key auth-failed (401 and 403) -> integration reauth_required', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'a'), okKey('key-2', 'b')] });
    vi.mocked(collectSyncData).mockResolvedValue(collected({
      fatalError: 'All 2 API keys failed: "A": Unauthorized; "B": Forbidden',
      allKeysSucceeded: false,
      keyResults: [
        keyResult({ keyId: 'key-1', status: 'failed', authFailure: true, error: 'Unauthorized', hostIds: null }),
        keyResult({ keyId: 'key-2', status: 'failed', authFailure: true, error: 'Forbidden', hostIds: null }),
      ],
    }));
    vi.mocked(applySyncData).mockResolvedValue(runResult({ status: 'failed', error: 'All 2 API keys failed: "A": Unauthorized; "B": Forbidden' }));
    const run = await processor();
    await run(syncJob());
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'reauth_required', 'All 2 API keys failed: "A": Unauthorized; "B": Forbidden');
  });

  it('worker: a failure that is not every key rejecting the request is error, not reauth_required', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'a'), okKey('key-2', 'b')] });
    vi.mocked(collectSyncData).mockResolvedValue(collected({
      fatalError: 'All 2 API keys failed',
      allKeysSucceeded: false,
      keyResults: [
        keyResult({ keyId: 'key-1', status: 'failed', authFailure: true, error: 'Unauthorized', hostIds: null }),
        // The text says 401 but the failure carried no auth status: no regex decides this any more.
        keyResult({ keyId: 'key-2', status: 'failed', authFailure: false, error: 'proxy said 401 unauthorized', hostIds: null }),
      ],
    }));
    vi.mocked(applySyncData).mockResolvedValue(runResult({ status: 'failed', error: 'All 2 API keys failed' }));
    const run = await processor();
    await run(syncJob());
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'error', 'All 2 API keys failed');
  });

  it('worker: one of two keys failed -> integration connected, partial, error names the key', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'a'), okKey('key-2', 'b')] });
    vi.mocked(collectSyncData).mockResolvedValue(collected({
      allKeysSucceeded: false,
      keyFailureSummary: '1 of 2 API keys failed: "Macera" (key rejected)',
      keyResults: [keyResult({}), keyResult({ keyId: 'key-2', label: 'Macera', status: 'failed', authFailure: true, error: 'Unauthorized', hostIds: null })],
    }));
    vi.mocked(applySyncData).mockResolvedValue(runResult({ status: 'partial', error: '1 of 2 API keys failed: "Macera" (key rejected)' }));
    const run = await processor();
    await run(syncJob());
    expect(markSynced).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'partial', '1 of 2 API keys failed: "Macera" (key rejected)');
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'connected', '1 of 2 API keys failed: "Macera" (key rejected)');
  });

  it('a cloud integration with zero enabled keys records a failed run and is marked reauth_required', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [] });
    vi.mocked(collectSyncData).mockResolvedValue(collected({ hostsSeen: 0, fatalError: 'No enabled API key on this connection', allKeysSucceeded: false }));
    vi.mocked(applySyncData).mockResolvedValue(runResult({ hostsSeen: 0, status: 'failed', error: 'No enabled API key on this connection' }));
    const run = await processor();
    await run(syncJob());
    expect(createUnifiClient).not.toHaveBeenCalled();
    expect(vi.mocked(collectSyncData).mock.calls[0]![0]).toEqual([]);
    expect(applySyncData).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'reauth_required', 'No enabled API key on this connection');
  });

  it('a non-cloud or missing integration returns without writing anything', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue(null);
    const run = await processor();
    await run(syncJob());
    expect(markStatus).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
    expect(applySyncData).not.toHaveBeenCalled();
    expect(recordKeyResults).not.toHaveBeenCalled();
  });

  it('an apply that throws still records the key results, then marks the integration error', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'a')] });
    vi.mocked(collectSyncData).mockResolvedValue(collected({ keyResults: [keyResult({})] }));
    vi.mocked(applySyncData).mockRejectedValue(new Error('connection reset'));
    const run = await processor();
    await run(syncJob());
    expect(recordKeyResults).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'error', 'connection reset');
    expect(markSynced).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'failed', 'connection reset');
  });
});
