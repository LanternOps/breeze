import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so the mock factories can reference the mocks
const { sendCommandMock, queueCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  queueCommandMock: vi.fn(),
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

// Match the exact import paths used by routes/software.ts (and the service will mirror them)
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: sendCommandMock }));

// Offline fallback path (dispatchSoftwareInstallToDevice)
vi.mock('./commandQueue', () => ({ queueCommand: queueCommandMock }));

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
  softwareDeployments: { id: 'sd.id', orgId: 'sd.orgId' },
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
  },
  organizations: { id: 'o.id', name: 'o.name' },
  sites: { id: 's.id', name: 's.name', orgId: 's.orgId' },
}));

import {
  buildAndDispatchSoftwareInstalls,
  createSoftwareDeployment,
  dispatchSoftwareInstallToDevice,
} from './softwareDeployment';
import { resolveEdrInstaller } from './edrInstallerResolver';
import { inArray } from 'drizzle-orm';

const resolveEdrMock = vi.mocked(resolveEdrInstaller);

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

/** Chainable select: db.select().from().where() → Promise<rows> */
function sel(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

/** Chainable select ending in .limit(): db.select().from().where().limit() → Promise<rows> */
function selLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

/** Insert with .returning() — for softwareDeployments */
function insWithReturning(rows: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  };
}

/** Insert without .returning() — for deploymentResults */
function ins() {
  return { values: vi.fn().mockResolvedValue([]) };
}

/** Update chain: db.update().set().where() → void */
function upd() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

/**
 * Every .set() payload passed to db.update() in the current test, in call
 * order. The default updateMock implementation (see beforeEach) records here,
 * so tests can distinguish the dispatched_at claim write, per-device failure
 * pre-writes, and device_command_id link writes without counting raw calls.
 */
