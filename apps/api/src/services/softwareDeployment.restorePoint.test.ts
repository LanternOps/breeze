import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so the mock factories can reference the mocks
//
// #5128: dispatchSoftwareInstallToDevice no longer calls sendCommandToAgent /
// queueCommand itself — it goes through dispatchDeviceCommand (the single
// enqueue seam in ./dispatchDeviceCommand), which persists the device_commands
// row BEFORE any transport and pushes over the socket itself. Mocking that one
// seam is the whole story for this file's install-dispatch path; the real
// sendCommandToAgent/queueCommand implementations live one layer down inside
// dispatchDeviceCommand.ts and are exercised by that module's own test suite.
const { dispatchDeviceCommandMock } = vi.hoisted(() => ({
  dispatchDeviceCommandMock: vi.fn(),
}));

// Wave 6 Task 5: the dispatch path reads the org ∪ site approved-private-origin
// allowlist through this service. Mocked here (it is DB-backed and proven in its
// own suite) so these tests control the effective policy per device/site; the
// GATE itself (services/managedSoftwareDispatchPolicy.ts) is deliberately NOT
// mocked, so every capability/mode assertion below exercises the real decision.
const { effectivePolicyMock } = vi.hoisted(() => ({ effectivePolicyMock: vi.fn() }));
vi.mock('./softwareDownloadPolicy', () => ({
  getEffectiveSoftwareDownloadPolicy: effectivePolicyMock,
}));

// The ONE enqueue seam (#5128 §D). Mocked wholesale — softwareDeployment.ts's
// own contract is "call this with the right deviceId/type/payload/policy and
// react to ok/delivery correctly", not the seam's internal WS-vs-queue
// mechanics (device lookup, trust checks, claim/push/release), which belong
// to dispatchDeviceCommand.test.ts.
vi.mock('./dispatchDeviceCommand', () => ({ dispatchDeviceCommand: dispatchDeviceCommandMock }));

vi.mock('../services/s3Storage', () => ({
  getPresignedUrl: vi.fn(async () => 'https://signed.example/pkg.exe'),
  isS3Configured: () => true,
  isS3NotFound: () => false,
}));

vi.mock('../services/edrInstallerResolver', () => ({
  resolveEdrInstaller: vi.fn().mockResolvedValue({
    downloadUrl: 'https://edr.example/pkg.exe',
    silentInstallArgs: null,
  }),
}));

// Drizzle db mock — capture calls and serve controlled per-test data.
// Follows the chainable-mock pattern from apps/api/src/services/*.test.ts.
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
  // tenantVariableResolution.ts (#3409 PR2) requires both wrappers around its
  // query; pass-throughs here mirror the pattern already used by
  // routes/scripts.test.ts and tenantVariableResolution.test.ts.
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// Wrap drizzle's condition builders in spies (behavior preserved) so tests can
// assert the scopeToDeviceIds WHERE filters, not just that a write ran.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, inArray: vi.fn(actual.inArray), eq: vi.fn(actual.eq) };
});

vi.mock('../db/schema', () => ({
  softwareCatalog: {
    id: 'sc.id',
    orgId: 'sc.orgId',
    name: 'sc.name',
    integrationProvider: 'sc.integrationProvider',
  },
  softwareVersions: { id: 'sv.id', catalogId: 'sv.catalogId' },
  softwareDeployments: { id: 'sd.id', orgId: 'sd.orgId', softwarePolicyId: 'sd.softwarePolicyId' },
  deploymentResults: {
    deploymentId: 'dr.deploymentId',
    deviceId: 'dr.deviceId',
    status: 'dr.status',
  },
  devices: {
    id: 'd.id',
    orgId: 'd.orgId',
    agentId: 'd.agentId',
    siteId: 'd.siteId',
    hostname: 'd.hostname',
    customFields: 'd.customFields',
    osType: 'd.osType',
  },
  softwareInstallMethods: {
    id: 'sim.id',
    catalogId: 'sim.catalogId',
    platform: 'sim.platform',
    kind: 'sim.kind',
    packageId: 'sim.packageId',
    enabled: 'sim.enabled',
  },
  organizations: { id: 'o.id', name: 'o.name', partnerId: 'o.partnerId' },
  sites: { id: 's.id', name: 's.name', orgId: 's.orgId' },
  // tenantVariableResolution.ts's scope query (#3409 PR2) joins these two.
  tenantVariables: {
    id: 'tv.id',
    key: 'tv.key',
    value: 'tv.value',
    isSecret: 'tv.isSecret',
    version: 'tv.version',
    orgId: 'tv.orgId',
    partnerId: 'tv.partnerId',
  },
}));

vi.mock('./restorePointRequest', () => ({
  buildRestorePointRequest: vi.fn(),
  linkRestorePointCommand: vi.fn(),
  discardRestorePointRequest: vi.fn(),
  restorePointPayloadField: (block: unknown) => (block ? { restorePoint: block } : {}),
}));

import { buildAndDispatchSoftwareInstalls } from './softwareDeployment';
import {
  buildRestorePointRequest,
  discardRestorePointRequest,
  linkRestorePointCommand,
} from './restorePointRequest';

function sel(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) };
}

