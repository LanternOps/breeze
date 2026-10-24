/**
 * #6958 PR E3: the service_running compliance bridge inside processCheckPolicy.
 *
 * Same harness as softwareComplianceWorker.install.test.ts (FIFO db.select,
 * real softwarePolicyService evaluation, mocked upsert / inventory / queues),
 * plus `db.selectDistinctOn` for the service-observation read.
 *
 * db.select FIFO for one pass: policy reload → devices → compliance state →
 * [software_versions, only when an allowlist rule carries a catalogId].
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbSelectMock,
  dbSelectDistinctOnMock,
  resolveDeviceIdsMock,
  upsertMock,
  inventoryMock,
  scheduleUninstallMock,
  scheduleInstallMock,
} = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbSelectDistinctOnMock: vi.fn(),
  resolveDeviceIdsMock: vi.fn(async () => ['device-1']),
  upsertMock: vi.fn(async (_inputs: Array<Record<string, unknown>>) => undefined),
  inventoryMock: vi.fn(async () => new Map<string, unknown[]>([['device-1', []]])),
  scheduleUninstallMock: vi.fn(async (..._args: unknown[]) => 0),
  scheduleInstallMock: vi.fn(async (
    _policyId: string,
    _targets: Array<{ deviceId: string; catalogIds: string[]; attempt: number }>,
    _generation: number,
  ) => [] as string[]),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); addBulk = vi.fn(); getRepeatableJobs = vi.fn(async () => []); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  db: {
    select: dbSelectMock,
    selectDistinctOn: dbSelectDistinctOnMock,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: resolveDeviceIdsMock,
}));
vi.mock('./softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: scheduleUninstallMock,
  scheduleSoftwareInstallRemediation: scheduleInstallMock,
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  readLatestPolicyOwnedInstallByDevice: vi.fn(async () => new Map<string, Date>()),
}));
vi.mock('../services/softwarePolicyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwarePolicyService')>();
  return {
    ...actual,
    upsertSoftwareComplianceStatuses: upsertMock,
    getSoftwareInventoryByDeviceIds: inventoryMock,
    recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  };
});

import { processCheckPolicy } from './softwareComplianceWorker';
import type { SoftwarePolicyViolation } from '../db/schema';

const POLICY_ID = 'policy-1';
const CATALOG = 'catalog-ctrld';

/** Armed for install AND uninstall, allowlist, one rule pointing at a catalog item. */
const POLICY = {
  id: POLICY_ID,
  orgId: 'org-1',
  partnerId: null,
  name: 'DNS filtering',
  isActive: true,
  approvalGeneration: 1,
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoUninstall: true, autoInstall: true },
  rules: { software: [{ name: 'Control D', catalogId: CATALOG }], allowUnknown: true },
  managedByLinkId: null,
};

