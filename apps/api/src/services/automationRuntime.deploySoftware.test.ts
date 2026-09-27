import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDeploymentMock,
  latestMapMock,
  isCurrentMock,
  recordDispatchMock,
  claimActionDispatchesMock,
  stampClaimedActionOutcomeMock,
  readActionStateMock,
  reconcileRunMock,
} = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  latestMapMock: vi.fn(),
  isCurrentMock: vi.fn(),
  recordDispatchMock: vi.fn(),
  claimActionDispatchesMock: vi.fn(),
  stampClaimedActionOutcomeMock: vi.fn(),
  readActionStateMock: vi.fn(),
  reconcileRunMock: vi.fn(),
}));
vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createDeploymentMock }));
vi.mock('./softwareCurrency', () => ({
  resolveLatestVersionsByCatalogId: latestMapMock,
  latestVersionsFromResolvedAutomationReferences: vi.fn((resolved: any) => {
    const result = new Map();
    for (const [catalogId, version] of resolved.softwareVersionsByCatalogId) {
      const catalog = resolved.softwareCatalogsById.get(catalogId);
      if (catalog) result.set(catalogId, { version, catalogName: catalog.name });
    }
    return result;
  }),
  isDeviceSoftwareCurrent: isCurrentMock,
}));
vi.mock('./automationActionResults', () => ({
  recordAutomationActionDispatch: recordDispatchMock,
  claimAutomationActionDispatches: claimActionDispatchesMock,
  stampClaimedAutomationActionOutcome: stampClaimedActionOutcomeMock,
  readAutomationActionState: readActionStateMock,
  reconcileAutomationRun: reconcileRunMock,
}));

// Mock all transitive dependencies that automationRuntime.ts loads
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
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

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./deploymentEngine', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({ ok: false, code: 'insert_failed', error: 'mocked' }),
}));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { executeDeploySoftwareActions, normalizeAutomationActions } from './automationRuntime';

const WIN = { id: 'd-win', osType: 'windows' as const, orgId: 'org-1' };
const MAC = { id: 'd-mac', osType: 'macos' as const, orgId: 'org-1' };

beforeEach(() => {
  createDeploymentMock.mockReset().mockResolvedValue({
    deploymentId: 'dep-1',
    status: 'pending',
    dispatchedDeviceIds: ['d-win'],
    deviceResults: [{
      deviceId: 'd-win',
      deploymentResultId: 'result-win',
      status: 'delivered',
      deviceCommandId: null,
    }],
  });
  recordDispatchMock.mockReset().mockResolvedValue(true);
  claimActionDispatchesMock.mockReset().mockImplementation(async (input: { deviceIds: readonly string[] }) => ({
    runCancelled: false,
    claimed: [...new Set(input.deviceIds)].sort(),
    alreadyClaimed: new Map(),
  }));
  stampClaimedActionOutcomeMock.mockReset().mockResolvedValue(true);
  readActionStateMock.mockReset().mockResolvedValue(null);
  reconcileRunMock.mockReset().mockResolvedValue(undefined);
  isCurrentMock.mockReset().mockResolvedValue(false);
  latestMapMock.mockReset().mockResolvedValue(new Map([['cat-1', {
    version: { id: 'ver-1', catalogId: 'cat-1', version: '126.0.0', supportedOs: ['windows'] },
    catalogName: 'Chrome',
  }]]));
});

describe('normalizeAutomationActions — deploy_software', () => {
  it('normalizes a deploy_software action with camelCase catalogId', () => {
    const result = normalizeAutomationActions([{ type: 'deploy_software', catalogId: 'cat-abc' }]);
    expect(result).toEqual([{ type: 'deploy_software', catalogId: 'cat-abc' }]);
  });

  it('normalizes a deploy_software action with snake_case catalog_id', () => {
    const result = normalizeAutomationActions([{ type: 'deploy_software', catalog_id: 'cat-xyz' }]);
    expect(result).toEqual([{ type: 'deploy_software', catalogId: 'cat-xyz' }]);
  });

  it('throws AutomationValidationError when catalogId is missing', () => {
    expect(() => normalizeAutomationActions([{ type: 'deploy_software' }])).toThrow(
      'actions[0] deploy_software requires catalogId',
    );
  });

  it('throws AutomationValidationError for unknown action type', () => {
    expect(() => normalizeAutomationActions([{ type: 'unknown_action' }])).toThrow(
      'unsupported action type: unknown_action',
    );
  });
});

