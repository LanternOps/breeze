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
  devices: { id: 'd.id', orgId: 'd.orgId', agentId: 'd.agentId' },
}));

import { createSoftwareDeployment } from './softwareDeployment';

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
