/**
 * #8257: the heartbeat policy resolvers cache their resolved config in Redis
 * keyed by device id (TTL 120 s). An entry written while the device was in
 * org A must never be served once the device belongs to org B — the device
 * changed tenant, so A's resolved config is another tenant's answer.
 *
 * Each case drives the REAL resolver twice against one in-memory Redis: first
 * for org A (miss → resolve → cache), then for org B. The "DB" answers
 * differently per org, so serving A's entry to B is visible in the value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  selects: 0,
  store: new Map<string, string>(),
  context: undefined as unknown,
  resolveMonitors: vi.fn(),
}));

vi.mock('../../db', () => {
  const query = () => {
    m.selects++;
    const rows = m.rows.shift() ?? [];
    const q: any = { then: (a: any, b: any) => Promise.resolve(rows).then(a, b) };
    for (const k of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) q[k] = () => q;
    return q;
  };
  return {
    db: { select: query, execute: vi.fn().mockResolvedValue([]) },
    getCurrentDbAccessContext: () => m.context,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
    withDbTransaction: (f: any) => f(),
  };
});
vi.mock('../../services/redis', () => ({
  getRedis: () => ({
    get: vi.fn(async (k: string) => m.store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { m.store.set(k, v); return 'OK'; }),
    del: vi.fn(async (...keys: string[]) => keys.filter((k) => m.store.delete(k)).length),
  }),
}));
vi.mock('../../services/monitors/monitorResolver', () => ({ resolveMonitorsForDevice: m.resolveMonitors }));
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

import {
  buildEventLogConfigUpdate,
  buildHardwareMonitoringConfigUpdate,
  buildHelperConfigUpdate,
  buildMonitoringConfigUpdate,
  buildPamConfigUpdate,
  readCachedHelperSettings,
  resolveMonitoringConfigForDisplay,
} from './helpers';
import type { DeviceHierarchy } from '../../services/deviceHierarchy';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ORG_A = '22222222-2222-4222-8222-22222222222a';
const ORG_B = '22222222-2222-4222-8222-22222222222b';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';

const deviceIn = (orgId: string) => ({ orgId, siteId: SITE, deviceRole: 'workstation', osType: 'windows' });
/** device row, org partner, group memberships, then the feature's assignment rows. */
const hierarchyRows = (orgId: string, assignments: unknown[]) => [[deviceIn(orgId)], [{ partnerId: PARTNER }], [], assignments];

beforeEach(() => {
  m.rows = [];
  m.selects = 0;
  m.store.clear();
  m.context = undefined;
  m.resolveMonitors.mockReset().mockResolvedValue({ kind: 'resolved', monitors: [] });
});

