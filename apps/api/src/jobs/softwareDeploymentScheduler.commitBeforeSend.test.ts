import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7347 — the software deployment scheduler must not push a `software_install`
 * command to a live agent before the transaction that created its
 * `device_commands` row has committed.
 *
 * `processDueDeployment` claims the deployment and runs the install fan-out in
 * one system transaction. The agent result path reads `device_commands` on its
 * own connection, so a push made inside that transaction lets a fast agent
 * answer a row it cannot see yet, and the result is dropped as an orphan. Same
 * class as #7187 (automation deploy_software), #7103 / #7109 (Run Script).
 *
 * Proven here through the real tick: the fan-out runs with the transaction open
 * and `deferDelivery` set, the returned `deliver()` runs with no transaction
 * open, and a transaction that fails to commit delivers nothing.
 */

// `depth`: the ambient context as AsyncLocalStorage would report it.
// `open`: transactions still uncommitted anywhere in the process.
// `failNextCommit`: the next outermost transaction throws after `fn` settles.
const txState = vi.hoisted(() => ({ depth: 0, open: 0, failNextCommit: false }));

const { selectMock, updateMock, buildAndDispatchMock, events } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  buildAndDispatchMock: vi.fn(),
  events: [] as Array<{ event: string; depth: number; open: number }>,
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const opensTransaction = txState.depth === 0;
    txState.depth += 1;
    if (opensTransaction) txState.open += 1;
    try {
      const result = await fn();
      if (opensTransaction && txState.failNextCommit) {
        txState.failNextCommit = false;
        throw new Error('commit failed');
      }
      return result;
    } finally {
      txState.depth -= 1;
      if (opensTransaction) txState.open -= 1;
    }
  }),
}));

vi.mock('../db/schema', () => ({
  softwareDeployments: { id: 'sd.id', dispatchedAt: 'sd.dispatched_at' },
  deploymentResults: { deploymentId: 'dr.deployment_id', deviceId: 'dr.device_id', status: 'dr.status' },
  maintenanceWindows: {},
  softwareVersions: { id: 'sv.id' },
  softwareCatalog: { id: 'sc.id', name: 'sc.name', integrationProvider: 'sc.ip' },
  softwareInstallMethods: { id: 'sim.id' },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/softwareDeployment', () => ({
  buildAndDispatchSoftwareInstalls: (...args: unknown[]) => buildAndDispatchMock(...(args as [])),
}));

import { runSoftwareDeploymentSchedulerTick, type DueDeploymentCandidate } from './softwareDeploymentScheduler';
import {
  fingerprintSoftwareInstallMethodDependency,
  fingerprintSoftwareVersionDependency,
} from '../services/softwareDependencyIdentity';

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

function claimChain(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
        returning: vi.fn().mockResolvedValue(rows),
      })),
    })),
  };
}

const versionRecord = {
  id: 'ver-1',
  catalogId: 'cat-1',
  version: '1.0.0',
  downloadUrl: 'https://downloads.example.test/app.exe',
  s3Key: null,
  checksum: null,
  originalFileName: 'app.exe',
  fileType: 'exe',
  silentInstallArgs: '/S',
  detectionRules: null,
};
const installMethod = {
  id: 'method-1',
  catalogId: 'cat-1',
  platform: 'windows',
  kind: 'winget',
  packageId: 'Vendor.App',
};
const catalogItem = { id: 'cat-1', name: 'TestApp', integrationProvider: null };

function candidate(overrides: Partial<DueDeploymentCandidate> = {}): DueDeploymentCandidate {
  return {
    id: 'dep-1',
    orgId: 'org-1',
    softwareVersionId: 'ver-1',
    scheduleType: 'scheduled',
    scheduledAt: new Date(Date.now() - 60_000),
    options: null,
    dependencyFingerprint: fingerprintSoftwareVersionDependency(versionRecord as never, catalogItem),
    createdBy: 'user-1',
    windowStatus: null,
    windowStartTime: null,
    windowEndTime: null,
    ...overrides,
  };
}

function queueVersionPath() {
  selectMock
    .mockReturnValueOnce(selectChain([candidate()]))
    .mockReturnValueOnce(selectChain([{ deviceId: 'dev-1' }, { deviceId: 'dev-2' }]))
    .mockReturnValueOnce(selectChain([versionRecord]))
    .mockReturnValueOnce(selectChain([catalogItem]));
  updateMock.mockReturnValueOnce(claimChain([{ id: 'dep-1' }]));
}

function queueManagerPath() {
  selectMock
    .mockReturnValueOnce(selectChain([candidate({
      softwareVersionId: null,
      installMethodId: 'method-1',
      dependencyFingerprint: fingerprintSoftwareInstallMethodDependency(installMethod as never, catalogItem),
    } as Partial<DueDeploymentCandidate>)]))
    .mockReturnValueOnce(selectChain([{ deviceId: 'dev-1' }]))
    .mockReturnValueOnce(selectChain([installMethod]))
    .mockReturnValueOnce(selectChain([catalogItem]));
  updateMock.mockReturnValueOnce(claimChain([{ id: 'dep-1' }]));
}

const deliverMock = vi.fn();

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  buildAndDispatchMock.mockReset();
  deliverMock.mockReset();
  txState.depth = 0;
  txState.open = 0;
  txState.failNextCommit = false;
  events.length = 0;
  buildAndDispatchMock.mockImplementation(async () => {
    events.push({ event: 'fanout', depth: txState.depth, open: txState.open });
    return { status: 'pending', dispatchedDeviceIds: ['dev-1'], deviceResults: [], deliver: deliverMock };
  });
  deliverMock.mockImplementation(async () => {
    events.push({ event: 'deliver', depth: txState.depth, open: txState.open });
    return { deliveredDeviceIds: ['dev-1'] };
  });
});

describe('software deployment scheduler pushes only after the claim transaction commits (#7347)', () => {
  it.each([
    ['version', queueVersionPath],
    ['package-manager', queueManagerPath],
  ])('%s deployment: fans out deferred inside the transaction, delivers after it commits', async (_name, queue) => {
    queue();

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    expect(buildAndDispatchMock).toHaveBeenCalledWith(expect.objectContaining({ deferDelivery: true }));
    const fanout = events.find((e) => e.event === 'fanout');
    const deliver = events.find((e) => e.event === 'deliver');
    expect(fanout).toMatchObject({ open: 1 });
    expect(deliver).toMatchObject({ depth: 0, open: 0 });
    expect(events.indexOf(deliver!)).toBeGreaterThan(events.indexOf(fanout!));
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('a claim transaction that rolls back pushes nothing', async () => {
    queueVersionPath();
    // The candidates read is the first outermost transaction; fail the SECOND
    // (the claim + fan-out) instead.
    const { withSystemDbAccessContext } = await import('../db');
    const real = vi.mocked(withSystemDbAccessContext).getMockImplementation()!;
    let calls = 0;
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn) => {
      calls += 1;
      txState.failNextCommit = calls === 2;
      return real(fn as () => Promise<unknown>) as never;
    });

    const result = await runSoftwareDeploymentSchedulerTick();

    vi.mocked(withSystemDbAccessContext).mockImplementation(real as never);
    expect(result).toEqual({ claimed: 0, skipped: 0, errors: 1 });
    expect(buildAndDispatchMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('a fan-out with nothing to push (offline devices) needs no continuation', async () => {
    queueVersionPath();
    buildAndDispatchMock.mockResolvedValueOnce({ status: 'pending', dispatchedDeviceIds: ['dev-1'], deviceResults: [] });

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
