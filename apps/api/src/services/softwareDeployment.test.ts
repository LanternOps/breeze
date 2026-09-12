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

import {
  buildAndDispatchSoftwareInstalls,
  createSoftwareDeployment,
  dispatchSoftwareInstallToDevice,
} from './softwareDeployment';
import { resolveEdrInstaller } from './edrInstallerResolver';
import { getPresignedUrl } from './s3Storage';
import { inArray } from 'drizzle-orm';
import {
  fingerprintSoftwareInstallMethodDependency,
  fingerprintSoftwareVersionDependency,
} from './softwareDependencyIdentity';

const resolveEdrMock = vi.mocked(resolveEdrInstaller);
const getPresignedUrlMock = vi.mocked(getPresignedUrl);

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

/**
 * Chainable select for loadTenantVariableScope's join query:
 * db.select().from().innerJoin().where() → Promise<rows>
 */
function selJoin(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
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

/** Insert with exact per-device ids returned from deploymentResults. */
function ins() {
  return {
    values: vi.fn((values: Array<{ deviceId: string }> | { deviceId: string }) => ({
      returning: vi.fn().mockResolvedValue(
        (Array.isArray(values) ? values : [values]).map((value) => ({
          id: `result-${value.deviceId}`,
          deviceId: value.deviceId,
        })),
      ),
    })),
  };
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
    dispatchDeviceCommandMock.mockReset();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    // Default: the seam accepts and delivers over the live socket. Individual
    // tests override with mockImplementation/mockResolvedValueOnce to exercise
    // the queued-offline and refused paths.
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
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


  it('a dispatch failure on one device does not abort the fan-out for the rest', async () => {
    // #5128: dispatchSoftwareInstallToDevice now THROWS when the seam refuses
    // (decommissioned / trust-denied — checks that did not exist on this path
    // before). Without per-device isolation an uncaught throw aborts the loop
    // and leaves every device after it with a `pending` deployment_results row
    // that is never dispatched and never failed: exactly the silent death this
    // whole feature exists to remove.
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
      { id: 'dev-3', agentId: 'agent-3' },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock
      .mockReturnValueOnce(insWithReturning([deployment]))
      .mockReturnValueOnce(ins());

    // dev-2 is refused by the seam; dev-1 and dev-3 must still go out.
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => {
      if (deviceId === 'dev-2') {
        throw new Error('software_install dispatch refused for device dev-2: Device is decommissioned, cannot execute command');
      }
      return {
        ok: true,
        command: { id: `cmd-${deviceId}`, deviceId, type: 'software_install', status: 'pending' },
        delivery: 'delivered',
        deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      };
    });

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-1',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2', 'dev-3'],
      scheduleType: 'immediate',
      createdBy: 'system:automation',
    });

    // The healthy devices dispatched; the failing one did not abort them.
    expect(result.dispatchedDeviceIds).toEqual(['dev-1', 'dev-3']);

    // And the failure is REPORTED, not swallowed: dev-2 gets a failed result
    // carrying the real reason rather than hanging `pending` forever.
    const dev2 = result.deviceResults.find((r) => r.deviceId === 'dev-2');
    expect(dev2?.status).toBe('failed');
    expect(dev2?.message).toContain('decommissioned');
    expect(result.deviceResults.map((r) => r.deviceId)).toEqual(['dev-1', 'dev-2', 'dev-3']);
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
    const deploymentInsert = insWithReturning([deployment]);
    insertMock
      .mockReturnValueOnce(deploymentInsert)
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
    expect(deploymentInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      dependencyFingerprint: fingerprintSoftwareVersionDependency(versionRecord, catalogItem),
    }));
    expect(result.deployment).toEqual(deployment);
    expect(result.dispatchedDeviceIds).toEqual(['dev-1', 'dev-2']);
    // #5128: deviceCommandId is ALWAYS the seam's persisted row id now — the
    // row is written before push, on both transports, never null.
    expect(result.deviceResults).toEqual([
      {
        deviceId: 'dev-1',
        deploymentResultId: 'result-dev-1',
        status: 'delivered',
        deviceCommandId: 'cmd-dev-1',
      },
      {
        deviceId: 'dev-2',
        deploymentResultId: 'result-dev-2',
        status: 'delivered',
        deviceCommandId: 'cmd-dev-2',
      },
    ]);
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(2);
    expect(dispatchDeviceCommandMock.mock.calls[0]![0]).toMatchObject({
      deviceId: 'dev-1',
      type: 'software_install',
    });
    expect(dispatchDeviceCommandMock.mock.calls[1]![0]).toMatchObject({
      deviceId: 'dev-2',
      type: 'software_install',
    });
    // dispatched_at claim marker set exactly once for the immediate path.
    const dispatchClaims = updateSetCalls.filter((v) => v.dispatchedAt instanceof Date);
    expect(dispatchClaims).toHaveLength(1);
  });

  // #5128 (OD-8): a presigned URL is only valid for an hour, but a queued
  // install may be claimed days later. The payload carries the STABLE s3Key
  // reference too, so deliveryRefreshers['software_install'] can re-mint the
  // URL at claim time — but ONLY when the URL shipped to THIS device is
  // exactly the one minted from that key; an EDR-resolved or stored URL must
  // never be silently treated as refreshable.
  it('carries s3Key in the payload when the download URL is the presigned one', async () => {
    const versionRecord = {
      id: 'ver-s3',
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
    const deployment = { id: 'dep-s3', orgId: 'org-1' };
    const targetDevices = [{ id: 'dev-1', agentId: 'agent-1' }];

    getPresignedUrlMock.mockResolvedValueOnce('https://signed.example/pkg.key.exe');
    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-s3',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    const payload = dispatchDeviceCommandMock.mock.calls[0]![0].payload;
    expect(payload.downloadUrl).toBe('https://signed.example/pkg.key.exe');
    expect(payload.s3Key).toBe('pkg.key');
  });

  it('omits s3Key when the download URL did NOT come from that key (presign failed, stored URL used)', async () => {
    const versionRecord = {
      id: 'ver-s3-fallback',
      catalogId: 'cat-1',
      s3Key: 'pkg.key',
      // The stored fallback URL — what deviceDownloadUrl ends up being when
      // presign fails and the code falls back past it.
      downloadUrl: 'https://cdn.example.com/stored/pkg.exe',
      checksum: null,
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: null,
      version: '1.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-s3-fallback', orgId: 'org-1' };
    const targetDevices = [{ id: 'dev-1', agentId: 'agent-1' }];

    // Presign throws (e.g. transport/auth fault) — the s3Key is present but
    // the URL actually shipped is the stored one, not a presigned one.
    getPresignedUrlMock.mockRejectedValueOnce(new Error('presign transport error'));
    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-s3-fallback',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    const payload = dispatchDeviceCommandMock.mock.calls[0]![0].payload;
    expect(payload.downloadUrl).toBe('https://cdn.example.com/stored/pkg.exe');
    expect(payload.s3Key).toBeUndefined();
  });

  it('reports queued transport and still records deviceCommandId when the device is offline', async () => {
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

    // The seam itself decides WS-vs-queue per device now — dev-off is offline
    // at enqueue time and comes back queued_offline; dev-on stays delivered.
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: deviceId === 'dev-off' ? 'queued_offline' : 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-off',
      deploymentType: 'install',
      deviceIds: ['dev-on', 'dev-off'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    // Both devices count as dispatched — one delivered, one queued.
    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-on', 'dev-off']);
    expect(result.deviceResults).toEqual([
      {
        deviceId: 'dev-on',
        deploymentResultId: 'result-dev-on',
        status: 'delivered',
        deviceCommandId: 'cmd-dev-on',
      },
      {
        deviceId: 'dev-off',
        deploymentResultId: 'result-dev-off',
        status: 'queued',
        deviceCommandId: 'cmd-dev-off',
      },
    ]);

    // ONE call per device through the single enqueue seam — no separate
    // WS-then-fallback pair anymore — and the queued device's payload still
    // carries deploymentId for the queued-path result reconciliation.
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(2);
    const [onCall, offCall] = dispatchDeviceCommandMock.mock.calls;
    expect(onCall![0]).toMatchObject({ deviceId: 'dev-on', type: 'software_install' });
    expect(offCall![0]).toMatchObject({ deviceId: 'dev-off', type: 'software_install' });
    expect(offCall![0].payload).toEqual(onCall![0].payload);
    expect(offCall![0].payload.deploymentId).toBe('dep-off');

    // The device_commands UUID is linked into deployment_results.deviceCommandId
    // on BOTH transports now (#5128 persists before push).
    const linkWrites = updateSetCalls.filter((v) => 'deviceCommandId' in v);
    expect(linkWrites).toEqual([
      { deviceCommandId: 'cmd-dev-on' },
      { deviceCommandId: 'cmd-dev-off' },
    ]);
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
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }])) // sites
      .mockReturnValueOnce(selJoin([])); // tenant variable scope (#3409 PR2) — none defined
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
    expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadUrl).toBe(
      'https://dl/org-1/KEY-1/app.msi',
    );
  });

  // The fileName/fileType pair the agent receives. This is the bridge the
  // original MSI-by-URL bug lived on and nothing asserted it: every other
  // dispatch fixture sets originalFileName, so the `package.${fileType}`
  // fallback branch — the one every URL-created version takes, because
  // original_file_name is NULL for all of them — was never evaluated by a test.
  //
  // The two fields are COUPLED, not independent: the agent's
  // validateInstallFileName rejects the command outright unless the filename's
  // extension equals '.' + fileType.
  describe('dispatched fileName/fileType pair', () => {
    const dispatchWithVersion = async (
      versionOverrides: Record<string, unknown>,
      deploymentId: string,
    ) => {
      const versionRecord = {
        id: 'ver-ft',
        catalogId: 'cat-1',
        s3Key: null,
        downloadUrl: 'https://dl/acme.msi',
        checksum: null,
        originalFileName: null,
        silentInstallArgs: null,
        version: '1.0.0',
        ...versionOverrides,
      };
      const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
      const targetDevices = [
        { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: {} },
      ];

      selectMock
        .mockReturnValueOnce(sel([versionRecord]))
        .mockReturnValueOnce(sel([catalogItem]))
        .mockReturnValueOnce(sel(targetDevices))
        .mockReturnValueOnce(selLimit([{ name: 'Acme' }]))
        .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }]))
        .mockReturnValueOnce(selJoin([]));
      insertMock
        .mockReturnValueOnce(insWithReturning([{ id: deploymentId, orgId: 'org-1' }]))
        .mockReturnValueOnce(ins());

      await createSoftwareDeployment({
        orgId: 'org-1',
        softwareVersionId: 'ver-ft',
        deploymentType: 'install',
        deviceIds: ['dev-1'],
        scheduleType: 'immediate',
        createdBy: null,
      });

      return dispatchDeviceCommandMock.mock.calls[0]![0].payload;
    };

    it('sends package.msi for an MSI version with no original filename', async () => {
      // Reverting the fix makes this `{fileType:'exe', fileName:'package.exe'}`
      // — the exact payload that produced ERROR_BAD_EXE_FORMAT on Windows.
      const payload = await dispatchWithVersion({ fileType: 'msi' }, 'dep-ft-msi');
      expect(payload.fileType).toBe('msi');
      expect(payload.fileName).toBe('package.msi');
    });

    it('keeps the legacy exe fallback for a version with no recorded type', async () => {
      // Deliberate, not incidental: we never guess a better answer from the URL
      // at dispatch time, because that would silently override a stored type.
      const payload = await dispatchWithVersion({ fileType: null }, 'dep-ft-null');
      expect(payload.fileType).toBe('exe');
      expect(payload.fileName).toBe('package.exe');
    });

    it('falls back to exe for a file_type the agent could not install', async () => {
      // The column is a bare nullable varchar with no CHECK, so anything a
      // future route or manual UPDATE writes would otherwise reach the device
      // verbatim and fail only AFTER the download.
      const payload = await dispatchWithVersion({ fileType: 'rpm' }, 'dep-ft-bogus');
      expect(payload.fileType).toBe('exe');
      expect(payload.fileName).toBe('package.exe');
    });

    it('keeps a stored original filename in step with its type', async () => {
      const payload = await dispatchWithVersion(
        { fileType: 'msi', originalFileName: 'AcmeAgent.msi' },
        'dep-ft-orig',
      );
      expect(payload.fileName).toBe('AcmeAgent.msi');
      // The invariant the agent enforces, stated once here so any future change
      // to either field has to keep them consistent.
      expect(payload.fileName.toLowerCase().endsWith(`.${payload.fileType}`)).toBe(true);
    });
  });

  it('resolves a {{var.<key>}} tenant variable into the download URL (#3409 PR2)', async () => {
    const versionRecord = {
      id: 'ver-var2',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{var.repo_token}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-var2', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: {} },
    ];
    // A non-secret row for org-1 (forOrgId), plus a SECRET row that must never
    // be flattened into the vars map at all.
    const variableRows = [
      { id: 'tv-1', key: 'repo_token', value: 'tok-live', isSecret: false, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
      { id: 'tv-2', key: 'super_secret', value: 'sekrit', isSecret: true, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }])) // organizations
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }])) // sites
      .mockReturnValueOnce(selJoin(variableRows)); // tenant variable scope
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-var2',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
    expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadUrl).toBe(
      'https://dl/tok-live/app.msi',
    );
  });

  it('fails the device (no dispatch) with an explicit secret-template message when the URL references a SECRET tenant variable (#3409 PR4c-2)', async () => {
    const versionRecord = {
      id: 'ver-var3',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{var.super_secret}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: null,
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-var3', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: {} },
    ];
    const variableRows = [
      { id: 'tv-2', key: 'super_secret', value: 'sekrit', isSecret: true, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }])) // organizations
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }])) // sites
      .mockReturnValueOnce(selJoin(variableRows)); // tenant variable scope
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-var3',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    // PR4c-2: the secret is still never flattened into the vars map, but the
    // failure is now EXPLICIT — the per-device deployment_results write names
    // the rule (and the key) instead of reading as an unknown token. Same
    // channel and counter as the `unresolved` branch, so the batch-level
    // outcome is unchanged: the only device failed, the batch reports failed.
    expect(result.status).toBe('failed');
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    const failureWrites = updateSetCalls.filter((c) => c.status === 'failed');
    expect(failureWrites).toHaveLength(1);
    expect(failureWrites[0]?.errorMessage).toBe(
      'Software deployment templates cannot use secret variable(s) {{var.super_secret}}',
    );
    expect(failureWrites[0]?.completedAt).toBeInstanceOf(Date);
    // The VALUE never lands anywhere a human or the agent could read it.
    expect(JSON.stringify({ result, updateSetCalls })).not.toContain('sekrit');
  });

  it('lists EVERY secret key referenced across downloadUrl and silentInstallArgs (keys only, never values) (#3409 PR4c-2)', async () => {
    const versionRecord = {
      id: 'ver-var4',
      catalogId: 'cat-1',
      s3Key: null,
      downloadUrl: 'https://dl/{{var.zeta_secret}}/app.msi',
      checksum: null,
      originalFileName: 'app.msi',
      fileType: 'msi',
      silentInstallArgs: '/S /KEY={{var.alpha_secret}} /REPO={{var.repo_token}}',
      version: '2.0.0',
    };
    const catalogItem = { id: 'cat-1', orgId: null, name: 'TestApp', integrationProvider: null };
    const deployment = { id: 'dep-var4', orgId: 'org-1' };
    const targetDevices = [
      { id: 'dev-1', agentId: 'agent-1', siteId: 'site-1', hostname: 'WKS-1', customFields: {} },
      { id: 'dev-2', agentId: 'agent-2', siteId: 'site-1', hostname: 'WKS-2', customFields: {} },
    ];
    const variableRows = [
      { id: 'tv-1', key: 'repo_token', value: 'tok-live', isSecret: false, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
      { id: 'tv-2', key: 'zeta_secret', value: 'zeta-plaintext', isSecret: true, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
      { id: 'tv-3', key: 'alpha_secret', value: 'alpha-plaintext', isSecret: true, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
      // A secret the templates do NOT reference must not be named either.
      { id: 'tv-4', key: 'unrelated_secret', value: 'unrelated-plaintext', isSecret: true, version: 1, ownerOrgId: 'org-1', forOrgId: 'org-1' },
    ];

    selectMock
      .mockReturnValueOnce(sel([versionRecord]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices))
      .mockReturnValueOnce(selLimit([{ name: 'Acme' }])) // organizations
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }])) // sites
      .mockReturnValueOnce(selJoin(variableRows)); // tenant variable scope
    insertMock.mockReturnValueOnce(insWithReturning([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-var4',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toBe('All target devices failed installer variable resolution');
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    // One failure row per device, all carrying the same sorted key list.
    const failureWrites = updateSetCalls.filter((c) => c.status === 'failed');
    expect(failureWrites).toHaveLength(2);
    for (const write of failureWrites) {
      expect(write.errorMessage).toBe(
        'Software deployment templates cannot use secret variable(s) {{var.alpha_secret}}, {{var.zeta_secret}}',
      );
    }
    const recorded = JSON.stringify({ result, updateSetCalls });
    expect(recorded).not.toContain('unrelated_secret');
    for (const value of ['zeta-plaintext', 'alpha-plaintext', 'unrelated-plaintext']) {
      expect(recorded).not.toContain(value);
    }
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
    const payload = dispatchDeviceCommandMock.mock.calls[0]![0].payload;
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }]))
      .mockReturnValueOnce(selJoin([])); // tenant variable scope (#3409 PR2) — none defined
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
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
    expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadUrl).toBe('https://dl/KEY-1/app.msi');
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
      .mockReturnValueOnce(sel([{ id: 'site-1', name: 'HQ' }]))
      .mockReturnValueOnce(selJoin([])); // tenant variable scope (#3409 PR2) — none defined
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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

    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
    const dispatched = dispatchDeviceCommandMock.mock.calls[0]![0];
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

    const dispatched = dispatchDeviceCommandMock.mock.calls[0]![0];
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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
      expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
      expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadPolicy).toEqual({
        version: 1,
        approvedPrivateOrigins: ['https://files.corp.internal'],
      });
      // The allowlist is scoped to the DEVICE's org + its own site.
      expect(effectivePolicyMock).toHaveBeenCalledWith('org-1', 'site-1');
    });

    it('compat: denies a private-literal destination to a capability-0 agent and enqueues nothing', async () => {
      const { setSpy } = arrange(PRIVATE_LITERAL_URL, [device('dev-1', 0)]);

      const result = await run(['dev-1']);

      expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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

      expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    });

    it('compat: dispatches an APPROVED private destination to a capability-1 agent', async () => {
      effectivePolicyMock.mockResolvedValue({
        version: 1,
        approvedPrivateOrigins: ['https://10.10.0.5'],
      });
      arrange(PRIVATE_LITERAL_URL, [device('dev-1', 1)]);

      const result = await run(['dev-1']);

      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadPolicy).toEqual({
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

      expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
      const policy = dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadPolicy;
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

      expect(
        dispatchDeviceCommandMock.mock.calls[0]![0].payload.downloadPolicy.approvedPrivateOrigins,
      ).toEqual(['https://org.example', 'https://site-a.example']);
      expect(
        dispatchDeviceCommandMock.mock.calls[1]![0].payload.downloadPolicy.approvedPrivateOrigins,
      ).toEqual(['https://org.example', 'https://site-b.example']);
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
      expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
      // 3 calls: the immediate path's dispatched_at claim marker (#1.2 honest
      // dispatch — unconditional, fires once per deployment before the
      // per-device loop), the deviceCommandId link write for dev-1's
      // successful dispatch (#5128 — always linked now, not just on queue),
      // and the one policy-denial failure write for dev-2.
      expect(setSpy).toHaveBeenCalledTimes(3);
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', errorMessage: UPGRADE_REQUIRED }),
      );
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deviceCommandId: 'cmd-dev-1' }),
      );
    });

    // --- enforce mode ------------------------------------------------------

    it('enforce: denies even a plainly public destination to a capability-0 agent', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
      const { setSpy } = arrange(PUBLIC_URL, [device('dev-1', 0)]);

      const result = await run(['dev-1']);

      expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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

      expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    });

    it('enforce: dispatches a public destination to a capability-1 agent', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'enforce');
      arrange(PUBLIC_URL, [device('dev-1', 1)]);

      const result = await run(['dev-1']);

      expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
      expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
    });

    it('treats an unset or unrecognized mode as compat', async () => {
      vi.stubEnv('MANAGED_SOFTWARE_POLICY_MODE', 'banana');
      arrange(PUBLIC_URL, [device('dev-1', 0)]);

      await run(['dev-1']);

      expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
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
    dispatchDeviceCommandMock.mockReset();
    selectMock.mockReset();
    updateMock.mockReset();
    vi.mocked(inArray).mockClear();
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
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
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
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
  // deviceRetryCounts — it must land in the payload handed to the dispatch
  // seam (the offline-queue transport keys result reconciliation on it).
  // #5128: the synthetic `sw-install-<deployment>-<device>-<attempt>` WS
  // command id no longer exists at this layer — dispatchDeviceCommand mints
  // the durable device_commands row id itself, so retryCount's only carrier
  // here is the payload.
  it('passes deviceRetryCounts through to the dispatch seam payload (retry race guard)', async () => {
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

    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
    const dispatched = dispatchDeviceCommandMock.mock.calls[0]![0];
    expect(dispatched.deviceId).toBe('dev-a');
    expect(dispatched.payload.retryCount).toBe(1);
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

    const dispatched = dispatchDeviceCommandMock.mock.calls[0]![0];
    expect(dispatched.payload.retryCount).toBe(0);
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
    dispatchDeviceCommandMock.mockReset();
    updateMock.mockReset();
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
  });

  it('calls the single enqueue seam with deviceId/type/payload/offlinePolicy and reports ws transport when delivered', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: true,
      command: { id: 'cmd-dev-1', status: 'sent' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome).toEqual({ transport: 'ws', deviceCommandId: 'cmd-dev-1' });
    expect(dispatchDeviceCommandMock).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      type: 'software_install',
      payload,
      offlinePolicy: { kind: 'queue', deliverWithinMs: expect.any(Number) },
    });
  });

  it('passes createdBy through as userId, and omits the key entirely when createdBy is null', async () => {
    await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      'user-42',
    );
    expect(dispatchDeviceCommandMock.mock.calls[0]![0].userId).toBe('user-42');

    dispatchDeviceCommandMock.mockClear();
    await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );
    expect('userId' in dispatchDeviceCommandMock.mock.calls[0]![0]).toBe(false);
  });

  it('reports queued transport when the seam enqueues to an offline device (queued_offline)', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: true,
      command: { id: 'cmd-dev-1', status: 'pending' },
      delivery: 'queued_offline',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome).toEqual({ transport: 'queued', deviceCommandId: 'cmd-dev-1' });
  });

  it('reports queued transport when the seam could not confirm the live push (queued_live)', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: true,
      command: { id: 'cmd-dev-1', status: 'pending' },
      delivery: 'queued_live',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome).toEqual({ transport: 'queued', deviceCommandId: 'cmd-dev-1' });
  });

  // #5128's actual fix: BEFORE this change the WS path never created a
  // device_commands row at all — deviceCommandId came back null and
  // deployment_results.device_command_id stayed NULL, so a push the agent
  // never acted on was invisible to the reaper, the device's queued-actions
  // list, and cancel. The row is now persisted first by the one seam and
  // linked here on BOTH transports.
  it('persists the device_commands row on the WS path too, and links it into deployment_results', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: true,
      command: { id: 'cmd-dev-1', status: 'sent' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    const outcome = await dispatchSoftwareInstallToDevice(
      'dep-1',
      { id: 'dev-1', agentId: 'agent-1' },
      payload,
      null,
    );

    expect(outcome.transport).toBe('ws');
    expect(outcome.deviceCommandId).toBeTruthy();
    expect(updateSetCalls).toEqual([{ deviceCommandId: 'cmd-dev-1' }]);
  });

  it('a refused dispatch throws rather than silently reporting success', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: false,
      code: 'device_decommissioned',
      error: 'Device is decommissioned, cannot execute command',
    });

    await expect(
      dispatchSoftwareInstallToDevice(
        'dep-1',
        { id: 'dev-1', agentId: 'agent-1' },
        payload,
        null,
      ),
    ).rejects.toThrow(/software_install dispatch refused for device dev-1/);
    // A refusal must never write deployment_results — there is nothing to link.
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Package-manager (winget / Homebrew) deployments — Task 4.
//
// A manager deployment references ONE software_install_methods row instead of
// a software_versions row, so there is no installer URL, checksum, download
// policy or `{{...}}` variable substitution on this path: the agent resolves
// the package through the OS package manager. The route splits a
// cross-platform catalog item into one deployment per platform, so the
// service only ever sees a single method — a device whose osType doesn't
// match it is failed in place rather than silently skipped.
// ---------------------------------------------------------------------------
describe('createSoftwareDeployment (package-manager install methods)', () => {
  const wingetMethod = {
    id: 'method-win',
    catalogId: 'cat-1',
    platform: 'windows',
    kind: 'winget',
    packageId: 'Mozilla.Firefox',
    enabled: true,
  };
  const catalogItem = { id: 'cat-1', orgId: 'org-1', name: 'Firefox', integrationProvider: null };
  const deployment = { id: 'dep-m1', orgId: 'org-1' };

  /** Insert chain that records the inserted values for assertions. */
  let insertedValues: Record<string, unknown>[] = [];
  function insCapture(rows: unknown[]) {
    return {
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return { returning: vi.fn().mockResolvedValue(rows) };
      }),
    };
  }

  beforeEach(() => {
    dispatchDeviceCommandMock.mockReset();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
    insertedValues = [];
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    effectivePolicyMock.mockReset();
    effectivePolicyMock.mockResolvedValue({ version: 1, approvedPrivateOrigins: [] });
  });

  /** selects: install method -> catalog item -> devices */
  function primeSelects(method: unknown, targetDevices: unknown[]) {
    selectMock
      .mockReturnValueOnce(sel([method]))
      .mockReturnValueOnce(sel([catalogItem]))
      .mockReturnValueOnce(sel(targetDevices));
    insertMock.mockReturnValueOnce(insCapture([deployment])).mockReturnValueOnce(ins());
  }

  it('dispatches a manager payload with installMethod/versionMode and no downloadUrl', async () => {
    primeSelects(wingetMethod, [{ id: 'dev-1', agentId: 'agent-1', osType: 'windows' }]);

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'method-win',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      name: 'Firefox (Windows)',
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
    // The deployment row carries the method, not a version.
    expect(insertedValues[0]).toMatchObject({
      installMethodId: 'method-win',
      softwareVersionId: null,
      dependencyFingerprint: fingerprintSoftwareInstallMethodDependency(wingetMethod, catalogItem),
    });

    const payload = dispatchDeviceCommandMock.mock.calls[0]![0].payload;
    expect(payload).toMatchObject({
      deploymentId: 'dep-m1',
      retryCount: 0,
      installMethod: { kind: 'winget', packageId: 'Mozilla.Firefox' },
      versionMode: 'latest',
      softwareName: 'Firefox',
      forceReinstall: false,
    });
    // URL-path fields must be absent entirely for manager deploys.
    expect(payload).not.toHaveProperty('downloadUrl');
    expect(payload).not.toHaveProperty('checksum');
    expect(payload).not.toHaveProperty('downloadPolicy');
    expect(payload).not.toHaveProperty('requestedVersion');
  });

  it('includes requestedVersion when versionMode is exact', async () => {
    primeSelects(wingetMethod, [{ id: 'dev-1', agentId: 'agent-1', osType: 'windows' }]);

    await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'method-win',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      versionMode: 'exact',
      requestedVersion: '128.0.1',
    });

    expect(dispatchDeviceCommandMock.mock.calls[0]![0].payload).toMatchObject({
      versionMode: 'exact',
      requestedVersion: '128.0.1',
    });
  });

  it('fails a device whose osType has no matching install method instead of dispatching it', async () => {
    primeSelects(wingetMethod, [
      { id: 'dev-1', agentId: 'agent-1', osType: 'windows' },
      { id: 'dev-2', agentId: 'agent-2', osType: 'linux' },
    ]);

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'method-win',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1']);
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);
    const failureWrite = updateSetCalls.find((v) => v.status === 'failed');
    expect(failureWrite).toBeDefined();
    expect(String(failureWrite!.errorMessage)).toContain('No install method for this device OS');
  });

  it('returns status failed when no target device OS matches the install method', async () => {
    primeSelects(wingetMethod, [
      { id: 'dev-1', agentId: 'agent-1', osType: 'macos' },
      { id: 'dev-2', agentId: 'agent-2', osType: 'linux' },
    ]);

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'method-win',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: null,
    });

    expect(result.status).toBe('failed');
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    expect(result.message).toContain('No install method for this device OS');
  });

  it('rejects an input that sets both a version and an install method', async () => {
    await expect(
      createSoftwareDeployment({
        orgId: 'org-1',
        softwareVersionId: 'ver-1',
        installMethodId: 'method-win',
        deploymentType: 'install',
        deviceIds: ['dev-1'],
        scheduleType: 'immediate',
        createdBy: null,
      }),
    ).rejects.toThrow(/exactly one/i);
  });

  it('throws when the install method row does not exist', async () => {
    selectMock.mockReturnValueOnce(sel([]));

    await expect(
      createSoftwareDeployment({
        orgId: 'org-1',
        installMethodId: 'missing',
        deploymentType: 'install',
        deviceIds: ['dev-1'],
        scheduleType: 'immediate',
        createdBy: null,
      }),
    ).rejects.toThrow(/Install method not found/);
  });
});

