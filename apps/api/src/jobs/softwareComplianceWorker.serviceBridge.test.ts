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
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
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

// #6960 W05 (managed DNS describe at the end): tenant variables at the
// resolver seam, and the coverage store. Neither is reached by the unmanaged
// policies the #6958 cases above use (managedByLinkId null).
const { tenantVarsByOrg, recordCoverageMock } = vi.hoisted(() => ({
  tenantVarsByOrg: new Map<string, Record<string, { value: string; isSecret: boolean }>>(),
  recordCoverageMock: vi.fn(async (..._args: unknown[]) => ({ upserted: 0, pruned: 0 })),
}));
vi.mock('../services/tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn(async (orgIds: string[]) => ({ orgIds: new Set(orgIds) })),
  resolveForOrg: (_scope: unknown, orgId: string) => new Map(
    Object.entries(tenantVarsByOrg.get(orgId) ?? {}).map(([key, v]) => [key, { key, ...v, variableId: 'v', version: 1, ownerScope: 'organization' }]),
  ),
  unreadableForOrg: () => new Set<string>(),
}));
vi.mock('../services/securityAgents/coverageStatusStore', () => ({
  recordManagedPolicyApplicability: recordCoverageMock,
  pruneAllForPolicy: vi.fn(async () => ({ upserted: 0, pruned: 0 })),
}));