let updateSetCalls: Record<string, unknown>[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSoftwareDeployment', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    queueCommandMock.mockReset();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    // Defaults: agent is online (WS delivery succeeds), and the offline
    // fallback returns a queued device_commands row when exercised.
    sendCommandMock.mockReturnValue(true);
    queueCommandMock.mockResolvedValue({ id: 'queued-cmd-1' });
    // Default capturing update chain — individual tests may still override
    // with mockReturnValue/mockReturnValueOnce.
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    // Wave 6 Task 5: default every device to an unrestricted allowlist so
    // pre-existing tests (written before the managed-software destination
    // policy gate existed) keep dispatching unless a test opts into a
    // restrictive policy/mode itself.
    effectivePolicyMock.mockReset();
    effectivePolicyMock.mockResolvedValue({ version: 1, approvedPrivateOrigins: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a deployment + per-device results and dispatches software_install for immediate install', async () => {
    const versionRecord = {
      id: 'ver-1',
      catalogId: 'cat-1',
      s3Key: 'pkg.key',
      downloadUrl: null,
      checksum: null,
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: null,
      version: '1.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-1', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1' },
      { id: 'dev-2', agentId: 'agent-2' },
    ];

    // 1st select: softwareVersions  2nd: softwareCatalog  3rd: devices
    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));

    // 1st insert: softwareDeployments (.returning())  2nd: deploymentResults (no .returning())
    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-1',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: 'system:automation',
    });

    expect(result.status).toBe('pending');
    expect(result.deployment).toEqual(deployment);
    expect(result.dispatchedDeviceIds).toEqual(['dev-1', 'dev-2']);
    expect(sendCommandMock).toHaveBeenCalledTimes(2);
    expect(sendCommandMock.mock.calls[0]![1].type).toBe('software_install');
    // WS delivery succeeded for both devices — the offline fallback must not fire.
    expect(queueCommandMock).not.toHaveBeenCalled();
    // dispatched_at claim marker set exactly once for the immediate path.
    const dispatchClaims = updateSetCalls.filter((v) => v.dispatchedAt instanceof Date);
    expect(dispatchClaims).toHaveLength(1);
  });

  it('falls back to queueCommand and records deviceCommandId when the agent has no live WS socket', async () => {
    const versionRecord = {
      id: 'ver-off',
      catalogId: 'cat-1',
      s3Key: 'pkg.key',
      downloadUrl: null,
      checksum: 'abc123',
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: '/S',
      version: '1.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-off', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-on', agentId: 'agent-on' },
      { id: 'dev-off', agentId: 'agent-off' },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    // First device online, second offline.
    sendCommandMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    queueCommandMock.mockResolvedValueOnce({ id: 'queued-cmd-off' });

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-off',
      deploymentType: 'install',
      deviceIds: ['dev-on', 'dev-off'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    // Both devices count as dispatched — one over WS, one queued.
    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-on', 'dev-off']);

    // The queued fallback fired once, for the offline device, with the SAME
    // payload the WS command carried — including deploymentId for the
    // queued-path result reconciliation.
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
    const [queuedDeviceId, queuedType, queuedPayload] = queueCommandMock.mock.calls[0]!;
    expect(queuedDeviceId).toBe('dev-off');
    expect(queuedType).toBe('software_install');
    const wsPayload = sendCommandMock.mock.calls[1]![1].payload;
    expect(queuedPayload).toEqual(wsPayload);
    expect(queuedPayload.deploymentId).toBe('dep-off');

    // The device_commands UUID is linked into deployment_results.deviceCommandId.
    const linkWrites = updateSetCalls.filter((v) => 'deviceCommandId' in v);
    expect(linkWrites).toEqual([{ deviceCommandId: 'queued-cmd-off' }]);
  });

  it('substitutes {{...}} installer variables per device from org/site/device context', async () => {
    const versionRecord = {
      id: 'ver-var',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{org.id}}/{{device.customField.license_key}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-var', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: { license_key: 'KEY-1' } },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }])) // organizations
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }])); // sites
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-var',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
    expect(sendCommandMock.mock.calls[0]![1].payload.downloadUrl).toBe(
      'https://dl/org-1/KEY-1/app.msi',
    );
  });

  it('dispatches a built-in EDR install using the resolver-provided URL/args', async () => {
    resolveEdrMock.mockResolvedValueOnce({
      downloadUrl: 'https://edr.example/agent.exe',
      silentInstallArgs: '/SILENT /TOKEN=abc',
    });
    const versionRecord = {
      id: 'ver-edr',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: '{huntress_org_key}', // template; resolver replaces it
      checksum: null,
      originalFileName: 'agent.exe',
      fileType: 'exe',
      silentInstallArgs: '/TOKEN={huntress_org_key}',
      version: '3.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'Huntress', integrationProvider: 'huntress' };
    const deployment = { id: 'dep-edr', orgId: 'org-1' };
    const targetDevices = [{ id: 'dev-1', agentId: 'agent-1' }];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-edr',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('pending');
    const payload = sendCommandMock.mock.calls[0]![1].payload;
    expect(payload.downloadUrl).toBe('https://edr.example/agent.exe');
    expect(payload.silentInstallArgs).toBe('/SILENT /TOKEN=abc');
  });

  it('fails the whole EDR deployment (no dispatch) when the resolver returns an error', async () => {
    resolveEdrMock.mockResolvedValueOnce({ error: 'Organization not mapped to Huntress' });
    const versionRecord = {
      id: 'ver-edr2',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: '{huntress_org_key}',
      checksum: null,
      originalFileName: 'agent.exe',
      fileType: 'exe',
      silentInstallArgs: null,
      version: '3.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'Huntress', integrationProvider: 'huntress' };
    const deployment = { id: 'dep-edr2', orgId: 'org-1' };

    selectMock.mockReturnValueOnce(sel([versionRecord])).mockReturnValueOnce(sel([catalogItem]));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());
    const failWhere = vi.fn().mockResolvedValue(undefined);
    updateMock.mockReturnValue({ set: vi.fn().mockReturnValue({ where: failWhere }) });

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-edr2',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/not mapped to Huntress/);
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(failWhere).toHaveBeenCalledTimes(1); // all result rows marked failed
  });

  it('dispatches resolved devices and fails only the unresolvable ones on a mixed batch', async () => {
    const versionRecord = {
      id: 'ver-mix',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{device.customField.license_key}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-mix', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: { license_key: 'KEY-1' } },
      { id: 'dev-2', agentId: 'agent-2', siteId: 'site-1', hostname: 'WKS-2', customFields: {} },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }]))
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }]));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-mix',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    // Partial failure: overall pending, only the resolvable device dispatched,
    // the unresolvable one marked failed — never shipped a literal {{...}}.
    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]![1].payload.downloadUrl).toBe('https://dl/KEY-1/app.msi');
    // dev-2 only marked failed (the dispatched_at claim write is separate).
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(1);
  });

  it('fails a device (and never dispatches) when an installer variable cannot be resolved', async () => {
    const versionRecord = {
      id: 'ver-bad',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{device.customField.missing}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-bad', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: {} },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }]))
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }]));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-bad',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    // Every target failed resolution → overall failure, nothing dispatched, the
    // device's result row was marked failed instead of shipping a literal token.
    expect(result.status).toBe('failed');
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(1);
  });

  it('threads detection rules and forceReinstall into the dispatched install payload', async () => {
    const detectionRules = [
      { type: 'registry', path: 'SOFTWARE\\Acme\\App' },
      { type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' },
    ];
    const versionRecord = {
      id: 'ver-det',
      catalogId: 'cat-1',
      s3Key: 'pkg.key',
      downloadUrl: null,
      checksum: null,
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: '/S',
      version: '1.0.0',
      detectionRules,
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-det', orgId: 'org-1' };
    const targetDevices = [{ id: 'dev-1', agentId: 'agent-1' }];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-det',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      options: { forceReinstall: true },
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    const dispatched = sendCommandMock.mock.calls[0]![1];
    expect(dispatched.payload.detectionRules).toEqual(detectionRules);
    expect(dispatched.payload.forceReinstall).toBe(true);
  });

  it('omits detectionRules and defaults forceReinstall false when version has none', async () => {
    const versionRecord = {
      id: 'ver-none',
      catalogId: 'cat-1',
      s3Key: 'pkg.key',
      downloadUrl: null,
      checksum: null,
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: null,
      version: '1.0.0',
      detectionRules: null,
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-none', orgId: 'org-1' };
    const targetDevices = [{ id: 'dev-1', agentId: 'agent-1' }];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-none',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    const dispatched = sendCommandMock.mock.calls[0]![1];
    expect(dispatched.payload.detectionRules).toBeUndefined();
    expect(dispatched.payload.forceReinstall).toBe(false);
  });

  it('returns status "failed" with a message when no installer URL is available', async () => {
    // Version has null s3Key AND null downloadUrl — no binary to dispatch
    const versionRecord = {
      id: 'ver-no-url',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: null,
      checksum: null,
      originalFileName: null,
      fileType: null,
      silentInstallArgs: null,
      version: '1.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-no-url', orgId: 'org-1' };

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]));

    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    updateMock.mockReturnValueOnce(upd());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-no-url',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/No installer available/i);
    expect(result.deployment).toEqual(deployment);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('persists maintenanceWindowId in the insert when provided', async () => {
    const versionRecord = {
      id: 'ver-mw',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: null,
      checksum: null,
      originalFileName: null,
      fileType: null,
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-mw', orgId: 'org-1', maintenanceWindowId: 'mw-test-id' };

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]));

    // Use a captured values mock so we can assert what was inserted
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([deployment]),
    });
    insertMock
      .mockReturnValueOnce({ values: valuesMock })   // softwareDeployments
      .mockReturnValueOnce(ins());                    // deploymentResults (scheduleType=scheduled skips dispatch)

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-mw',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'scheduled', // not immediate — skips dispatch; focuses test on insert shape
      createdBy: null,
      maintenanceWindowId: 'mw-test-id',
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceWindowId: 'mw-test-id' })
    );
    expect(result.deployment).toEqual(deployment);
    // Non-immediate path: no dispatch ran, so dispatched_at stays NULL for the
    // scheduler to claim later.
    expect(updateMock).not.toHaveBeenCalled();
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('stores a non-devices targetType as given and does not coerce to "devices"', async () => {
    const versionRecord = {
      id: 'ver-all',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: null,
      checksum: null,
      originalFileName: null,
      fileType: null,
      silentInstallArgs: null,
      version: '3.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-all', orgId: 'org-1', targetType: 'all', targetIds: null };

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]));

    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([deployment]),
    });
    insertMock
      .mockReturnValueOnce({ values: valuesMock })
      .mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-all',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],  // resolved device list used for dispatch
      scheduleType: 'scheduled',
      createdBy: null,
      targetType: 'all',
      targetIds: null,
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'all', targetIds: null })
    );
  });

  it('defaults targetType to "devices" and targetIds to deviceIds when not provided (automation caller)', async () => {
    const versionRecord = {
      id: 'ver-auto',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: null,
      checksum: null,
      originalFileName: null,
      fileType: null,
      silentInstallArgs: null,
      version: '4.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-auto', orgId: 'org-1' };

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]));

    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([deployment]),
    });
    insertMock
      .mockReturnValueOnce({ values: valuesMock })
      .mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-auto',
      deploymentType: 'install',
      deviceIds: ['dev-a', 'dev-b'],
      scheduleType: 'scheduled',
      createdBy: 'system:automation',
      // no targetType / targetIds / maintenanceWindowId
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'devices',
        targetIds: ['dev-a', 'dev-b'],
        maintenanceWindowId: null,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Managed software destination policy (Wave 6 Task 5, security remediation)
  //
  // This is the CANONICAL of the two managed-software dispatch paths (the other
  // is the legacy POST /software/deploy route, covered in routes/software.test.ts).
  // Both must attach the download policy AND apply the capability gate before
  // sendCommandToAgent.
  //
  // Deviation D1: the gate runs in one of two modes read from
  // MANAGED_SOFTWARE_POLICY_MODE.
  //   compat (default) — a PRIVATE destination requires capability >= 1; an
  //                      apparently-public destination is still permitted to a
  //                      capability-0 (not yet upgraded) agent.
  //   enforce          — every managed-software command requires capability >= 1.
  // -------------------------------------------------------------------------
  describe('managed software destination policy gate (Wave 6 Task 5)', () => {
    const PUBLIC_URL = 'https://cdn.example.com/pkg.exe';
    const PRIVATE_LITERAL_URL = 'https://10.10.0.5/pkg.exe';
    const PRIVATE_ORIGIN_URL = 'https://files.corp.internal/pkg.exe';
    const UPGRADE_REQUIRED = 'agent_network_policy_upgrade_required';

    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };

    function versionRow(downloadUrl: string) {
      return {
        id: 'ver-p',
        catalogId: 'cat-1',
        s3Key: null,
        downloadUrl,
        checksum: null,
        originalFileName: 'pkg.exe',
        fileType: 'exe',
        silentInstallArgs: null,
        version: '1.0.0',
      };
    }

    /** Wires the three selects + two inserts the immediate-install path performs,
     *  and returns the spy that captures every deploymentResults UPDATE payload. */
    function arrange(downloadUrl: string, targetDevices: unknown[]) {
      selectMock
        .mockReturnValueOnce(sel([versionRow(downloadUrl)]))
        .mockReturnValueOnce(sel([catalogItem]))
        .mockReturnValueOnce(sel(targetDevices));
      insertMock
        .mockReturnValueOnce(insWithReturning([{ id: 'dep-p', orgId: 'org-1' }]))
        .mockReturnValueOnce(ins());
      const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      updateMock.mockReturnValue({ set: setSpy });
      return { setSpy };
    }

    const run = (deviceIds: string[]) =>
      createSoftwareDeployment({
        orgId: 'org-1',
        softwareVersionId: 'ver-p',
        deploymentType: 'install',
        deviceIds,
        scheduleType: 'immediate',
        createdBy: null,
      });

    const device = (id: string, capability: number, siteId = 'site-1') => ({
      id,
      agentId: `agent-${id}`,
      siteId,
      hostname: id.toUpperCase(),
      customFields: {},
      outboundNetworkPolicyVersion: capability,
    });

    // --- compat mode (the shipping default) --------------------------------

    it('compat: dispatches a public destination to a capability-0 agent, with the effective allowlist attached', async () => {
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://files.corp.internal'],
      });
      arrange(PUBLIC_URL, [device('dev-1', 0)]);

      const result = await run(['dev-1']);

      expect(result.status).toBe('pending');
      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      expect(sendCommandMock.mock.calls[0]![1].payload.downloadPolicy).toEqual({
        version: 1,
        approvedPrivateOrigins: ['https://files.corp.internal'],
      });
      // The allowlist is scoped to the DEVICE's org + its own site.
      expect(effectivePolicyMock).toHaveBeenCalledWith('org-1', 'site-1');
    });

    it('compat: denies a private-literal destination to a capability-0 agent and enqueues nothing', async () => {
      const { setSpy } = arrange(PRIVATE_LITERAL_URL, [device('dev-1', 0)]);

      const result = await run(['dev-1']);

      expect(sendCommandMock).not.toHaveBeenCalled();
      expect(result.dispatchedDeviceIds).toEqual([]);
      expect(result.status).toBe('failed');
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', errorMessage: UPGRADE_REQUIRED }),
      );
    });

    it('compat: denies an operator-declared private ORIGIN (hostname, not a literal) to a capability-0 agent', async () => {
      // The org approved https://files.corp.internal as a PRIVATE software
      // origin — so a destination at that origin is private by declaration even
      // though its hostname is not an IP literal.
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://files.corp.internal'],
      });
      arrange(PRIVATE_ORIGIN_URL, [device('dev-1', 0)]);

      await run(['dev-1']);

      expect(sendCommandMock).not.toHaveBeenCalled();
    });

    it('compat: dispatches an APPROVED private destination to a capability-1 agent', async () => {
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://10.10.0.5'],
      });
      arrange(PRIVATE_LITERAL_URL, [device('dev-1', 1)]);

      const result = await run(['dev-1']);

      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(sendCommandMock.mock.calls[0]![1].payload.downloadPolicy).toEqual({
        version: 1,
        approvedPrivateOrigins: ['https://10.10.0.5'],
      });
    });

    it('dispatches an UNAPPROVED private destination to a capable agent without smuggling it into the allowlist', async () => {
      // The API is defense in depth, not the enforcement point: a capability-1
      // agent's dial-time policy is authoritative and will refuse this exact
      // destination because its origin is absent from the allowlist we send.
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://files.corp.internal'],
      });
      arrange(PRIVATE_LITERAL_URL, [device('dev-1', 1)]);

      await run(['dev-1']);

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      const policy = sendCommandMock.mock.calls[0]![1].payload.downloadPolicy;
      expect(policy.approvedPrivateOrigins).not.toContain('https://10.10.0.5');
    });

    it('sends each device the org ∪ site allowlist for ITS OWN site', async () => {
      effectivePolicyMock.mockImplementation(async (_orgId: string, siteId?: string) => ({
        version: 1,
        approvedPrivateOrigins:
          siteId === 'site-a'
            ? ['https://org.example', 'https://site-a.example']
            : ['https://org.example', 'https://site-b.example'],
      }));
      arrange(PUBLIC_URL, [device('dev-1', 1, 'site-a'), device('dev-2', 1, 'site-b')]);

      await run(['dev-1', 'dev-2']);

      expect(sendCommandMock.mock.calls[0]![1].payload.downloadPolicy.approvedPrivateOrigins).toEqual([
        'https://org.example',
        'https://site-a.example',
      ]);
      expect(sendCommandMock.mock.calls[1]![1].payload.downloadPolicy.approvedPrivateOrigins).toEqual([
        'https://org.example',
        'https://site-b.example',
      ]);
    });

    it('fails only the capability-0 device on a mixed batch and still dispatches the capable one', async () => {
      const { setSpy } = arrange(PRIVATE_LITERAL_URL, [device('dev-1', 1), device('dev-2', 0)]);
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://10.10.0.5'],
      });

      const result = await run(['dev-1', 'dev-2']);

      expect(result.status).toBe('pending');
      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      // 2 calls: the immediate path's dispatched_at claim marker (#1.2 honest
      // dispatch — unconditional, fires once per deployment before the
      // per-device loop) plus the one policy-denial failure write for dev-2.
      expect(setSpy).toHaveBeenCalledTimes(2);
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', errorMessage: UPGRADE_REQUIRED }),
      );
    });

    // --- enforce mode ------------------------------------------------------

    it('enforce: denies even a plainly public destination to a capability-0 agent', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
      const { setSpy } = arrange(PUBLIC_URL, [device('dev-1', 0)]);

      const result = await run(['dev-1']);

      expect(sendCommandMock).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', errorMessage: UPGRADE_REQUIRED }),
      );
    });

    it('enforce: rejects a capability-0 agent on a public hostname that could pivot private, before any command is enqueued', async () => {
      // The brief's DNS-rebinding / public-to-private-redirect case: a
      // capability-0 agent cannot defend against it, and the API cannot see the
      // pivot from the URL alone, so enforce denies the whole class. Under
      // compat this exact case is (per D1) the agent's dial-time policy's job.
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
      arrange('https://rebind.example/pkg.exe', [device('dev-1', 0)]);

      await run(['dev-1']);

      expect(sendCommandMock).not.toHaveBeenCalled();
    });

    it('enforce: dispatches a public destination to a capability-1 agent', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
      arrange(PUBLIC_URL, [device('dev-1', 1)]);

      const result = await run(['dev-1']);

      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(sendCommandMock).toHaveBeenCalledTimes(1);
    });

    it('treats an unset or unrecognized mode as compat', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'banana');
      arrange(PUBLIC_URL, [device('dev-1', 0)]);

      await run(['dev-1']);

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('buildAndDispatchSoftwareInstalls scopeToDeviceIds (retry path)', () => {
  const catalogItem = { name: 'TestApp', integrationProvider: null };
  const edrCatalogItem = { name: 'Huntress', integrationProvider: 'huntress' };
  const versionRecord = {
    downloadUrl: 'https://dl/pkg.exe',
    s3Key: null,
    checksum: null,
    originalFileName: 'pkg.exe',
    fileType: 'exe',
    silentInstallArgs: '/S',
    version: '1.0.0',
    detectionRules: null,
  };

  beforeEach(() => {
    sendCommandMock.mockReset();
    queueCommandMock.mockReset();
    selectMock.mockReset();
    updateMock.mockReset();
    vi.mocked(inArray).mockClear();
    sendCommandMock.mockReturnValue(true);
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
  });

  it('scopes the EDR-failure pre-write to scopeToDeviceIds instead of the whole deployment', async () => {
    resolveEdrMock.mockResolvedValueOnce({ error: 'Organization not mapped to Huntress' });

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-retry',
      orgId: 'org-1',
      versionRecord,
      catalogItem: edrCatalogItem,
      deviceIds: ['dev-failed'],
      scopeToDeviceIds: ['dev-failed'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(sendCommandMock).not.toHaveBeenCalled();
    // Exactly one failure pre-write, and its WHERE carries the device-subset
    // filter (deploymentResults.deviceId mocks to 'dr.deviceId') — a
    // deployment-wide write would clobber previously completed rows.
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(1);
    expect(inArray).toHaveBeenCalledWith('dr.deviceId', ['dev-failed']);
  });

  it('scopes the missing-installer pre-write to scopeToDeviceIds', async () => {
    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-retry',
      orgId: 'org-1',
      versionRecord: { ...versionRecord, downloadUrl: null },
      catalogItem,
      deviceIds: ['dev-failed'],
      scopeToDeviceIds: ['dev-failed'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/No installer available/i);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(1);
    expect(inArray).toHaveBeenCalledWith('dr.deviceId', ['dev-failed']);
  });

  it('limits the dispatch loop to the scoped devices', async () => {
    selectMock.mockReturnValueOnce(
      sel([{ id: 'dev-a', agentId: 'agent-a' }]), // devices query (already scope-filtered)
    );

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-retry',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-a', 'dev-b'],
      scopeToDeviceIds: ['dev-a'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-a']);
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    // The devices query only asks for the intersection of deviceIds and the
    // scope ('d.id' is the mocked devices.id column).
    expect(inArray).toHaveBeenCalledWith('d.id', ['dev-a']);
    // markDispatched:false — no dispatched_at re-stamp on retry.
    expect(updateSetCalls.filter((v) => v.dispatchedAt instanceof Date)).toHaveLength(0);
  });

  it('keeps the EDR-failure pre-write deployment-wide when scopeToDeviceIds is unset', async () => {
    resolveEdrMock.mockResolvedValueOnce({ error: 'Organization not mapped to Huntress' });

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-full',
      orgId: 'org-1',
      versionRecord,
      catalogItem: edrCatalogItem,
      deviceIds: ['dev-1'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(1);
    // Unscoped: the pre-write must NOT filter on deviceId — every (pending)
    // row of the deployment fails, byte-for-byte the pre-existing behavior.
    expect(inArray).not.toHaveBeenCalledWith('dr.deviceId', expect.anything());
  });

  // Retry race guard (this fix): the retry endpoint bumps retryCount before
  // calling this fan-out and passes the post-bump value via
  // deviceRetryCounts — it must land in both the WS command id AND the
  // payload (the offline-queue transport keys result reconciliation on the
  // payload, since queued commands don't use the sw-install-* id shape).
  it('bakes deviceRetryCounts into the dispatched command id and payload', async () => {
    selectMock.mockReturnValueOnce(
      sel([{ id: 'dev-a', agentId: 'agent-a' }]),
    );

    await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-retry',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-a'],
      scopeToDeviceIds: ['dev-a'],
      options: null,
      createdBy: null,
      markDispatched: false,
      deviceRetryCounts: { 'dev-a': 1 },
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    const [, dispatchedCommand] = sendCommandMock.mock.calls[0]!;
    expect(dispatchedCommand.id).toBe('sw-install-dep-retry-dev-a-1');
    expect(dispatchedCommand.payload.retryCount).toBe(1);
  });

  it('defaults retryCount to 0 for devices absent from deviceRetryCounts', async () => {
    selectMock.mockReturnValueOnce(
      sel([{ id: 'dev-a', agentId: 'agent-a' }]),
    );

    await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-first',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-a'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    const [, dispatchedCommand] = sendCommandMock.mock.calls[0]!;
    expect(dispatchedCommand.id).toBe('sw-install-dep-first-dev-a-0');
    expect(dispatchedCommand.payload.retryCount).toBe(0);
  });
});

describe('dispatchSoftwareInstallToDevice', () => {
  const payload = {
    deploymentId: 'dep-1',
    downloadUrl: 'https://dl/pkg.exe',
    checksum: null,
    fileName: 'pkg.exe',
    fileType: 'exe',
    silentInstallArgs: null,
    softwareName: 'TestApp',
    version: '1.0.0',
    forceReinstall: false,
  };

  beforeEach(() => {
    sendCommandMock.mockReset();
    queueCommandMock.mockReset();
    updateMock.mockReset();
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
  });

  it('delivers over WS when the agent is connected and never queues', async () => {
    sendCommandMock.mockReturnValue(true);

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome).toEqual({ transport: 'ws', deviceCommandId: null });
    expect(sendCommandMock).toHaveBeenCalledWith('agent-1', {
      id: 'sw-install-dep-1-dev-1-0',
      type: 'software_install',
      payload,
    });
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('bakes a non-zero retryCount into the WS command id (retry race guard)', async () => {
    sendCommandMock.mockReturnValue(true);

    await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
      3,
    );

    expect(sendCommandMock).toHaveBeenCalledWith('agent-1', {
      id: 'sw-install-dep-1-dev-1-3',
      type: 'software_install',
      payload,
    });
  });

  it('queues via queueCommand and links deviceCommandId when WS delivery fails', async () => {
    sendCommandMock.mockReturnValue(false);
    queueCommandMock.mockResolvedValue({ id: 'queued-cmd-9' });

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(outcome).toEqual({ transport: 'queued', deviceCommandId: 'queued-cmd-9' });
    expect(queueCommandMock).toHaveBeenCalledWith(
      'dev-1',
      'software_install',
      payload,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(updateSetCalls).toEqual([{ deviceCommandId: 'queued-cmd-9' }]);
  });

  it('returns transport queued with null id (and skips the link write) when queueCommand returns no row', async () => {
    sendCommandMock.mockReturnValue(false);
    queueCommandMock.mockResolvedValue(undefined);

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome).toEqual({ transport: 'queued', deviceCommandId: null });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
