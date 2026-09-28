import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #7187 — a deploy_software action must not push its software_install
 * commands before the transaction that created them commits.
 *
 * `executeDeploySoftwareActions` claims, creates and stamps each org batch in
 * ONE short transaction (#3189). `createSoftwareDeployment` INSERTs the
 * deployment, its result rows and the device_commands rows through that
 * transaction. If it also pushes the command to a live agent inside it, a fast
 * agent can answer before the commit: the result path reads device_commands on
 * its own connection, finds nothing, and drops the result as an orphan. Same
 * class as #3445 for run_script.
 *
 * Transactions here carry an identity, because the batch transaction is opened
 * with `runOutsideDbContext` and so commits on its own even while a caller's
 * device-lock transaction is still open around it. The contract: every push
 * happens after the transaction that created its rows has closed, with no
 * ambient context, and a batch that rolls back pushes nothing.
 */

const txState = vi.hoisted(() => ({
  depth: 0,
  current: null as null | number,
  nextId: 1,
  closed: new Set<number>(),
}));

const {
  createDeploymentMock,
  recordDispatchMock,
  claimActionDispatchesMock,
  stampClaimedActionOutcomeMock,
  readActionStateMock,
  reconcileRunMock,
  isCurrentMock,
} = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  recordDispatchMock: vi.fn(),
  claimActionDispatchesMock: vi.fn(),
  stampClaimedActionOutcomeMock: vi.fn(),
  readActionStateMock: vi.fn(),
  reconcileRunMock: vi.fn(),
  isCurrentMock: vi.fn(),
}));

vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createDeploymentMock }));
vi.mock('./softwareCurrency', () => ({
  resolveLatestVersionsByCatalogId: vi.fn(),
  latestVersionsFromResolvedAutomationReferences: vi.fn(() => new Map([['cat-1', {
    version: { id: 'ver-1', catalogId: 'cat-1', version: '126.0.0', supportedOs: ['windows'] },
    catalogName: 'Chrome',
  }]])),
  isDeviceSoftwareCurrent: isCurrentMock,
}));
vi.mock('./automationActionResults', () => ({
  recordAutomationActionDispatch: recordDispatchMock,
  claimAutomationActionDispatches: claimActionDispatchesMock,
  stampClaimedAutomationActionOutcome: stampClaimedActionOutcomeMock,
  readAutomationActionState: readActionStateMock,
  reconcileAutomationRun: reconcileRunMock,
}));