describe('#8257 device-keyed policy caches are bound to the device org', () => {
  it('event_log: an entry cached for org A is not served for org B', async () => {
    const row = (minutes: number) => ({
      level: 'organization', assignmentPriority: 0, roleFilter: null, osFilter: null,
      retentionDays: 30, maxEventsPerCycle: 100, collectCategories: ['security'], minimumLevel: 'info',
      collectionIntervalMinutes: minutes, rateLimitPerHour: 1000,
    });

    m.rows = hierarchyRows(ORG_A, [row(5)]);
    expect((await buildEventLogConfigUpdate(DEVICE, { orgId: ORG_A })).collection_interval_minutes).toBe(5);

    m.rows = hierarchyRows(ORG_B, [row(45)]);
    expect((await buildEventLogConfigUpdate(DEVICE, { orgId: ORG_B })).collection_interval_minutes).toBe(45);
  });

  it('event_log: the same org is still a cache hit (no resolver read)', async () => {
    m.rows = hierarchyRows(ORG_A, []);
    await buildEventLogConfigUpdate(DEVICE, { orgId: ORG_A });
    m.selects = 0;
    await buildEventLogConfigUpdate(DEVICE, { orgId: ORG_A });
    expect(m.selects).toBe(0);
  });

  it('hardware_monitoring: an entry cached for org A is not served for org B', async () => {
    const row = (minutes: number) => ({
      level: 'organization', assignmentPriority: 0, roleFilter: null, osFilter: null,
      enabled: true, pollIntervalMinutes: minutes, diskHealthIntervalMinutes: 60,
    });

    m.rows = hierarchyRows(ORG_A, [row(5)]);
    expect((await buildHardwareMonitoringConfigUpdate(DEVICE, { orgId: ORG_A })).poll_interval_minutes).toBe(5);

    m.rows = hierarchyRows(ORG_B, [row(25)]);
    expect((await buildHardwareMonitoringConfigUpdate(DEVICE, { orgId: ORG_B })).poll_interval_minutes).toBe(25);
  });

  it('pam: an entry cached for org A is not served for org B', async () => {
    const row = (enabled: boolean) => ({ level: 'device', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: enabled } });

    m.rows = hierarchyRows(ORG_A, [row(true)]);
    expect((await buildPamConfigUpdate(DEVICE, { orgId: ORG_A })).uacInterceptionEnabled).toBe(true);

    m.rows = hierarchyRows(ORG_B, [row(false)]);
    expect((await buildPamConfigUpdate(DEVICE, { orgId: ORG_B })).uacInterceptionEnabled).toBe(false);
  });

  it('helper: an entry cached for org A is not served for org B', async () => {
    // No helper policy matches, so the legacy organizations.settings.helper flag decides.
    m.rows = [...hierarchyRows(ORG_A, []), [{ settings: { helper: { enabled: true } } }]];
    expect((await buildHelperConfigUpdate(DEVICE, ORG_A)).enabled).toBe(true);

    expect(await readCachedHelperSettings(DEVICE, ORG_B)).toBeNull();

    m.rows = [...hierarchyRows(ORG_B, []), [{ settings: { helper: { enabled: false } } }]];
    expect((await buildHelperConfigUpdate(DEVICE, ORG_B)).enabled).toBe(false);
  });

  it('monitoring: an entry cached for org A is served neither to the org B heartbeat nor to an org B display read', async () => {
    const queue = (orgId: string, seconds: number) => [
      [deviceIn(orgId)], [{ partnerId: PARTNER }], [],
      [{ policyId: `policy-${orgId}`, parentPolicyId: null, level: 'organization', assignmentPriority: 0 }],
      [{ policyId: `policy-${orgId}`, checkIntervalSeconds: seconds }],
    ];

    m.rows = queue(ORG_A, 30);
    expect((await buildMonitoringConfigUpdate(DEVICE, { orgId: ORG_A }))?.check_interval_seconds).toBe(30);

    // Display read for B: no ambient context here, so a miss answers null
    // ("unknown, do not filter") — never A's watch set.
    expect(await resolveMonitoringConfigForDisplay(DEVICE, ORG_B)).toBeNull();
    expect((await resolveMonitoringConfigForDisplay(DEVICE, ORG_A))?.check_interval_seconds).toBe(30);

    m.rows = queue(ORG_B, 90);
    expect((await buildMonitoringConfigUpdate(DEVICE, { orgId: ORG_B }))?.check_interval_seconds).toBe(90);
  });

  it('binds to the passed hierarchy org, and refuses a caller org that contradicts it', async () => {
    const hierarchy = (orgId: string): DeviceHierarchy => ({
      deviceId: DEVICE, orgId, siteId: SITE, deviceRole: 'workstation', osType: 'windows',
      org: { partnerId: PARTNER, type: 'customer' }, site: null, groupIds: [],
    });
    const row = { level: 'device', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } };

    // With a hierarchy the resolver skips its own device/org/group reads.
    m.rows = [[row]];
    await buildPamConfigUpdate(DEVICE, { hierarchy: hierarchy(ORG_A) });
    m.selects = 0;
    expect((await buildPamConfigUpdate(DEVICE, { hierarchy: hierarchy(ORG_A), orgId: ORG_A })).uacInterceptionEnabled).toBe(true);
    expect(m.selects).toBe(0);

    await expect(buildPamConfigUpdate(DEVICE, { hierarchy: hierarchy(ORG_B), orgId: ORG_A })).rejects.toThrow(/org/i);
  });
});
