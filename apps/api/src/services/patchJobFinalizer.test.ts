import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  patchJobs: {
    id: 'patchJobs.id',
    orgId: 'patchJobs.orgId',
    targets: 'patchJobs.targets',
    status: 'patchJobs.status',
    devicesCompleted: 'patchJobs.devicesCompleted',
    devicesFailed: 'patchJobs.devicesFailed',
    devicesPending: 'patchJobs.devicesPending',
    devicesQueued: 'patchJobs.devicesQueued',
  },
  patchJobResults: {
    id: 'patchJobResults.id',
    jobId: 'patchJobResults.jobId',
    deviceId: 'patchJobResults.deviceId',
    patchId: 'patchJobResults.patchId',
    status: 'patchJobResults.status',
    rebootRequired: 'patchJobResults.rebootRequired',
  },
  patches: { id: 'patches.id', externalId: 'patches.externalId' },
  deviceCommands: { id: 'deviceCommands.id', deviceId: 'deviceCommands.deviceId' },
}));

vi.mock('./patchRebootHandler', () => ({
  evaluateRebootPolicy: vi.fn(),
  executeReboot: vi.fn(),
}));

vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(),
}));

// Accumulates across the whole file: the registration happens ONCE at module
// load, long before any beforeEach could clear a vi.fn().
const holdRegistry = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock('./commandClaimEligibility', () => ({
  registerTypeHold: (type: string, hold: unknown) => {
    holdRegistry.calls.push([type, hold]);
  },
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

import { db } from '../db';
import { patchJobResults, patchJobs } from '../db/schema';
import { evaluateRebootPolicy, executeReboot } from './patchRebootHandler';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import {
  SUPERSEDED_ERROR_MESSAGE,
  checkAndFinalizeJob,
  finalizePatchDeviceForCommand,
  finalizePatchJobDevice,
  handleInstallPatchesResult,
  installPatchesClaimHold,
  patchJobIdFromPayload,
} from './patchJobFinalizer';

// --------------------------------------------------------------------------
// Drizzle chain doubles. `.where()` is terminal for the multi-row reads and
// `.limit()` for the single-row ones, matching the real query shapes.
// --------------------------------------------------------------------------

function whereChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function limitChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

type Recorded = { table: unknown; values: Record<string, unknown> };

let inserts: Recorded[];
let updates: Recorded[];

function primeWrites() {
  inserts = [];
  updates = [];
  vi.mocked(db.insert).mockImplementation(
    (table: unknown) =>
      ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return Promise.resolve();
        }),
      }) as any,
  );
  vi.mocked(db.update).mockImplementation(
    (table: unknown) =>
      ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values });
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      }) as any,
  );
}

const JOB = 'job-1';
const DEVICE = 'device-1';
const COMMAND = 'cmd-1';

const CONTEXT = {
  orgId: 'org-1',
  rebootPolicy: 'never',
  approvedPatches: [
    { patchId: 'patch-1', externalId: 'KB1', requiresReboot: true },
    { patchId: 'patch-2', externalId: 'KB2', requiresReboot: false },
  ],
};

function successResult() {
  return {
    kind: 'result' as const,
    commandResult: {
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        installedCount: 2,
        failedCount: 0,
        rebootRequired: false,
        results: [
          { id: 'patch-1', externalId: 'KB1', status: 'installed' },
          { id: 'patch-2', externalId: 'KB2', status: 'installed' },
        ],
      }),
    },
  };
}

/** The two `queued` rows the executor writes when it defers an install. */
function queuedRows() {
  return [
    { id: 'r1', patchId: 'patch-1', status: 'queued', rebootRequired: true },
    { id: 'r2', patchId: 'patch-2', status: 'queued', rebootRequired: false },
  ];
}

