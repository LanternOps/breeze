import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as any[][], get: vi.fn(), set: vi.fn(), execute: vi.fn(), context: undefined as any }));
vi.mock('../../db', () => {
  const query = () => {
    const rows = m.rows.shift() ?? [];
    const q: any = { then: (a: any, b: any) => Promise.resolve(rows).then(a, b) };
    for (const k of ['from', 'where', 'limit', 'innerJoin']) q[k] = () => q;
    return q;
  };
  return { db: { select: query, execute: m.execute }, getCurrentDbAccessContext: () => m.context, runOutsideDbContext: (f: any) => f(), withSystemDbAccessContext: (f: any) => f(), withDbAccessContext: (_c: any, f: any) => f() };
});
vi.mock('../../services/redis', () => ({ getRedis: () => ({ get: m.get, set: m.set }) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('../../services/filesystemAnalysis', () => ({ getFilesystemScanState: vi.fn(), mergeFilesystemAnalysisPayload: vi.fn(), parseFilesystemAnalysisStdout: vi.fn(), readCheckpointPendingDirectories: vi.fn(), readHotDirectories: vi.fn(), saveFilesystemSnapshot: vi.fn(), upsertFilesystemScanState: vi.fn() }));
vi.mock('../metrics', () => ({ recordSoftwareRemediationDecision: vi.fn(), recordSensitiveDataFinding: vi.fn(), recordSensitiveDataRemediationDecision: vi.fn() }));
vi.mock('../../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('./policyProbeSafety', () => ({ isAllowedPolicyConfigProbe: vi.fn(() => true) }));

import { buildHardwareMonitoringConfigUpdate, resolveDeviceHardwareMonitoringSettings, resolveDeviceHardwareMonitoringPolicy } from './helpers';

const id = '11111111-1111-4111-8111-111111111111';
const device = { orgId: id, siteId: id, deviceRole: 'server', osType: 'linux' };

beforeEach(() => {
  m.context = undefined;
  m.execute.mockReset().mockResolvedValue([]);
  m.rows = [];
  m.get.mockReset().mockResolvedValue(null);
  m.set.mockReset().mockResolvedValue('OK');
});

it('sends defaults when a link is removed and caches for 120 seconds', async () => {
  m.rows = [[device], [{ partnerId: id }], [], []];
  expect(await buildHardwareMonitoringConfigUpdate(id)).toEqual({ enabled: true, poll_interval_minutes: 10, disk_health_interval_minutes: 60 });
  expect(m.set).toHaveBeenCalledWith(`hwmon:settings:device:${id}`, JSON.stringify({ enabled: true, pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 }), 'EX', 120);
});

it('device assignment wins over partner and smaller priority wins ties', async () => {
  const base = { roleFilter: null, osFilter: null, enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120 };
  m.rows = [[device], [{ partnerId: id }], [], [{ ...base, level: 'partner', assignmentPriority: 0 }, { ...base, level: 'device', assignmentPriority: 5 }, { ...base, level: 'device', assignmentPriority: 1, enabled: true }]];
  expect((await resolveDeviceHardwareMonitoringSettings(id)).enabled).toBe(true);
});

it.each([
  { roleFilter: ['workstation'], osFilter: null },
  { roleFilter: null, osFilter: ['windows'] },
])('ignores an ineligible nearest assignment %j', async filters => {
  const base = { enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120, assignmentPriority: 0, policyName: 'Fleet Hardware', roleFilter: null, osFilter: null };
  m.rows = [[device], [{ partnerId: id }], [], [{ ...base, level: 'device', enabled: true, ...filters }, { ...base, level: 'partner' }]];
  expect(await resolveDeviceHardwareMonitoringPolicy(id)).toEqual({ enabled: false, source: 'policy', policyName: 'Fleet Hardware' });
});

it('uses and restores verified partner visibility on the same transaction', async () => {
  m.context = { scope: 'organization', orgId: id, accessibleOrgIds: [id], accessiblePartnerIds: [] };
  m.rows = [[device], [{ partnerId: id }], [], []];
  expect(await resolveDeviceHardwareMonitoringPolicy(id)).toEqual({ enabled: true, source: 'default' });
  expect(m.execute).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(m.execute.mock.calls[0])).toContain(id);
  expect(JSON.stringify(m.execute.mock.calls[1])).not.toContain(id);
});

it('validates cached data and propagates resolver errors instead of resetting config', async () => {
  m.get.mockResolvedValue(JSON.stringify({ enabled: false, pollIntervalMinutes: 30, diskHealthIntervalMinutes: 180 }));
  expect(await buildHardwareMonitoringConfigUpdate(id)).toEqual({ enabled: false, poll_interval_minutes: 30, disk_health_interval_minutes: 180 });
  m.get.mockResolvedValue('{');
  m.rows = [[device], [{ partnerId: id }], [], [{ level: 'device', assignmentPriority: 0, roleFilter: null, osFilter: null, pollIntervalMinutes: 1 }]];
  await expect(buildHardwareMonitoringConfigUpdate(id)).rejects.toThrow();
});
