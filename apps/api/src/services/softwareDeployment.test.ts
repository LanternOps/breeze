import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted so the mock factory can reference sendCommandMock
const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));

// Match the exact import paths used by routes/software.ts (and the service will mirror them)
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: sendCommandMock }));

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

import { createSoftwareDeployment } from './softwareDeployment';
import { resolveEdrInstaller } from './edrInstallerResolver';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSoftwareDeployment', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
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
    const failWhere = vi.fn().mockResolvedValue(undefined);
    updateMock.mockReturnValue({ set: vi.fn().mockReturnValue({ where: failWhere }) });

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
    expect(failWhere).toHaveBeenCalledTimes(1); // dev-2 only
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
    const failWhere = vi.fn().mockResolvedValue(undefined);
    updateMock.mockReturnValue({ set: vi.fn().mockReturnValue({ where: failWhere }) });

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
    expect(failWhere).toHaveBeenCalledTimes(1);
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
});
