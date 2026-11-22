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
vi.mock('../services/unifi/unifiKeyService', () => ({ getSyncKeys: vi.fn() }));
vi.mock('../services/unifi/unifiSyncService', () => ({
  collectSyncData: vi.fn(),
  applySyncData: vi.fn(),
}));

import { createUnifiClient } from '../services/unifi/unifiClient';
import { markStatus, markSynced } from '../services/unifi/unifiConnectionService';
import { getSyncKeys } from '../services/unifi/unifiKeyService';
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

describe('unifi worker reads keys from unifi_integration_keys (#11808 W1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    dbState.integrations = [];
    dbState.wheres = [];
    await shutdownUnifiWorker();
    vi.mocked(collectSyncData).mockResolvedValue({ hostsSeen: 1, byMapping: new Map() });
    vi.mocked(applySyncData).mockResolvedValue({
      hostsSeen: 1, devicesCreated: 0, devicesUpdated: 0, devicesUnchanged: 0, devicesRemoved: 0, status: 'success',
    });
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

  it('processSyncIntegration builds the client from the key row, not the legacy column', async () => {
    // getSyncKeys is the only source of the key: it reads unifi_integration_keys
    // (and owns the D12 legacy reconcile). The worker never reads the legacy column.
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'new')] });
    const run = await processor();
    await run(syncJob());
    expect(getSyncKeys).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER);
    expect(createUnifiClient).toHaveBeenCalledWith({ baseUrl: 'https://api.ui.com', apiKey: 'new' });
    expect(applySyncData).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'connected', null);
  });

  it('W1 refuses a connection with two enabled keys: no UniFi call, only a fatal (failed) run is recorded', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [okKey('key-1', 'a'), okKey('key-2', 'b')] });
    const run = await processor();
    await run(syncJob());
    expect(createUnifiClient).not.toHaveBeenCalled();
    expect(collectSyncData).not.toHaveBeenCalled();
    expect(applySyncData).toHaveBeenCalledTimes(1);
    const collected = vi.mocked(applySyncData).mock.calls[0]![4];
    expect(collected).toEqual({
      hostsSeen: 0,
      fatalError: 'This connection has several API keys; this server version supports one',
      byMapping: new Map(),
    });
    expect(markStatus).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
  });

  it('a cloud integration with zero enabled keys is marked reauth_required', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({ baseUrl: 'https://api.ui.com', keys: [] });
    const run = await processor();
    await run(syncJob());
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'reauth_required', 'No enabled API key on this connection');
    expect(applySyncData).not.toHaveBeenCalled();
    expect(createUnifiClient).not.toHaveBeenCalled();
  });

  it('a non-cloud or missing integration returns without writing anything', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue(null);
    const run = await processor();
    await run(syncJob());
    expect(markStatus).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
    expect(applySyncData).not.toHaveBeenCalled();
  });

  it('a key that fails to decrypt is a failed run, never a silent skip', async () => {
    vi.mocked(getSyncKeys).mockResolvedValue({
      baseUrl: 'https://api.ui.com',
      keys: [{ id: 'key-1', label: 'Global', apiKey: null, decryptError: 'The stored API key could not be decrypted', lastSeenHostIds: null }],
    });
    vi.mocked(applySyncData).mockResolvedValue({
      hostsSeen: 0, devicesCreated: 0, devicesUpdated: 0, devicesUnchanged: 0, devicesRemoved: 0,
      status: 'failed', error: 'The stored API key could not be decrypted',
    });
    const run = await processor();
    await run(syncJob());
    expect(createUnifiClient).not.toHaveBeenCalled();
    expect(vi.mocked(applySyncData).mock.calls[0]![4]).toMatchObject({ fatalError: 'The stored API key could not be decrypted' });
    expect(markStatus).toHaveBeenCalledWith(expect.anything(), INTEGRATION, PARTNER, 'error', 'The stored API key could not be decrypted');
  });
});