import { processCheckPolicy } from './softwareComplianceWorker';
import { captureException } from '../services/sentry';
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

  it('an INVENTORY-MATCHED rule that is only service_unverified does not hold: the counter resets and the status settles', async () => {
    primePass({
      existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationStatus: 'failed', installRemediationAttempts: 2 }],
      inventory: [{ name: 'Control D', version: '1.5.8', vendor: null, catalogId: null }],
    });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect((row.violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['service_unverified']);
    expect(row).toMatchObject({ installRemediationAttempts: 0, installRemediationStatus: 'completed' });
  });

  it('a held install axis does not rewrite a previous `completed` to `none`', async () => {
    primePass({
      existing: [{ deviceId: 'device-1', status: 'compliant', violations: [], installRemediationStatus: 'completed', installRemediationAttempts: 0 }],
    });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted().installRemediationStatus).toBeUndefined();
  });

  it.each([
    ['the versions read', 'versions'],
    ['the observation read', 'observations'],
  ] as const)('a failure in %s does not fail the pass: inventory is evaluated, watches untouched, installs held', async (_label, which) => {
    const failing = () => {
      // Lazy: a rejected promise is created only when the code awaits it.
      const fail = () => Promise.reject(new Error('bridge read failed'));
      const rejected = () => ({
        then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => fail().then(onOk, onErr),
        limit: fail,
        orderBy: fail,
      });
      const joined: Record<string, unknown> = { where: rejected };
      joined.innerJoin = () => joined;
      return { from: () => joined };
    };
    if (which === 'versions') {
      primeSelects([[POLICY], [WIN_NEW], [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationAttempts: 1 }]]);
      dbSelectMock.mockReturnValueOnce(failing());
      resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
      inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));
    } else {
      primePass({ existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationAttempts: 1 }] });
      dbSelectDistinctOnMock.mockReturnValueOnce(failing());
    }

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect(row.serviceWatches).toBeUndefined();
    expect((row.violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['missing']);
    expect(row.installRemediationAttempts).toBeUndefined();
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// #6960 W05: a GENERATED (security agents) policy with tenant-variable (DNS)
// rules, through the REAL managed-applicability filter and the REAL readiness
// preflight (tenant variables mocked at the resolver), then the bridge.
//
// db.select FIFO for a managed pass: policy → devices → catalog rows →
// authored link (applicability) → compliance state → software_versions.
// ---------------------------------------------------------------------------

describe('processCheckPolicy — managed DNS rules: applicability and the bridge (#6960 W05, #10126)', () => {
  const NEXTDNS = 'catalog-nextdns-win';
  const CONTROLD = 'catalog-controld-win';
  const MANAGED = {
    ...POLICY,
    id: POLICY_ID,
    orgId: null,
    partnerId: 'partner-1',
    name: 'Security agents: Baseline',
    remediationOptions: { autoInstall: true, autoUninstall: false },
    managedByLinkId: 'link-dns',
    rules: {
      software: [
        { name: 'Control D (Windows)', catalogId: CONTROLD },
        { name: 'NextDNS CLI (Windows)', catalogId: NEXTDNS },
      ],
      allowUnknown: true,
    },
  };
  const CATALOG_ROWS = [
    { id: CONTROLD, integrationProvider: null, builtinPackageKey: 'controld_windows' },
    { id: NEXTDNS, integrationProvider: null, builtinPackageKey: 'nextdns_windows' },
  ];
  const LINK = [{ inlineSettings: { version: 1, agents: [{ vendor: 'controld', enabled: true }, { vendor: 'nextdns', enabled: true }] } }];
  const versionFor = (catalogId: string, orgId: string, serviceName: string) => ({
    catalogId,
    orgId,
    supportedOs: ['windows'],
    detectionRules: [{ type: 'service_running', serviceName }],
  });

  function primeManaged(opts: { devices: Device[]; existing?: unknown[]; inventory?: unknown[] }) {
    const versions = opts.devices.flatMap((d) => [
      versionFor(CONTROLD, d.orgId, 'ctrld'),
      versionFor(NEXTDNS, d.orgId, 'nextdns'),
    ]);
    primeSelects([[MANAGED], opts.devices, CATALOG_ROWS, LINK, opts.existing ?? [], versions]);
    resolveDeviceIdsMock.mockResolvedValueOnce(opts.devices.map((d) => d.id));
    inventoryMock.mockResolvedValueOnce(new Map(opts.devices.map((d) => [d.id, opts.inventory ?? []])));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dbSelectDistinctOnMock.mockReset();
    tenantVarsByOrg.clear();
  });

  it('two vendors, one not ready (var_missing): the not-ready rule yields no violation of any kind and burns no attempt; the ready one installs at attempt 1 (Review Focus 3)', async () => {
    tenantVarsByOrg.set('org-1', { controld_provisioning_code: { value: '<provisioning-code>', isSecret: false } });
    primeManaged({ devices: [WIN_NEW] });
    primeObservations([
      { deviceId: 'device-1', name: 'ctrld', status: 'not_found', timestamp: fresh() },
      { deviceId: 'device-1', name: 'nextdns', status: 'not_found', timestamp: fresh() },
    ]);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const violations = upserted().violations as SoftwarePolicyViolation[];
    expect(violations.map((v) => [v.type, v.rule?.catalogId])).toEqual([['missing', CONTROLD]]);
    expect(scheduleInstallMock).toHaveBeenCalledTimes(1);
    expect(scheduleInstallMock.mock.calls[0]![1]).toEqual([{ deviceId: 'device-1', catalogIds: [CONTROLD], attempt: 1 }]);
    expect(result).toMatchObject({ notApplicable: 1, notApplicableByReason: { var_missing: 1 } });
    // Coverage: one row per (device, vendor), keyed on the device's org.
    const entries = (recordCoverageMock.mock.calls[0]![0] as { entries: unknown[] }).entries;
    expect(entries).toEqual([
      { deviceId: 'device-1', orgId: 'org-1', vendor: 'controld', notApplicableReason: null },
      { deviceId: 'device-1', orgId: 'org-1', vendor: 'nextdns', notApplicableReason: 'var_missing' },
    ]);
  });

  it('a var_missing org with NO telemetry never gets service_unverified for its rules, nothing is queued, and the counter is not held', async () => {
    primeManaged({
      devices: [WIN_NEW],
      existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationStatus: 'failed', installRemediationAttempts: 2 }],
    });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect(row).toMatchObject({ status: 'compliant', violations: [] });
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    // Nothing applicable is missing or unverified: the install axis settles.
    expect(row).toMatchObject({ installRemediationAttempts: 0, installRemediationStatus: 'completed' });
  });

  it('a var_secret org is not applicable too (its secret never reaches a script)', async () => {
    tenantVarsByOrg.set('org-1', {
      controld_provisioning_code: { value: '<provisioning-code>', isSecret: true },
      nextdns_profile_id: { value: '<profile-id>', isSecret: true },
    });
    primeManaged({ devices: [WIN_NEW] });
    primeObservations([]);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()).toMatchObject({ status: 'compliant', violations: [] });
    expect(result).toMatchObject({ notApplicableByReason: { var_secret: 2 } });
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  // #10126 (1): derived service watches follow applicability. A rule that is
  // not applicable to a device (here: var_missing) derives no watch for it, so
  // the heartbeat never asks that device to monitor the vendor's service.
  it('derives service watches only from the rules applicable to each device (#10126)', async () => {
    // org-1: Control D ready, NextDNS var_missing. org-2: nothing ready.
    tenantVarsByOrg.set('org-1', { controld_provisioning_code: { value: '<provisioning-code>', isSecret: false } });
    const unready: Device = { ...WIN_NEW, id: 'device-2', orgId: 'org-2' };
    primeManaged({ devices: [WIN_NEW, unready] });
    primeObservations([]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted('device-1').serviceWatches).toEqual([{ name: 'ctrld' }]);
    expect(upserted('device-2').serviceWatches).toBeNull();
    // One observation read, for the one device that still has a watch.
    expect(dbSelectDistinctOnMock).toHaveBeenCalledTimes(1);
  });

  it('a device with no applicable rule gets no service watches and no observation read (#10126)', async () => {
    primeManaged({ devices: [WIN_NEW] });

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()).toMatchObject({ status: 'compliant', violations: [], serviceWatches: null });
    expect(dbSelectDistinctOnMock).not.toHaveBeenCalled();
  });

  // #10126 (2): an inventory-matched rule has no `missing` for the filter to
  // drop, so the bridge's not_running / service_unverified for it was ADDED
  // after the filter ran and reached the stored violations unfiltered.
  it.each([
    ['stopped', 'not_running'],
    [null, 'service_unverified'],
  ] as const)('an inventory-matched rule that is not applicable yields no bridge violation (fresh %s would be %s) (#10126)', async (status) => {
    primeManaged({
      devices: [WIN_NEW],
      inventory: [{ name: 'Control D (Windows)', version: '1.0.0', vendor: null, catalogId: CONTROLD }],
    });
    primeObservations(status ? [{ deviceId: 'device-1', name: 'ctrld', status, timestamp: fresh() }] : []);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()).toMatchObject({ status: 'compliant', violations: [], serviceWatches: null });
    expect(result.violations).toBe(0);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('an inventory-matched rule that IS applicable still reports a stopped client as not_running (#10126 control)', async () => {
    tenantVarsByOrg.set('org-1', { controld_provisioning_code: { value: '<provisioning-code>', isSecret: false } });
    primeManaged({
      devices: [WIN_NEW],
      inventory: [{ name: 'Control D (Windows)', version: '1.0.0', vendor: null, catalogId: CONTROLD }],
    });
    primeObservations([{ deviceId: 'device-1', name: 'ctrld', status: 'stopped', timestamp: fresh() }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const row = upserted();
    expect((row.violations as SoftwarePolicyViolation[]).map((v) => [v.type, v.rule?.catalogId])).toEqual([['not_running', CONTROLD]]);
    expect(row.serviceWatches).toEqual([{ name: 'ctrld' }]);
  });

  describe('D4 outcomes for a ready managed DNS rule with no inventory match (the rule name matches no ARP entry)', () => {
    beforeEach(() => {
      tenantVarsByOrg.set('org-1', {
        controld_provisioning_code: { value: '<provisioning-code>', isSecret: false },
        nextdns_profile_id: { value: '<profile-id>', isSecret: false },
      });
    });

    // An ARP entry that LOOKS like the vendor's (the NextDNS GUI app) must not
    // count as the managed client.
    const lookalikeInventory = [{ name: 'NextDNS', version: '3.0.0', vendor: 'NextDNS Inc.', catalogId: null }, { name: 'Control D', version: '1.0.0', vendor: 'Control D Inc.', catalogId: null }];

    it.each([
      ['not_found', ['missing', 'missing'], true],
      ['stopped', ['not_running', 'not_running'], false],
      ['running', [], false],
    ] as const)('fresh %s → %j (install queued: %s)', async (status, types, queued) => {
      primeManaged({ devices: [WIN_NEW], inventory: lookalikeInventory });
      primeObservations([
        { deviceId: 'device-1', name: 'ctrld', status, timestamp: fresh() },
        { deviceId: 'device-1', name: 'nextdns', status, timestamp: fresh() },
      ]);
      scheduleInstallMock.mockResolvedValueOnce(queued ? ['device-1'] : []);

      await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

      const row = upserted();
      expect((row.violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(types);
      expect(row.serviceWatches).toEqual([{ name: 'ctrld' }, { name: 'nextdns' }]);
      expect(scheduleInstallMock).toHaveBeenCalledTimes(queued ? 1 : 0);
      if (queued) {
        expect(scheduleInstallMock.mock.calls[0]![1]).toEqual([{ deviceId: 'device-1', catalogIds: [CONTROLD, NEXTDNS], attempt: 1 }]);
      }
    });

    it('no telemetry → service_unverified (no install, counter held, not reset)', async () => {
      primeManaged({
        devices: [WIN_NEW],
        inventory: lookalikeInventory,
        existing: [{ deviceId: 'device-1', status: 'violation', violations: [], installRemediationStatus: 'failed', installRemediationAttempts: 2 }],
      });
      primeObservations([]);

      await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

      const row = upserted();
      expect((row.violations as SoftwarePolicyViolation[]).map((v) => v.type)).toEqual(['service_unverified', 'service_unverified']);
      expect(scheduleInstallMock).not.toHaveBeenCalled();
      expect(row.installRemediationAttempts).toBeUndefined();
      expect(row.installRemediationStatus).toBeUndefined();
    });
  });
});
