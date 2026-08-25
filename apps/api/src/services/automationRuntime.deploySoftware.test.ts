import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDeploymentMock, latestMapMock, isCurrentMock, recordDispatchMock } = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  latestMapMock: vi.fn(),
  isCurrentMock: vi.fn(),
  recordDispatchMock: vi.fn(),
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
    expect(recordDispatchMock).toHaveBeenCalledWith({
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

    expect(recordDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
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

    expect(recordDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'd-win', status: 'delivered', deploymentResultId: 'result-win',
    }));
    expect(recordDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
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
});