describe('executeDeploySoftwareActions', () => {
  it('dispatches from ownership-resolved catalog/version rows without a bare-ID reload', async () => {
    const args = {
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN],
      createdBy: null,
      runId: 'run-1',
      resolvedReferences: {
        scriptsById: new Map(),
        softwareCatalogsById: new Map([['cat-1', { id: 'cat-1', name: 'Resolved Chrome' }]]),
        softwareVersionsByCatalogId: new Map([['cat-1', {
          id: 'ver-resolved',
          catalogId: 'cat-1',
          version: '127.0.0',
          supportedOs: ['windows'],
        }]]),
        notificationChannelsById: new Map(),
      },
    } as any;

    const result = await executeDeploySoftwareActions(args);

    expect(latestMapMock).toHaveBeenCalledTimes(0);
    expect(createDeploymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ softwareVersionId: 'ver-resolved' }),
    );
    expect(result.failed).toBe(false);
  });

  it('deploys to an eligible Windows device and records a deployed log', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(1);
    expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual(['d-win']);
    expect(res.deployedDeviceIds.has('d-win')).toBe(true);
    expect(res.failed).toBe(false);
    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith({
      runId: 'run-1',
      deviceId: 'd-win',
      actionIndex: 0,
      status: 'delivered',
      deploymentResultId: 'result-win',
    });
  });

  it('preserves the normalized action index after filtering non-deployment actions', async () => {
    await executeDeploySoftwareActions({
      actions: [
        { type: 'execute_command', command: 'echo first' },
        { type: 'deploy_software', catalogId: 'cat-1' },
      ],
      devices: [WIN], createdBy: null, runId: 'run-1',
    });

    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'd-win',
      actionIndex: 1,
      deploymentResultId: 'result-win',
    }));
  });

  it('fails only the refused device action using its exact deployment result id', async () => {
    createDeploymentMock.mockResolvedValueOnce({
      deploymentId: 'dep-1',
      status: 'pending',
      dispatchedDeviceIds: ['d-win'],
      deviceResults: [
        { deviceId: 'd-win', deploymentResultId: 'result-win', status: 'delivered', deviceCommandId: null },
        { deviceId: 'd-mac', deploymentResultId: 'result-mac', status: 'failed', message: 'policy denied', deviceCommandId: null },
      ],
    });
    latestMapMock.mockResolvedValueOnce(new Map([['cat-1', {
      version: { id: 'ver-1', catalogId: 'cat-1', version: '1.0.0', supportedOs: [] },
      catalogName: 'CrossplatformTool',
    }]]));

    await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN, MAC], createdBy: null, runId: 'run-1',
    });

    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'd-win', status: 'delivered', deploymentResultId: 'result-win',
    }));
    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'd-mac', status: 'failed', deploymentResultId: 'result-mac', message: 'policy denied',
    }));
  });

  it('skips a device whose OS is unsupported and does not create a deployment', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [MAC], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /unsupported OS/i.test(l.message))).toBe(true);
  });

  it('deploys to all devices when supportedOs is null/empty (no OS restriction)', async () => {
    latestMapMock.mockResolvedValueOnce(new Map([['cat-1', {
      version: { id: 'ver-1', catalogId: 'cat-1', version: '1.0.0', supportedOs: null },
      catalogName: 'SomeCrossplatformTool',
    }]]));
    // #3189 — every claimed device must be stamped an outcome; the fixture's
    // shared default only accounts for 'd-win', so a real 2-device deployment
    // response needs both devices represented as dispatched.
    createDeploymentMock.mockResolvedValueOnce({
      deploymentId: 'dep-1',
      status: 'pending',
      dispatchedDeviceIds: ['d-win', 'd-mac'],
      deviceResults: [
        { deviceId: 'd-win', deploymentResultId: 'result-win', status: 'delivered', deviceCommandId: null },
        { deviceId: 'd-mac', deploymentResultId: 'result-mac', status: 'delivered', deviceCommandId: null },
      ],
    });
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN, MAC], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(1);
    expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual(
      expect.arrayContaining(['d-win', 'd-mac']),
    );
    expect(res.failed).toBe(false);
  });

  it('deploys to all devices when supportedOs is an empty array', async () => {
    latestMapMock.mockResolvedValueOnce(new Map([['cat-1', {
      version: { id: 'ver-1', catalogId: 'cat-1', version: '1.0.0', supportedOs: [] },
      catalogName: 'CrossplatformTool',
    }]]));
    createDeploymentMock.mockResolvedValueOnce({
      deploymentId: 'dep-1',
      status: 'pending',
      dispatchedDeviceIds: ['d-win', 'd-mac'],
      deviceResults: [
        { deviceId: 'd-win', deploymentResultId: 'result-win', status: 'delivered', deviceCommandId: null },
        { deviceId: 'd-mac', deploymentResultId: 'result-mac', status: 'delivered', deviceCommandId: null },
      ],
    });
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN, MAC], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(1);
    expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual(
      expect.arrayContaining(['d-win', 'd-mac']),
    );
    expect(res.failed).toBe(false);
  });

  it('skips a device that is already current', async () => {
    isCurrentMock.mockResolvedValue(true);
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /already current/i.test(l.message))).toBe(true);
  });

  it('marks failed when the catalog has no latest version', async () => {
    latestMapMock.mockResolvedValue(new Map());
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], createdBy: null, runId: 'run-1',
    });
    expect(res.failed).toBe(true);
    expect(res.logs.some(l => /no latest version/i.test(l.message))).toBe(true);
  });

  it('records dispatch outcomes outside an ambient database transaction', async () => {
    vi.mocked(runOutsideDbContext).mockClear();
    vi.mocked(withSystemDbAccessContext).mockClear();

    await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN],
      createdBy: null,
      runId: 'run-1',
      resolvedReferences: {
        scriptsById: new Map(),
        softwareCatalogsById: new Map(),
        softwareVersionsByCatalogId: new Map(),
        notificationChannelsById: new Map(),
      },
    } as any);

    expect(recordDispatchMock).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('creates one deployment per device org (partner-wide fan-out, #2133)', async () => {
    latestMapMock.mockResolvedValueOnce(new Map([['cat-1', {
      version: { id: 'ver-1', catalogId: 'cat-1', version: '1.0.0', supportedOs: null },
      catalogName: 'CrossOrgTool',
    }]]));
    const winOrg2 = { id: 'd-win-2', osType: 'windows' as const, orgId: 'org-2' };
    // #3189 — every claimed device needs a stamped outcome, so each per-org
    // deployment call must report its own device as dispatched.
    createDeploymentMock.mockResolvedValueOnce({
      deploymentId: 'dep-1',
      status: 'pending',
      dispatchedDeviceIds: ['d-win'],
      deviceResults: [{ deviceId: 'd-win', deploymentResultId: 'result-win', status: 'delivered', deviceCommandId: null }],
    }).mockResolvedValueOnce({
      deploymentId: 'dep-2',
      status: 'pending',
      dispatchedDeviceIds: ['d-win-2'],
      deviceResults: [{ deviceId: 'd-win-2', deploymentResultId: 'result-win-2', status: 'delivered', deviceCommandId: null }],
    });
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN, winOrg2], createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(2);
    const calls = createDeploymentMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: 'org-1', deviceIds: ['d-win'] }),
      expect.objectContaining({ orgId: 'org-2', deviceIds: ['d-win-2'] }),
    ]));
    expect(res.failed).toBe(false);
  });

  it('marks failed when createSoftwareDeployment returns status "failed"', async () => {
    // This exercises the same failed=true path that the executor wiring checks unconditionally,
    // ensuring a dispatch failure propagates to devicesFailed regardless of onFailure setting.
    createDeploymentMock.mockResolvedValue({ deploymentId: 'dep-err', status: 'failed', message: 'db error', dispatchedDeviceIds: [] });
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], createdBy: null, runId: 'run-1',
    });
    expect(res.failed).toBe(true);
    expect(res.logs.some(l => /deploy_software failed/i.test(l.message))).toBe(true);
    expect(res.deployedDeviceIds.size).toBe(0);
  });

  // #3189 — replay idempotency for the batched deploy_software pass.
  describe('replay idempotency (#3189)', () => {
    const D1 = { id: 'd1', osType: 'windows' as const, orgId: 'org-1' };
    const D2 = { id: 'd2', osType: 'windows' as const, orgId: 'org-1' };

    it('creates a deployment only for the newly-claimed device and reports the already-claimed one as replayed', async () => {
      const replayState = {
        status: 'queued' as const,
        commandId: 'c-first',
        scriptExecutionId: null,
        deploymentResultId: 'dr-first',
        agentRunId: null,
        message: null,
        error: null,
      };
      claimActionDispatchesMock.mockReset().mockResolvedValue({
        runCancelled: false,
        claimed: ['d1'],
        alreadyClaimed: new Map([['d2', replayState]]),
      });
      createDeploymentMock.mockResolvedValue({
        deploymentId: 'dep-1',
        status: 'pending',
        dispatchedDeviceIds: ['d1'],
        deviceResults: [{ deviceId: 'd1', deploymentResultId: 'result-d1', status: 'delivered', deviceCommandId: null }],
      });

      const res = await executeDeploySoftwareActions({
        actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
        devices: [D1, D2], createdBy: null, runId: 'run-1',
      });

      // Exercises: `createSoftwareDeployment` is called with ONLY the devices
      // `claimAutomationActionDispatches` returned as newly `claimed`, never the
      // already-claimed ones — the eligibility check ran for both devices, but
      // the claim (not eligibility) gates what gets a second deployment.
      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual(['d1']);
      expect(res.replayed).toEqual([{ deviceId: 'd2', actionIndex: 0, state: replayState }]);
      expect(res.deployedDeviceIds.has('d2')).toBe(false);
      expect(res.failedDeviceIds.has('d2')).toBe(false);
      expect(res.deployedDeviceIds.has('d1')).toBe(true);
      // Every claimed row gets exactly one stamp; an already-claimed device
      // must not be stamped a second time by this attempt.
      expect(stampClaimedActionOutcomeMock).toHaveBeenCalledTimes(1);
      expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd1' }));
    });

    it('creates no deployment and stamps nothing when every eligible device in the batch is already claimed', async () => {
      const state = (over: Record<string, unknown>) => ({
        status: 'queued' as const,
        commandId: 'c1',
        scriptExecutionId: null,
        deploymentResultId: 'dr1',
        agentRunId: null,
        message: null,
        error: null,
        ...over,
      });
      claimActionDispatchesMock.mockReset().mockResolvedValue({
        runCancelled: false,
        claimed: [],
        alreadyClaimed: new Map([
          ['d1', state({ commandId: 'c1', deploymentResultId: 'dr1' })],
          ['d2', state({ commandId: 'c2', deploymentResultId: 'dr2' })],
        ]),
      });

      const res = await executeDeploySoftwareActions({
        actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
        devices: [D1, D2], createdBy: null, runId: 'run-1',
      });

      // Exercises the `if (claims.claimed.length === 0) return { claims, result: null };`
      // early-out: createSoftwareDeployment (and therefore any stamp) must never
      // be reached when the whole batch was already claimed.
      expect(createDeploymentMock).not.toHaveBeenCalled();
      expect(stampClaimedActionOutcomeMock).not.toHaveBeenCalled();
      expect(res.replayed.map((r) => r.deviceId).sort()).toEqual(['d1', 'd2']);
      expect(res.deployedDeviceIds.size).toBe(0);
      expect(res.failedDeviceIds.size).toBe(0);
    });

    it('propagates a RunCancelledError when the claim reports the run cancelled', async () => {
      claimActionDispatchesMock.mockReset().mockResolvedValue({
        runCancelled: true,
        claimed: [],
        alreadyClaimed: new Map(),
      });

      // Exercises `if (claims.runCancelled) throw new RunCancelledError(args.runId);` —
      // a cancelled run must abort the batch, not silently skip the device.
      await expect(executeDeploySoftwareActions({
        actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
        devices: [D1], createdBy: null, runId: 'run-1',
      })).rejects.toMatchObject({ name: 'RunCancelledError' });
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('reuses another attempt\'s unsupported-OS skip instead of re-recording or re-logging it', async () => {
      // recordAutomationActionDispatch (onlyFromPending) loses the CAS: some
      // other attempt already wrote a non-pending outcome for this device+action.
      recordDispatchMock.mockResolvedValueOnce(false);
      const skipState = {
        status: 'skipped' as const,
        commandId: null,
        scriptExecutionId: null,
        deploymentResultId: null,
        agentRunId: null,
        message: 'Software is not supported on this device OS',
        error: null,
      };
      readActionStateMock.mockResolvedValueOnce(skipState);

      const res = await executeDeploySoftwareActions({
        actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
        devices: [MAC], createdBy: null, runId: 'run-1',
      });

      // Exercises `recordUnclaimedOutcome`'s losing-CAS branch: `state.status !==
      // 'pending'` -> push to `replayed`, return false, and the caller's
      // `if (await recordUnclaimedOutcome(...)) { logs.push(...) }` must then
      // NOT log — that log line is this attempt's own claim of the outcome.
      expect(res.replayed).toEqual([{ deviceId: 'd-mac', actionIndex: 0, state: skipState }]);
      expect(res.logs.some((l) => /unsupported OS/i.test(l.message))).toBe(false);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });
  });
});