/** One row per (latest version, device org that can reach its catalog item). */
const CTRLD_VERSION = {
  catalogId: CATALOG,
  orgId: 'org-1',
  supportedOs: ['windows'],
  detectionRules: [
    { type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' },
    { type: 'service_running', serviceName: 'ctrld' },
  ],
};

type Device = { id: string; orgId: string; osType: string; agentVersion: string };
const WIN_NEW: Device = { id: 'device-1', orgId: 'org-1', osType: 'windows', agentVersion: '0.125.0' };

function chain(result: unknown[]) {
  const terminal = () => Object.assign(Promise.resolve(result), {
    limit: () => Promise.resolve(result),
    orderBy: () => Promise.resolve(result),
  });
  const joined: Record<string, unknown> = { where: terminal, limit: () => Promise.resolve(result) };
  joined.innerJoin = () => joined;
  return { from: () => joined };
}

function primeSelects(rows: unknown[][]) {
  for (const result of rows) dbSelectMock.mockReturnValueOnce(chain(result));
}

function primeObservations(rows: Array<{ deviceId: string; name: string; status: string; timestamp: Date }>) {
  dbSelectDistinctOnMock.mockReturnValueOnce(chain(rows));
}

function primePass(opts: {
  policy?: Record<string, unknown>;
  devices?: Device[];
  existing?: unknown[];
  versions?: unknown[] | null; // null = no versions select expected
  inventory?: unknown[];
}) {
  const devices = opts.devices ?? [WIN_NEW];
  const rows: unknown[][] = [[opts.policy ?? POLICY], devices, opts.existing ?? []];
  if (opts.versions !== null) rows.push(opts.versions ?? [CTRLD_VERSION]);
  primeSelects(rows);
  resolveDeviceIdsMock.mockResolvedValueOnce(devices.map((d) => d.id));
  inventoryMock.mockResolvedValueOnce(new Map(devices.map((d) => [d.id, opts.inventory ?? []])));
}

function upserted(deviceId = 'device-1'): Record<string, unknown> {
  const all = upsertMock.mock.calls.flatMap((call) => call[0]);
  const row = all.find((r) => r.deviceId === deviceId);
  if (!row) throw new Error(`no upsert for ${deviceId}`);
  return row;
}

const fresh = () => new Date(Date.now() - 2 * 60_000);

describe('processCheckPolicy — service_running bridge (#6958 PR E3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dbSelectDistinctOnMock.mockReset();
  });

  it('a stopped client with no inventory yields not_running, service_watches, and NO install', async () => {
    primePass({});
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'stopped', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect(row.serviceWatches).toEqual([{ name: 'ctrld' }]);
    const violations = row.violations as SoftwarePolicyViolation[];
    expect(violations.map((v) => v.type)).toEqual(['not_running']);
    expect(violations[0]?.service).toMatchObject({ name: 'ctrld', observedStatus: 'stopped' });
    expect(row.status).toBe('violation');
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(scheduleUninstallMock).not.toHaveBeenCalled();
  });

  it('issues the versions read and the observation read exactly once for the chunk', async () => {
    const second: Device = { ...WIN_NEW, id: 'device-2' };
    primePass({ devices: [WIN_NEW, second] });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(dbSelectMock).toHaveBeenCalledTimes(4); // policy, devices, compliance state, versions
    expect(dbSelectDistinctOnMock).toHaveBeenCalledTimes(1);
    expect(upserted('device-2').serviceWatches).toEqual([{ name: 'ctrld' }]);
  });

  it('no telemetry and no inventory → service_unverified, never missing, and nothing queued (Review Focus 2)', async () => {
    primePass({});
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const violations = upserted().violations as SoftwarePolicyViolation[];
    expect(violations.map((v) => v.type)).toEqual(['service_unverified']);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(scheduleUninstallMock).not.toHaveBeenCalled();
  });

  it('a running client with no inventory is compliant', async () => {
    primePass({});
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'running', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()).toMatchObject({ status: 'compliant', violations: [], serviceWatches: [{ name: 'ctrld' }] });
  });

  it('reads agentVersion from the device load: not_found from 0.125.0 is missing (install queued)…', async () => {
    primePass({});
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'not_found', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect((upserted().violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['missing']);
    expect(scheduleInstallMock).toHaveBeenCalledTimes(1);
  });

  it('…and from an older agent it reads as error → service_unverified (no install)', async () => {
    primePass({ devices: [{ ...WIN_NEW, agentVersion: '0.124.9' }] });
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'not_found', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect((upserted().violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['service_unverified']);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('service_watches are OS-filtered: a macOS device on a Windows-only version gets null and the plain missing', async () => {
    primePass({ devices: [{ ...WIN_NEW, osType: 'macos' }] });

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(dbSelectDistinctOnMock).not.toHaveBeenCalled();
    const row = upserted();
    expect(row.serviceWatches).toBeNull();
    expect((row.violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['missing']);
  });

  it('a version row reachable only from ANOTHER device org derives nothing for this device', async () => {
    const other: Device = { ...WIN_NEW, id: 'device-2', orgId: 'org-2' };
    primePass({ devices: [WIN_NEW, other], versions: [{ ...CTRLD_VERSION, orgId: 'org-2' }] });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted('device-1').serviceWatches).toBeNull();
    expect((upserted('device-1').violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['missing']);
    expect(upserted('device-2').serviceWatches).toEqual([{ name: 'ctrld' }]);
  });

  it('a policy with no catalogId rule issues neither extra read and writes service_watches null', async () => {
    primePass({
      policy: { ...POLICY, rules: { software: [{ name: 'Control D' }], allowUnknown: true } },
      versions: null,
    });

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(dbSelectMock).toHaveBeenCalledTimes(3);
    expect(dbSelectDistinctOnMock).not.toHaveBeenCalled();
    expect(upserted().serviceWatches).toBeNull();
  });

  it('a policy whose versions lost their service_running clause skips the observation read and NULLS service_watches', async () => {
    primePass({
      existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationAttempts: 0 }],
      versions: [{ ...CTRLD_VERSION, detectionRules: [{ type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' }] }],
    });

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(dbSelectMock).toHaveBeenCalledTimes(4);
    expect(dbSelectDistinctOnMock).not.toHaveBeenCalled();
    expect(upserted().serviceWatches).toBeNull();
  });

  it.each(['blocklist', 'audit'])('a %s policy derives nothing (no extra reads, service_watches null)', async (mode) => {
    primePass({ policy: { ...POLICY, mode }, versions: null });

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(dbSelectMock).toHaveBeenCalledTimes(3);
    expect(dbSelectDistinctOnMock).not.toHaveBeenCalled();
    expect(upserted().serviceWatches).toBeNull();
  });

  it('sorts names case-insensitively and caps service_watches at 50', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `svc-${String(59 - i).padStart(2, '0')}`);
    primePass({
      versions: [{ catalogId: CATALOG, orgId: 'org-1', supportedOs: null, detectionRules: names.slice(0, 20).map((serviceName) => ({ type: 'service_running', serviceName })) },
        { catalogId: 'catalog-2', orgId: 'org-1', supportedOs: null, detectionRules: names.slice(20, 40).map((serviceName) => ({ type: 'service_running', serviceName })) },
        { catalogId: 'catalog-3', orgId: 'org-1', supportedOs: null, detectionRules: names.slice(40).map((serviceName) => ({ type: 'service_running', serviceName })) }],
      policy: {
        ...POLICY,
        rules: { software: [
          { name: 'A', catalogId: CATALOG }, { name: 'B', catalogId: 'catalog-2' }, { name: 'C', catalogId: 'catalog-3' },
        ], allowUnknown: true },
      },
    });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const watches = upserted().serviceWatches as Array<{ name: string }>;
    expect(watches).toHaveLength(50);
    expect(watches[0]).toEqual({ name: 'svc-00' });
    expect(watches[49]).toEqual({ name: 'svc-49' });
  });

  it('holds (does not reset) the install-attempt counter while a no-inventory rule is only service_unverified', async () => {
    primePass({
      existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationStatus: 'failed', installRemediationAttempts: 2 }],
    });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect(row.installRemediationAttempts).toBeUndefined();
    expect(row.installRemediationStatus).toBeUndefined();
  });

  it('resets the counter once the client is observed running', async () => {
    primePass({
      existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationStatus: 'failed', installRemediationAttempts: 2 }],
    });
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'running', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()).toMatchObject({ installRemediationAttempts: 0, installRemediationStatus: 'completed' });
  });
});