const jobCounterUpdate = () => updates.find((u) => u.table === patchJobs)?.values;
const resultRowWrites = () => updates.filter((u) => u.table === patchJobResults);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  primeWrites();
  vi.mocked(evaluateRebootPolicy).mockResolvedValue({
    shouldReboot: false,
    reason: 'policy never',
    deferred: false,
    windowEndsAt: null,
  } as any);
  vi.mocked(executeReboot).mockResolvedValue({ success: true, delayMinutes: 15 } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installPatchesClaimHold (#5128 §E predicate 3)', () => {
  it('registers itself as the install_patches claim-time hold at module load', () => {
    // Load-bearing: without this registration a queued install is delivered
    // straight into an active suppression window, and nothing reports it.
    expect(holdRegistry.calls).toContainEqual(['install_patches', installPatchesClaimHold]);
  });

  it('holds delivery while a suppressPatching window is active', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: true,
      suppressPatching: true,
    } as any);
    await expect(installPatchesClaimHold(DEVICE)).resolves.toBe(true);
  });

  it('does not hold when the window is open but does not suppress patching', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: true,
      suppressPatching: false,
    } as any);
    await expect(installPatchesClaimHold(DEVICE)).resolves.toBe(false);
  });

  it('does not hold outside a maintenance window', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: false,
      suppressPatching: true,
    } as any);
    await expect(installPatchesClaimHold(DEVICE)).resolves.toBe(false);
  });
});

describe('finalizePatchJobDevice idempotency', () => {
  it('applies the first agent result and writes exactly one counter move', async () => {
    vi.mocked(db.select)
      // existing rows for (job, device): none yet — the synchronous first write
      .mockImplementationOnce(() => whereChain([]) as any)
      // checkAndFinalizeJob
      .mockImplementationOnce(() => limitChain([]) as any);

    const result = await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: successResult(),
      completedAt: new Date('2026-10-14T00:00:00.000Z'),
      context: CONTEXT,
    });

    expect(result).toEqual({ applied: true });
    expect(inserts).toHaveLength(2);
    expect(inserts.every((i) => i.values.status === 'completed')).toBe(true);
    expect(jobCounterUpdate()).toHaveProperty('devicesCompleted');
    expect(jobCounterUpdate()).toHaveProperty('devicesPending');
  });

  it('is a no-op the second time — every row is already terminal', async () => {
    vi.mocked(db.select).mockImplementationOnce(
      () =>
        whereChain([
          { id: 'r1', patchId: 'patch-1', status: 'completed', rebootRequired: true },
          { id: 'r2', patchId: 'patch-2', status: 'completed', rebootRequired: false },
        ]) as any,
    );

    const result = await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: successResult(),
      completedAt: new Date(),
      context: CONTEXT,
    });

    expect(result).toEqual({ applied: false });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('takes a queued device out of devicesQueued, not devicesPending', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      .mockImplementationOnce(() => limitChain([]) as any);

    await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: successResult(),
      completedAt: new Date(),
      context: CONTEXT,
    });

    const counters = jobCounterUpdate()!;
    expect(counters).toHaveProperty('devicesQueued');
    expect(counters).not.toHaveProperty('devicesPending');
    // The queued rows are UPDATED in place, never duplicated by a second insert.
    expect(inserts).toHaveLength(0);
    expect(resultRowWrites()).toHaveLength(2);
  });
});