const catalogItem = { name: 'TestApp', integrationProvider: null };
const versionRecord = {
  downloadUrl: 'https://dl.example/pkg.exe',
  s3Key: null,
  checksum: null,
  originalFileName: 'pkg.exe',
  fileType: 'exe',
  silentInstallArgs: '/S',
  version: '1.0.0',
  detectionRules: null,
};
const installMethod = {
  id: 'sim-1',
  catalogId: 'cat-1',
  platform: 'windows',
  kind: 'winget',
  packageId: 'Google.Chrome',
};

function blockFor(requestId: string) {
  return {
    v: 1 as const,
    requestId,
    enabled: true,
    label: 'Breeze: install TestApp',
    resolvedAt: '2026-10-12T00:00:00.000Z',
    policyRevision: 'rev-1',
    validUntil: '2026-10-13T00:00:00.000Z',
  };
}

function lastPayload(): Record<string, any> {
  const calls = dispatchDeviceCommandMock.mock.calls;
  return calls[calls.length - 1]![0].payload;
}

async function dispatchManaged(retryCount = 0) {
  selectMock.mockReturnValueOnce(sel([{ id: 'dev-a', agentId: 'agent-a', osType: 'windows' }]));
  return buildAndDispatchSoftwareInstalls({
    deploymentId: 'dep-1',
    orgId: 'org-1',
    installMethod,
    catalogItem,
    deviceIds: ['dev-a'],
    options: null,
    createdBy: null,
    markDispatched: false,
    deviceRetryCounts: { 'dev-a': retryCount },
  });
}

async function dispatchDownload(osType: string | null = 'windows') {
  selectMock.mockReturnValueOnce(sel([{ id: 'dev-a', agentId: 'agent-a', siteId: 'site-1', osType }]));
  return buildAndDispatchSoftwareInstalls({
    deploymentId: 'dep-1',
    orgId: 'org-1',
    versionRecord,
    catalogItem,
    deviceIds: ['dev-a'],
    options: null,
    createdBy: null,
    markDispatched: false,
  });
}

describe('software_install restore-point stamping (#4756)', () => {
  beforeEach(() => {
    dispatchDeviceCommandMock.mockReset();
    selectMock.mockReset();
    updateMock.mockReset();
    vi.mocked(buildRestorePointRequest).mockReset();
    vi.mocked(linkRestorePointCommand).mockReset();
    vi.mocked(discardRestorePointRequest).mockReset();
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
    effectivePolicyMock.mockResolvedValue({ approvedPrivateOrigins: [] });
    updateMock.mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps at BOTH payload builders (managed installMethod and download URL)', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValue(blockFor('req-1'));
    await dispatchManaged();
    expect(lastPayload().restorePoint).toEqual(blockFor('req-1'));
    expect(lastPayload()).toHaveProperty('installMethod');
    await dispatchDownload();
    expect(lastPayload().restorePoint).toEqual(blockFor('req-1'));
    expect(lastPayload()).toHaveProperty('downloadUrl');
  });

  it('resolves with the software_install trigger, deployment id and device osType', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    await dispatchDownload('Windows');
    expect(buildRestorePointRequest).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-a',
      orgId: 'org-1',
      osType: 'Windows',
      trigger: 'software_install',
      label: 'install TestApp',
      softwareDeploymentId: 'dep-1',
    }));
  });

  it('adds no key when the chokepoint returns null', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    await dispatchManaged();
    expect('restorePoint' in lastPayload()).toBe(false);
    await dispatchDownload();
    expect('restorePoint' in lastPayload()).toBe(false);
  });

  it('links the created command id onto the ledger row', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValue(blockFor('req-1'));
    await dispatchManaged();
    expect(linkRestorePointCommand).toHaveBeenCalledWith(blockFor('req-1'), 'cmd-dev-a');
  });

  it('a resolution failure fails that device visibly and dispatches nothing', async () => {
    vi.mocked(buildRestorePointRequest).mockRejectedValue(new Error('db down'));
    const result = await dispatchManaged();
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    expect(result.dispatchedDeviceIds).toEqual([]);
  });

  it('discards the requested row when the dispatch seam refuses', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValue(blockFor('req-1'));
    dispatchDeviceCommandMock.mockReset();
    dispatchDeviceCommandMock.mockResolvedValue({ ok: false, code: 'device_decommissioned', error: 'gone' });
    await dispatchManaged();
    expect(discardRestorePointRequest).toHaveBeenCalledWith(blockFor('req-1'));
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
  });

  it('a new retry attempt re-resolves and gets a fresh requestId', async () => {
    // Each business attempt (retryCount bump -> new command id) re-enters the
    // builder and so re-resolves; transport redelivery of the SAME command id
    // never re-enters this code and keeps the frozen payload.
    vi.mocked(buildRestorePointRequest)
      .mockResolvedValueOnce(blockFor('req-attempt-0'))
      .mockResolvedValueOnce(blockFor('req-attempt-1'));
    await dispatchManaged(0);
    const first = lastPayload().restorePoint.requestId;
    await dispatchManaged(1);
    expect(lastPayload().retryCount).toBe(1);
    expect(lastPayload().restorePoint.requestId).not.toBe(first);
    expect(buildRestorePointRequest).toHaveBeenCalledTimes(2);
  });
});