// ---------------------------------------------------------------------------
// #3603: targets that no longer resolve at dispatch time
// ---------------------------------------------------------------------------

describe('buildAndDispatchSoftwareInstalls — targets missing at dispatch (#3603)', () => {
  const catalogItem = { name: 'TestApp', integrationProvider: null };
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
  const installMethod = {
    id: 'sim-1',
    catalogId: 'cat-1',
    platform: 'windows',
    kind: 'winget',
    packageId: 'Google.Chrome',
  };

  beforeEach(() => {
    dispatchDeviceCommandMock.mockReset();
    selectMock.mockReset();
    updateMock.mockReset();
    vi.mocked(inArray).mockClear();
    dispatchDeviceCommandMock.mockImplementation(async ({ deviceId }: { deviceId: string }) => ({
      ok: true,
      command: { id: `cmd-${deviceId}`, status: 'pending' },
      delivery: 'delivered',
      deliverBy: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    }));
    effectivePolicyMock.mockResolvedValue({ approvedPrivateOrigins: [] });
    updateSetCalls = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
  });

  it('URL path: fails the result row of a target the devices query no longer returns', async () => {
    // dev-gone was deleted / moved orgs between create and dispatch.
    selectMock.mockReturnValueOnce(sel([{ id: 'dev-a', agentId: 'agent-a', siteId: 'site-1' }]));

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-1',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-a', 'dev-gone'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    // The surviving device still dispatches.
    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-a']);
    expect(dispatchDeviceCommandMock).toHaveBeenCalledTimes(1);

    // ...and the missing one gets a terminal row instead of staying pending.
    const failWrites = updateSetCalls.filter((v) => v.status === 'failed');
    expect(failWrites).toHaveLength(1);
    expect(failWrites[0]!.errorMessage).toBe(
      'Device no longer exists or is no longer in this organization',
    );
    expect(failWrites[0]!.completedAt).toBeInstanceOf(Date);
    // Scoped to the missing device only, and only over non-terminal statuses —
    // a completed row from an earlier attempt must never be clobbered.
    expect(inArray).toHaveBeenCalledWith('dr.deviceId', ['dev-gone']);
    expect(inArray).toHaveBeenCalledWith('dr.status', [
      'pending',
      'running',
      'downloading',
      'installing',
    ]);
  });

  it('URL path: writes nothing extra when every target resolves', async () => {
    selectMock.mockReturnValueOnce(sel([{ id: 'dev-a', agentId: 'agent-a', siteId: 'site-1' }]));

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-1',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-a'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('pending');
    expect(updateSetCalls.filter((v) => v.status === 'failed')).toHaveLength(0);
    expect(inArray).not.toHaveBeenCalledWith('dr.deviceId', expect.anything());
  });

  it('URL path: reports failed when EVERY target went missing', async () => {
    selectMock.mockReturnValueOnce(sel([]));

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-1',
      orgId: 'org-1',
      versionRecord,
      catalogItem,
      deviceIds: ['dev-gone-1', 'dev-gone-2'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toBe('No target device is still available');
    expect(result.dispatchedDeviceIds).toEqual([]);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    expect(inArray).toHaveBeenCalledWith('dr.deviceId', ['dev-gone-1', 'dev-gone-2']);
  });

  it('manager path: fails the result row of a target that went missing', async () => {
    selectMock.mockReturnValueOnce(
      sel([{ id: 'dev-a', agentId: 'agent-a', osType: 'windows' }]),
    );

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-mgr',
      orgId: 'org-1',
      installMethod,
      catalogItem,
      deviceIds: ['dev-a', 'dev-gone'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-a']);
    const failWrites = updateSetCalls.filter((v) => v.status === 'failed');
    expect(failWrites).toHaveLength(1);
    expect(failWrites[0]!.errorMessage).toBe(
      'Device no longer exists or is no longer in this organization',
    );
    expect(inArray).toHaveBeenCalledWith('dr.deviceId', ['dev-gone']);
  });

  it('manager path: reports failed when EVERY target went missing', async () => {
    selectMock.mockReturnValueOnce(sel([]));

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-mgr',
      orgId: 'org-1',
      installMethod,
      catalogItem,
      deviceIds: ['dev-gone'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toBe('No target device is still available');
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
  });

  it('manager path: an OS mismatch still reports its own message, not the missing-device one', async () => {
    selectMock.mockReturnValueOnce(
      sel([{ id: 'dev-mac', agentId: 'agent-mac', osType: 'macos' }]),
    );

    const result = await buildAndDispatchSoftwareInstalls({
      deploymentId: 'dep-mgr',
      orgId: 'org-1',
      installMethod,
      catalogItem,
      deviceIds: ['dev-mac'],
      options: null,
      createdBy: null,
      markDispatched: false,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/No install method for this device OS/);
  });
});