describe('finalizePatchJobDevice deferred terminals', () => {
  it('fails a device whose delivery deadline passed, with the reconnect reason', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      // loadDeviceContext: the job row (no patches join — not a result terminal)
      .mockImplementationOnce(() => limitChain([{ orgId: 'org-1', targets: {} }]) as any)
      .mockImplementationOnce(() => limitChain([]) as any);

    const result = await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: { kind: 'expired', message: 'Device did not reconnect before 2026-10-20' },
      completedAt: new Date(),
    });

    expect(result).toEqual({ applied: true });
    const rowWrites = resultRowWrites();
    expect(rowWrites).toHaveLength(2);
    expect(rowWrites.every((u) => u.values.status === 'failed')).toBe(true);
    expect(rowWrites[0]!.values.errorMessage).toBe(
      'Device did not reconnect before 2026-10-20',
    );
    expect(jobCounterUpdate()).toHaveProperty('devicesFailed');
    // Never evaluated: an expired device installed nothing.
    expect(evaluateRebootPolicy).not.toHaveBeenCalled();
  });

  it('skips a cancelled device and counts it as completed, like markDeviceSkipped', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      .mockImplementationOnce(() => limitChain([{ orgId: 'org-1', targets: {} }]) as any)
      .mockImplementationOnce(() => limitChain([]) as any);

    await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: { kind: 'cancelled', reason: 'cancelled' },
      completedAt: new Date(),
    });

    const rowWrites = resultRowWrites();
    expect(rowWrites.every((u) => u.values.status === 'skipped')).toBe(true);
    expect(rowWrites[0]!.values.errorMessage).toBe('cancelled');
    expect(jobCounterUpdate()).toHaveProperty('devicesCompleted');
  });

  it('marks a superseded device skipped with the supersession reason', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      .mockImplementationOnce(() => limitChain([{ orgId: 'org-1', targets: {} }]) as any)
      .mockImplementationOnce(() => limitChain([]) as any);

    await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: { kind: 'superseded', byJobId: 'job-2' },
      completedAt: new Date(),
    });

    const rowWrites = resultRowWrites();
    expect(rowWrites.every((u) => u.values.status === 'skipped')).toBe(true);
    expect(rowWrites[0]!.values.errorMessage).toBe(SUPERSEDED_ERROR_MESSAGE);
    expect(SUPERSEDED_ERROR_MESSAGE).toBe('superseded_by_next_occurrence');
  });

  it('leaves a device with no rows alone — the synchronous poll still owns it', async () => {
    // An ONLINE device's install has no patch_job_results rows until
    // recordDeviceExecution writes them. A deferred door that counted it here
    // would move devices_pending a second time when that poll finally records
    // the same result.
    vi.mocked(db.select).mockImplementationOnce(() => whereChain([]) as any);

    const result = await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: { kind: 'cancelled', reason: 'cancelled' },
      completedAt: new Date(),
    });

    expect(result).toEqual({ applied: false });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('rebuilds the approved set from the queued rows when the agent finally answers', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      // loadDeviceContext: job row, then the patches join for externalId
      .mockImplementationOnce(
        () => limitChain([{ orgId: 'org-1', targets: { deployment: { rebootPolicy: 'always' } } }]) as any,
      )
      .mockImplementationOnce(
        () =>
          whereChain([
            { id: 'patch-1', externalId: 'KB1' },
            { id: 'patch-2', externalId: 'KB2' },
          ]) as any,
      )
      .mockImplementationOnce(() => limitChain([]) as any);

    await finalizePatchJobDevice({
      patchJobId: JOB,
      deviceId: DEVICE,
      commandId: COMMAND,
      terminal: {
        kind: 'result',
        commandResult: {
          status: 'failed',
          exitCode: 1,
          stdout: JSON.stringify({
            success: false,
            installedCount: 1,
            failedCount: 1,
            rebootRequired: true,
            results: [
              { id: 'patch-1', externalId: 'KB1', status: 'installed', rebootRequired: true },
              { id: 'patch-2', externalId: 'KB2', status: 'failed', error: 'boom' },
            ],
          }),
        },
      },
      completedAt: new Date(),
    });

    const byPatch = Object.fromEntries(
      resultRowWrites().map((u, i) => [queuedRows()[i]!.patchId, u.values]),
    );
    // #4267 — per-patch status, not the batch aggregate.
    expect(byPatch['patch-1']!.status).toBe('completed');
    expect(byPatch['patch-2']!.status).toBe('failed');
    expect(byPatch['patch-2']!.errorMessage).toBe('boom');
    // #4228 — the reboot policy is still evaluated on a partially failed run.
    expect(evaluateRebootPolicy).toHaveBeenCalledWith(DEVICE, 'always', true);
    expect(jobCounterUpdate()).toHaveProperty('devicesFailed');
  });
});

describe('checkAndFinalizeJob keeps a job open while devices are queued (OD-9)', () => {
  it('does not terminalise while devicesQueued > 0', async () => {
    vi.mocked(db.select).mockImplementationOnce(
      () =>
        limitChain([
          { status: 'running', devicesPending: 0, devicesQueued: 2, devicesFailed: 0 },
        ]) as any,
    );

    await checkAndFinalizeJob(JOB);

    expect(updates).toHaveLength(0);
  });

  it('terminalises once both counters are zero', async () => {
    vi.mocked(db.select).mockImplementationOnce(
      () =>
        limitChain([
          { status: 'running', devicesPending: 0, devicesQueued: 0, devicesFailed: 2 },
        ]) as any,
    );

    await checkAndFinalizeJob(JOB);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.values.status).toBe('failed');
  });
});

