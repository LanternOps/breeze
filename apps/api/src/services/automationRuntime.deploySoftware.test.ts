import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDeploymentMock, latestMapMock, isCurrentMock } = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  latestMapMock: vi.fn(),
  isCurrentMock: vi.fn(),
}));
vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createDeploymentMock }));
vi.mock('./softwareCurrency', () => ({
  resolveLatestVersionsByCatalogId: latestMapMock,
  isDeviceSoftwareCurrent: isCurrentMock,
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

vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script' },
  queueCommandForExecution: vi.fn().mockResolvedValue({ command: null, error: 'mocked' }),
}));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { executeDeploySoftwareActions } from './automationRuntime';

const WIN = { id: 'd-win', osType: 'windows' as const };
const MAC = { id: 'd-mac', osType: 'macos' as const };

beforeEach(() => {
  createDeploymentMock.mockReset().mockResolvedValue({ deploymentId: 'dep-1', status: 'pending', dispatchedDeviceIds: ['d-win'] });
  isCurrentMock.mockReset().mockResolvedValue(false);
  latestMapMock.mockReset().mockResolvedValue(new Map([['cat-1', {
    version: { id: 'ver-1', catalogId: 'cat-1', version: '126.0.0', supportedOs: ['windows'] },
    catalogName: 'Chrome',
  }]]));
});

describe('executeDeploySoftwareActions', () => {
  it('deploys to an eligible Windows device and records a deployed log', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(1);
    expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual(['d-win']);
    expect(res.deployedDeviceIds.has('d-win')).toBe(true);
    expect(res.failed).toBe(false);
  });

  it('skips a device whose OS is unsupported and does not create a deployment', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [MAC], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /unsupported OS/i.test(l.message))).toBe(true);
  });

  it('skips a device that is already current', async () => {
    isCurrentMock.mockResolvedValue(true);
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /already current/i.test(l.message))).toBe(true);
  });

  it('marks failed when the catalog has no latest version', async () => {
    latestMapMock.mockResolvedValue(new Map());
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(res.failed).toBe(true);
    expect(res.logs.some(l => /no latest version/i.test(l.message))).toBe(true);
  });

  it('marks failed when createSoftwareDeployment returns status "failed"', async () => {
    // This exercises the same failed=true path that the executor wiring checks unconditionally,
    // ensuring a dispatch failure propagates to devicesFailed regardless of onFailure setting.
    createDeploymentMock.mockResolvedValue({ deploymentId: 'dep-err', status: 'failed', message: 'db error', dispatchedDeviceIds: [] });
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(res.failed).toBe(true);
    expect(res.logs.some(l => /deploy_software failed/i.test(l.message))).toBe(true);
    expect(res.deployedDeviceIds.size).toBe(0);
  });
});