vi.mock('../db', () => ({
  // Hides the ambient transaction (the real ALS semantics) without closing it.
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const saved = { depth: txState.depth, current: txState.current };
    txState.depth = 0;
    txState.current = null;
    try {
      return await fn();
    } finally {
      txState.depth = saved.depth;
      txState.current = saved.current;
    }
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  // Joins an ambient transaction, otherwise opens (and on return closes) one.
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    if (txState.depth > 0) {
      txState.depth += 1;
      try {
        return await fn();
      } finally {
        txState.depth -= 1;
      }
    }
    const id = txState.nextId++;
    txState.depth = 1;
    txState.current = id;
    try {
      return await fn();
    } finally {
      txState.depth = 0;
      txState.current = null;
      txState.closed.add(id);
    }
  }),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName' },
  scripts: { id: 'id', deletedAt: 'deletedAt' },
  notificationChannels: { id: 'id', orgId: 'orgId' },
  automations: { id: 'id', runCount: 'runCount', lastRunAt: 'lastRunAt', updatedAt: 'updatedAt' },
  alerts: { id: 'id' },
  alertRules: { id: 'id', orgId: 'orgId', name: 'name', targetType: 'targetType', targetId: 'targetId' },
  alertTemplates: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./deploymentEngine', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: vi.fn() }));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { withSystemDbAccessContext } from '../db';
import { executeDeploySoftwareActions } from './automationRuntime';

const WIN_ONLINE = { id: 'd-live', osType: 'windows' as const, orgId: 'org-1' };
const WIN_OFFLINE = { id: 'd-offline', osType: 'windows' as const, orgId: 'org-1' };

type Recorded = { event: 'rows_created' | 'pushed'; tx: number | null; depth: number; deviceId?: string };

/**
 * A stand-in for createSoftwareDeployment honouring its contract: rows are
 * written in the caller's transaction, and live-agent pushes happen inline
 * (default) or in `deliver()` (deferDelivery). d-offline is never pushed.
 */
function fakeCreateDeployment(events: Recorded[]) {
  return async (input: { deviceIds: string[]; deferDelivery?: boolean }) => {
    events.push({ event: 'rows_created', tx: txState.current, depth: txState.depth });
    const live = input.deviceIds.filter((id) => id === WIN_ONLINE.id);
    const push = () => {
      for (const deviceId of live) {
        events.push({ event: 'pushed', tx: txState.current, depth: txState.depth, deviceId });
      }
      return { deliveredDeviceIds: live };
    };
    const deviceResults = input.deviceIds.map((deviceId) => ({
      deviceId,
      deploymentResultId: `result-${deviceId}`,
      status: (!input.deferDelivery && live.includes(deviceId) ? 'delivered' : 'queued') as 'delivered' | 'queued',
      deviceCommandId: `cmd-${deviceId}`,
    }));
    const base = { deploymentId: 'dep-1', status: 'pending' as const, dispatchedDeviceIds: input.deviceIds, deviceResults };
    if (input.deferDelivery) return { ...base, deliver: async () => push() };
    push();
    return base;
  };
}

function run(devices = [WIN_ONLINE, WIN_OFFLINE]) {
  return executeDeploySoftwareActions({
    actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
    devices,
    createdBy: null,
    runId: 'run-1',
    resolvedReferences: {} as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.depth = 0;
  txState.current = null;
  txState.nextId = 1;
  txState.closed.clear();
  recordDispatchMock.mockResolvedValue(true);
  claimActionDispatchesMock.mockImplementation(async (input: { deviceIds: readonly string[] }) => ({
    runCancelled: false,
    claimed: [...new Set(input.deviceIds)].sort(),
    alreadyClaimed: new Map(),
  }));
  stampClaimedActionOutcomeMock.mockResolvedValue(true);
  readActionStateMock.mockResolvedValue(null);
  reconcileRunMock.mockResolvedValue(undefined);
  isCurrentMock.mockResolvedValue(false);
});

describe('executeDeploySoftwareActions — commit before send (#7187)', () => {
  it('pushes a live device only after the batch transaction that created its command has committed', async () => {
    const events: Recorded[] = [];
    createDeploymentMock.mockImplementation(fakeCreateDeployment(events));

    await run();

    const created = events.find((e) => e.event === 'rows_created');
    const pushed = events.find((e) => e.event === 'pushed');
    expect(created?.tx).not.toBeNull();
    expect(pushed).toBeDefined();
    expect(pushed?.deviceId).toBe(WIN_ONLINE.id);
    // Not inside the creating transaction, and no transaction is ambient.
    expect(pushed?.tx).toBeNull();
    expect(pushed?.depth).toBe(0);
    expect(txState.closed.has(created!.tx!)).toBe(true);
    expect(events.indexOf(pushed!)).toBeGreaterThan(events.indexOf(created!));
    expect(createDeploymentMock).toHaveBeenCalledWith(expect.objectContaining({ deferDelivery: true }));
  });

  it('pushes only after commit even when a caller holds a device-lock transaction around the pass', async () => {
    const events: Recorded[] = [];
    createDeploymentMock.mockImplementation(fakeCreateDeployment(events));

    // The ordered loop wraps the pass in its own lock transaction.
    await vi.mocked(withSystemDbAccessContext)(() => run());

    const created = events.find((e) => e.event === 'rows_created');
    const pushed = events.find((e) => e.event === 'pushed');
    expect(created?.tx).not.toBe(1); // its own batch transaction, not the lock's
    expect(pushed?.tx).toBeNull();
    expect(pushed?.depth).toBe(0);
    expect(txState.closed.has(created!.tx!)).toBe(true);
  });

  it('stamps queued in the batch transaction, then upgrades the pushed device to delivered after commit', async () => {
    createDeploymentMock.mockImplementation(fakeCreateDeployment([]));

    const out = await run();

    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: WIN_ONLINE.id, status: 'queued', commandId: `cmd-${WIN_ONLINE.id}`,
    }));
    expect(recordDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      deviceId: WIN_ONLINE.id,
      actionIndex: 0,
      status: 'delivered',
      commandId: `cmd-${WIN_ONLINE.id}`,
      deploymentResultId: `result-${WIN_ONLINE.id}`,
    }));
    // The offline device stays queued for the heartbeat claim.
    expect(recordDispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: WIN_OFFLINE.id }));
    expect(out.deployedDeviceIds).toEqual(new Set([WIN_ONLINE.id, WIN_OFFLINE.id]));
    expect(out.failedDeviceIds.size).toBe(0);
  });

  it('a batch that rolls back pushes nothing', async () => {
    const events: Recorded[] = [];
    createDeploymentMock.mockImplementation(fakeCreateDeployment(events));
    stampClaimedActionOutcomeMock.mockResolvedValue(false);

    await expect(run()).rejects.toThrow('Automation action claim was not stamped');

    expect(events.map((e) => e.event)).toEqual(['rows_created']);
  });
});