describe('deferred entry points', () => {
  it('patchJobIdFromPayload reads only a non-blank string', () => {
    expect(patchJobIdFromPayload({ patchJobId: JOB })).toBe(JOB);
    expect(patchJobIdFromPayload({ patchJobId: '  ' })).toBeNull();
    expect(patchJobIdFromPayload({})).toBeNull();
    expect(patchJobIdFromPayload(null)).toBeNull();
    expect(patchJobIdFromPayload([{ patchJobId: JOB }])).toBeNull();
  });

  it('finalizePatchDeviceForCommand resolves the device off the command row', async () => {
    vi.mocked(db.select)
      // deviceCommands lookup
      .mockImplementationOnce(() => limitChain([{ deviceId: DEVICE }]) as any)
      // existing rows
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      .mockImplementationOnce(() => limitChain([{ orgId: 'org-1', targets: {} }]) as any)
      .mockImplementationOnce(() => limitChain([]) as any);

    const result = await finalizePatchDeviceForCommand({
      commandId: COMMAND,
      payload: { patchJobId: JOB },
      terminal: { kind: 'timeout', message: 'no response from agent' },
      completedAt: new Date(),
    });

    expect(result).toEqual({ applied: true });
  });

  it('finalizePatchDeviceForCommand is a no-op for a payload with no patchJobId', async () => {
    const result = await finalizePatchDeviceForCommand({
      commandId: COMMAND,
      payload: { executionId: 'exec-1' },
      terminal: { kind: 'cancelled', reason: 'cancelled' },
      completedAt: new Date(),
    });

    expect(result).toEqual({ applied: false });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('handleInstallPatchesResult ignores a pre-W3 command with no patchJobId', async () => {
    await handleInstallPatchesResult({
      agentId: 'agent-1',
      command: { id: COMMAND, payload: { patchIds: ['patch-1'] } } as any,
      commandId: COMMAND,
      result: { status: 'completed' } as any,
      resolvedDeviceId: DEVICE,
      stdout: undefined,
    });

    expect(db.select).not.toHaveBeenCalled();
  });

  it('handleInstallPatchesResult does not double-count an online device the poll still owns', async () => {
    // The synchronous path writes no patch_job_results rows until
    // recordDeviceExecution runs, so an online device's result lands here first
    // with nothing to close. Counting it would decrement devices_pending twice.
    vi.mocked(db.select).mockImplementationOnce(() => whereChain([]) as any);

    await handleInstallPatchesResult({
      agentId: 'agent-1',
      command: { id: COMMAND, payload: { patchJobId: JOB } } as any,
      commandId: COMMAND,
      result: { status: 'completed', exitCode: 0 } as any,
      resolvedDeviceId: DEVICE,
      stdout: JSON.stringify({ success: true, installedCount: 1, failedCount: 0, results: [] }),
    });

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('handleInstallPatchesResult finalises the device the transport resolved', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => whereChain(queuedRows()) as any)
      .mockImplementationOnce(() => limitChain([{ orgId: 'org-1', targets: {} }]) as any)
      .mockImplementationOnce(
        () =>
          whereChain([
            { id: 'patch-1', externalId: 'KB1' },
            { id: 'patch-2', externalId: 'KB2' },
          ]) as any,
      )
      .mockImplementationOnce(() => limitChain([]) as any);

    await handleInstallPatchesResult({
      agentId: 'agent-1',
      command: { id: COMMAND, payload: { patchJobId: JOB } } as any,
      commandId: COMMAND,
      result: { status: 'completed', exitCode: 0 } as any,
      resolvedDeviceId: DEVICE,
      stdout: JSON.stringify({
        success: true,
        installedCount: 2,
        failedCount: 0,
        rebootRequired: false,
        results: [
          { id: 'patch-1', externalId: 'KB1', status: 'installed' },
          { id: 'patch-2', externalId: 'KB2', status: 'installed' },
        ],
      }),
    });

    const rowWrites = resultRowWrites();
    expect(rowWrites).toHaveLength(2);
    expect(rowWrites.every((u) => u.values.status === 'completed')).toBe(true);
    expect(jobCounterUpdate()).toHaveProperty('devicesCompleted');
  });
});
