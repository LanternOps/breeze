import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbAccessContext } from '../db';
import type { ConversionPreviewJobData } from './monitorConversionPreviewWorker';

const mocks = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { data: ConversionPreviewJobData }) => Promise<unknown>),
  context: undefined as DbAccessContext | undefined,
  withContext: vi.fn(), build: vi.fn(), authorize: vi.fn(), freshness: vi.fn(),
  scopeHash: vi.fn(), restore: vi.fn(), setex: vi.fn(), add: vi.fn(),
  workerClose: vi.fn(), queueClose: vi.fn(), workerConstruct: vi.fn(),
}));
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    getCurrentDbAccessContext: () => mocks.context,
    withDbAccessContext: async (context: DbAccessContext, callback: () => Promise<unknown>) => {
      mocks.withContext(context);
      mocks.context = context;
      try { return await actual.__runInDbContextForTests(callback); }
      finally { mocks.context = undefined; }
    },
  };
});
vi.mock('bullmq', () => ({
  Queue: class { add = mocks.add; close = mocks.queueClose; },
  Worker: class {
    close = mocks.workerClose;
    // attachWorkerObservability subscribes to lifecycle events on every
    // constructed Worker (workerReadinessCoverage.test.ts enforces it).
    on = vi.fn().mockReturnThis();
    constructor(name: string, processor: typeof mocks.processor, options: unknown) {
      mocks.processor = processor;
      mocks.workerConstruct(name, options);
    }
  },
}));
vi.mock('../services/redis', () => ({
  getRedis: () => ({ setex: mocks.setex }), getBullMQConnection: () => ({}),
}));
vi.mock('../services/monitors/conversion/previewScope', () => ({
  authorizePreview: mocks.authorize, previewFreshness: mocks.freshness,
  previewScopeHash: mocks.scopeHash, restorePreviewAuth: mocks.restore,
}));
vi.mock('../services/monitors/conversion/convert', () => ({
  buildPolicyConversionPreview: mocks.build,
  ConversionError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));

import { __runInDbContextForTests, getCurrentDbAccessContext, runOutsideDbContext } from '../db';
import {
  createMonitorConversionPreviewWorker, getMonitorConversionPreviewQueue,
  initializeMonitorConversionPreviewWorker, shutdownMonitorConversionPreviewWorker, previewJobKey,
} from './monitorConversionPreviewWorker';

const data = {
  policyId: 'policy-1', sourcesHash: 'sources-hash', scopeHash: 'scope-hash',
  snapshot: {
    auth: { scope: 'organization', user: { id: 'user-1' } },
    dbContext: { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'], userId: 'user-1' },
  },
} as ConversionPreviewJobData;
const run = () => mocks.processor!({ data });
const entries = () => mocks.setex.mock.calls.map((call) => JSON.parse(call[2] as string));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.restore.mockReturnValue(data.snapshot.auth);
  mocks.scopeHash.mockReturnValue(data.scopeHash);
  mocks.freshness.mockResolvedValue(data.sourcesHash);
  mocks.build.mockImplementation(async (_policy, _actor, options) => {
    // The worker deliberately holds NO context: buildPolicyConversionPreview
    // opens the single isolated transaction and restores the snapshot itself.
    expect(getCurrentDbAccessContext()).toBeUndefined();
    await options.onProgress(50, 501);
    return { policyId: data.policyId, equivalence: { devicesChecked: 501, deltas: [] } };
  });
  createMonitorConversionPreviewWorker();
});
afterEach(async () => { await shutdownMonitorConversionPreviewWorker(); vi.unstubAllEnvs(); });

describe('monitor conversion preview worker', () => {
  it('hands the caller snapshot to the builder and stores progress and completed results', async () => {
    const result = await run();
    // No second pooled connection: the worker must NOT wrap the build in its
    // own withDbAccessContext (#1105 / #2417 double-hold). The builder gets the
    // restored auth and re-authorizes inside its own isolated transaction.
    expect(mocks.withContext).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledWith(data.snapshot);
    expect(mocks.build).toHaveBeenCalledWith(
      data.policyId,
      expect.objectContaining({ auth: data.snapshot.auth }),
      expect.objectContaining({ expectedFreshness: data.sourcesHash }),
    );
    expect(entries()).toMatchObject([
      { status: 'running', progress: { checked: 0, total: 0 } },
      { status: 'running', progress: { checked: 50, total: 501 } },
      { status: 'done', result },
    ]);
    for (const call of mocks.setex.mock.calls) {
      expect(call.slice(0, 2)).toEqual([previewJobKey(data.policyId, data.scopeHash, data.sourcesHash), 3600]);
      expect(JSON.parse(call[2] as string)).toMatchObject({ scopeHash: data.scopeHash, sourcesHash: data.sourcesHash });
    }
  });
  it('records a safe failure and propagates preview failures', async () => {
    mocks.build.mockRejectedValue(new Error('private channel credentials'));
    await expect(run()).rejects.toThrow('private channel credentials');
    expect(entries().at(-1)).toMatchObject({ status: 'failed', error: 'preview_failed' });
    expect(JSON.stringify(entries())).not.toContain('private channel credentials');
  });
  it('passes the queued freshness down so the builder rejects stale sources in its own snapshot', async () => {
    // Checking freshness here would only prove a DIFFERENT snapshot than the
    // one the preview is built from; the builder compares expectedFreshness
    // inside its isolated transaction instead.
    mocks.build.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'preview_stale' }));
    await expect(run()).rejects.toMatchObject({ code: 'preview_stale' });
    expect(mocks.build).toHaveBeenCalledWith(data.policyId, expect.anything(),
      expect.objectContaining({ expectedFreshness: data.sourcesHash }));
    expect(entries().at(-1).status).toBe('failed');
  });
  it('propagates an authorization failure raised inside the builder', async () => {
    // authorizePreview now runs inside buildPolicyConversionPreview's isolated
    // transaction, under the restored caller context.
    mocks.build.mockRejectedValueOnce(new Error('Policy not found'));
    await expect(run()).rejects.toThrow('Policy not found');
    expect(entries().at(-1).status).toBe('failed');
  });
  it('uses the real strict queue tripwire and permits enqueues only outside held context', async () => {
    vi.stubEnv('DB_CONTEXT_TRIPWIRE_STRICT', 'true');
    const queue = getMonitorConversionPreviewQueue();
    mocks.add.mockImplementation(async () => {
      expect(getCurrentDbAccessContext()).toBeUndefined();
      return { id: 'job' };
    });
    await __runInDbContextForTests(async () => {
      expect(() => queue.add('preview', data)).toThrow('held withDbAccessContext');
      await runOutsideDbContext(() => queue.add('preview', data));
    });
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });
  it('starts once, closes queue and worker, and shutdown never creates a queue', async () => {
    await shutdownMonitorConversionPreviewWorker();
    expect(mocks.queueClose).not.toHaveBeenCalled();
    const baseline = mocks.workerConstruct.mock.calls.length;
    await initializeMonitorConversionPreviewWorker();
    await initializeMonitorConversionPreviewWorker();
    expect(mocks.workerConstruct).toHaveBeenCalledTimes(baseline + 1);
    getMonitorConversionPreviewQueue();
    await shutdownMonitorConversionPreviewWorker();
    await shutdownMonitorConversionPreviewWorker();
    expect(mocks.workerClose).toHaveBeenCalledTimes(1);
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
  });
});
