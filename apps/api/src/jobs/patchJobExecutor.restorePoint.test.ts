import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  processorRef: undefined as any,
  processorRefs: {} as Record<string, any>,
  // #6632: depth of open system DB contexts (each is one Postgres transaction
  // in production). Tracked by a plain function, NOT vi.fn, so the suites that
  // call vi.resetAllMocks() cannot wipe its passthrough implementation.
  txDepth: 0,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    close = shared.closeMock;
  },
  Worker: class {
    close = shared.closeMock;
    constructor(name: string, processor: unknown) {
      shared.processorRefs[name] = processor;
      if (!shared.processorRef) {
        shared.processorRef = processor;
      }
    }
  },
  Job: class {},
  DelayedError: class DelayedError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'DelayedError';
    }
  },
}));

vi.mock('../db', () => {
  const db: Record<string, unknown> = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  };
  // Both `recordDeviceQueued` and the shared finalizer wrap their writes in a
  // transaction; run the callback against the same doubles.
  db.transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(db));
  // Each system context is one transaction in production. Tracked so #6632's
  // tests can prove no BullMQ add runs while the claim transaction is open.
  const withSystemDbAccessContext = async (fn: () => Promise<unknown>) => {
    shared.txDepth += 1;
    try {
      return await fn();
    } finally {
      shared.txDepth -= 1;
    }
  };
  return { db, withSystemDbAccessContext };
});

vi.mock('../db/schema', () => ({
  patchJobs: {
    id: 'patchJobs.id',
    status: 'patchJobs.status',
    orgId: 'patchJobs.orgId',
    patches: 'patchJobs.patches',
    targets: 'patchJobs.targets',
    devicesFailed: 'patchJobs.devicesFailed',
    devicesPending: 'patchJobs.devicesPending',
    scheduledAt: 'patchJobs.scheduledAt',
    createdAt: 'patchJobs.createdAt',
  },
  patchJobResults: {},
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
    title: 'patches.title',
    category: 'patches.category',
  },
  patchPolicies: {
    deferralDays: 'patchPolicies.deferralDays',
    id: 'patchPolicies.id',
    kind: 'patchPolicies.kind',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
  },
  deviceCommands: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/patchEligibility', () => ({
  resolveApprovedPatchesForDevice: vi.fn(),
}));

vi.mock('../services/patchRebootHandler', () => ({
  evaluateRebootPolicy: vi.fn(),
  executeReboot: vi.fn(),
}));

vi.mock('../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

// #5128 W3: the executor now enqueues through the single dispatch seam. Mocked
// at the module boundary so the test does not drag in the agent websocket
// transport (and, through it, the entire schema surface).
vi.mock('../services/dispatchDeviceCommand', () => ({
  dispatchDeviceCommand: vi.fn(),
}));

vi.mock('../services/commandOfflinePolicy', () => ({
  deliveryTtlMs: vi.fn(() => 7 * 24 * 60 * 60 * 1000),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/restorePointRequest', () => ({
  buildRestorePointRequest: vi.fn(),
  linkRestorePointCommand: vi.fn(),
  discardRestorePointRequest: vi.fn(),
  restorePointPayloadField: (block: unknown) => (block ? { restorePoint: block } : {}),
}));

import { db } from '../db';
import { createPatchJobDeviceWorker } from './patchJobExecutor';
import { resolveApprovedPatchesForDevice } from '../services/patchEligibility';
import { dispatchDeviceCommand } from '../services/dispatchDeviceCommand';
import {
  buildRestorePointRequest,
  discardRestorePointRequest,
  linkRestorePointCommand,
} from '../services/restorePointRequest';

function createSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createWhereSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

const APPROVED = [
  { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
  { patchId: 'patch-2', externalId: 'KB5000002', requiresReboot: false },
];

const BLOCK = {
  v: 1 as const,
  requestId: '33333333-3333-4333-8333-333333333333',
  enabled: true,
  label: 'Breeze: install 2 updates',
  resolvedAt: '2026-10-12T00:00:00.000Z',
  policyRevision: 'rev-1',
  validUntil: '2026-10-13T00:00:00.000Z',
};

let patchSelectFields: any;

function primeDeviceExecution(osType: string | null = 'windows', withPatchSelect = true) {
  const chain = vi.mocked(db.select)
    .mockImplementationOnce(() => createSelectChain([{
      id: 'job-1',
      orgId: 'org-1',
      status: 'running',
      patches: { ringId: null, autoApprove: {} },
      targets: { deviceIds: ['device-1'], deployment: { rebootPolicy: 'if_required', offlineBehavior: 'queue' } },
    }]) as any)
    .mockImplementationOnce(() => createSelectChain([{ id: 'device-1', osType }]) as any);
  if (withPatchSelect) chain.mockImplementationOnce(((fields: any) => {
      patchSelectFields = fields;
      return createWhereSelectChain(
        APPROVED.map((p) => ({
          id: p.patchId,
          source: 'windows_update',
          externalId: p.externalId,
          title: p.externalId,
          ...(fields && 'category' in fields ? { category: 'Security Updates' } : {}),
        })),
      );
    }) as any);
  vi.mocked(db.select).mockImplementation(() => createSelectChain([]) as any);
  vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce(APPROVED as any);
}

async function runPrepared() {
  createPatchJobDeviceWorker();
  return shared.processorRefs['patch-job-devices']({
    data: { type: 'execute-patch-job-device', patchJobId: 'job-1', deviceId: 'device-1', orgId: 'org-1' },
  });
}

function queuedOk(id = 'cmd-1') {
  vi.mocked(dispatchDeviceCommand).mockResolvedValueOnce({
    ok: true,
    command: { id },
    delivery: 'queued_offline',
    deliverBy: null,
  } as any);
}

function lastPayload(): any {
  return vi.mocked(dispatchDeviceCommand).mock.calls[0]![0].payload;
}

describe('install_patches restore-point stamping (#4756)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    shared.processorRef = undefined;
    shared.processorRefs = {};
    patchSelectFields = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(db.insert).mockImplementation(() => ({ values: vi.fn(() => Promise.resolve()) }) as any);
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([{ id: 'w0' }]), {
            returning: vi.fn(() => Promise.resolve([{ id: 'w0' }])),
          }),
        ),
      })),
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves through the chokepoint with the device osType, patch trigger and patchJobId', async () => {
    primeDeviceExecution('Windows');
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    queuedOk();
    await runPrepared();
    expect(buildRestorePointRequest).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-1',
      osType: 'Windows',
      trigger: 'patch',
      label: 'install 2 updates',
      patchJobId: 'job-1',
    }));
  });

  it('stamps the block on the install_patches payload and links the command id', async () => {
    primeDeviceExecution();
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    queuedOk('cmd-77');
    await runPrepared();
    expect(lastPayload().restorePoint).toEqual(BLOCK);
    expect(linkRestorePointCommand).toHaveBeenCalledWith(BLOCK, 'cmd-77');
  });

  it('carries each patch category only when a block is stamped', async () => {
    primeDeviceExecution();
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    queuedOk();
    await runPrepared();
    expect(patchSelectFields).toHaveProperty('category');
    expect(lastPayload().patches[0]).toHaveProperty('category', 'Security Updates');
  });

  it('leaves the payload byte-identical (no key, no category) when no block is returned', async () => {
    primeDeviceExecution();
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(null);
    queuedOk();
    await runPrepared();
    expect(Object.keys(lastPayload()).sort()).toEqual(['patchIds', 'patchJobId', 'patches']);
    expect(patchSelectFields).not.toHaveProperty('category');
    expect(Object.keys(lastPayload().patches[0]).sort()).toEqual(['externalId', 'id', 'source', 'title']);
  });

  it('stamps an enabled:false block (explicit off) rather than omitting it', async () => {
    primeDeviceExecution();
    const off = { ...BLOCK, enabled: false };
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(off);
    queuedOk();
    await runPrepared();
    expect(lastPayload().restorePoint).toEqual(off);
  });

  it('fails the device visibly and dispatches nothing when resolution throws', async () => {
    primeDeviceExecution('windows', false);
    vi.mocked(buildRestorePointRequest).mockRejectedValueOnce(new Error('db down'));
    const result: any = await runPrepared();
    expect(result).toMatchObject({ kind: 'error' });
    expect(result.error).toMatch(/restore/i);
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('discards the requested row when the dispatch seam refuses', async () => {
    primeDeviceExecution();
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    vi.mocked(dispatchDeviceCommand).mockResolvedValueOnce({
      ok: false,
      code: 'device_decommissioned',
      error: 'Device is decommissioned',
    } as any);
    await runPrepared();
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
  });

  it('discards the requested row when the patch-records read throws before dispatch', async () => {
    primeDeviceExecution('windows', false);
    vi.mocked(db.select).mockImplementationOnce((() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => Promise.reject(new Error('read failed')));
      return chain;
    }) as any);
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    await expect(runPrepared()).rejects.toThrow('read failed');
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('records the error_resolving_restore_point skip reason when resolution throws', async () => {
    primeDeviceExecution('windows', false);
    const inserted: any[] = [];
    vi.mocked(db.insert).mockImplementation(() => ({ values: vi.fn((v: any) => { inserted.push(v); return Promise.resolve(); }) }) as any);
    vi.mocked(buildRestorePointRequest).mockRejectedValueOnce(new Error('db down'));
    await runPrepared();
    expect(JSON.stringify(inserted)).toContain('error_resolving_restore_point');
  });
});
