/**
 * #6958 PR E4: service watches DERIVED from software-policy compliance rows
 * (`software_compliance_status.service_watches`), unioned into the heartbeat's
 * monitoring config.
 *
 * The mocked db returns queued rows unconditionally and cannot evaluate a
 * WHERE clause, so the freshness / is_active filters are proven against real
 * Postgres in __tests__/integration/softwareServiceWatchDelivery.integration.test.ts;
 * here the pins are the decisions the resolver makes in TypeScript: arming
 * from the live policy row, dedupe/precedence, cap, interval, the
 * statement-free pre-filter on the beat's policy set, and no system escape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, redisMock, resolveMonitorsMock, ctxMock } = vi.hoisted(() => {
  let queue: unknown[][] = [];
  let idx = 0;
  const makeSelectChain = () => {
    const result = queue[idx] ?? [];
    idx++;
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
    return chain;
  };
  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _resetQueue(next: unknown[][]) {
      queue = next;
      idx = 0;
      dbMock.select.mockImplementation(() => makeSelectChain());
    },
  };
  return {
    dbMock,
    redisMock: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
    resolveMonitorsMock: vi.fn(),
    ctxMock: vi.fn(() => undefined as unknown),
  };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn(() => {
    throw new Error('helpers.ts must not open a nested system DB context');
  }),
  withSystemDbAccessContext: vi.fn(() => {
    throw new Error('helpers.ts must not open a nested system DB context');
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: ctxMock,
  db: dbMock,
}));
vi.mock('../../services/configPolicyOwnership', () => ({ policyOwnershipCondition: vi.fn(() => 'OWNERSHIP' as any) }));
vi.mock('../../services/monitors/monitorResolver', () => ({ resolveMonitorsForDevice: resolveMonitorsMock }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => redisMock as any) }));

const dbModule = await import('../../db');
const {
  buildMonitoringConfigUpdate,
  resolveMonitoringConfigForDisplay,
  resolveSoftwarePolicyServiceWatches,
  SOFTWARE_SERVICE_ONLY_CHECK_INTERVAL_SECONDS,
  SOFTWARE_SERVICE_WATCH_STALE_MS,
} = await import('./helpers');
import type { DevicePolicySet, PolicyCandidate, PolicySetLink } from '../../services/devicePolicySet';

const DEVICE_ID = 'device-1';
const ORG_ID = 'org-1';
const PARTNER_ID = 'partner-1';

const ARMED = { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } };

function statusRow(names: string[], policy: Record<string, unknown> = ARMED) {
  return { serviceWatches: names.map((name) => ({ name })), ...policy };
}

function link(featureType: PolicySetLink['featureType']): PolicySetLink {
  return {
    id: `link-${featureType}`, featureType, featurePolicyId: featureType === 'software_policy' ? 'sw-1' : null,
    inlineSettings: null, eventLog: null, hardwareMonitoring: null, patch: null, timeSync: null, onedrive: null,
  };
}

function candidate(links: Partial<Record<PolicySetLink['featureType'], PolicySetLink>>, overrides: Partial<PolicyCandidate> = {}): PolicyCandidate {
  return {
    assignmentId: 'a-1', level: 'organization', targetId: ORG_ID, priority: 0, roleFilter: null, osFilter: null,
    assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'), policyId: 'cp-1', policyName: 'cp', policyOrgId: ORG_ID,
    policyPartnerId: null, parentPolicyId: null, links, ...overrides,
  };
}

function policySet(candidates: PolicyCandidate[], orgType = 'customer'): { hierarchy: DevicePolicySet['hierarchy']; policySet: DevicePolicySet } {
  const hierarchy = {
    deviceId: DEVICE_ID, orgId: ORG_ID, siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
    org: { partnerId: PARTNER_ID, type: orgType }, site: { id: 'site-1', name: 's', timezone: 'UTC' }, groupIds: [],
  };
  return { hierarchy, policySet: { deviceId: DEVICE_ID, hierarchy, candidates } };
}

const SET_WITH_SOFTWARE = () => policySet([candidate({ software_policy: link('software_policy') })]);

function monitorDef(serviceName: string, responses: unknown[] = []) {
  return { id: 'monitor-1', kind: 'service', condition: { serviceName }, responses };
}

describe('resolveSoftwarePolicyServiceWatches (#6958 PR E4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null);
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [] });
    ctxMock.mockReturnValue(undefined);
  });

  it('pins the staleness window and the service-only interval', () => {
    expect(SOFTWARE_SERVICE_WATCH_STALE_MS).toBe(30 * 60 * 1000);
    expect(SOFTWARE_SERVICE_ONLY_CHECK_INTERVAL_SECONDS).toBe(300);
  });

  it('(a) a fresh row on an active armed policy delivers the watch with auto_restart', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE())).toEqual([{
      watch_type: 'service', name: 'ctrld', alert_on_stop: false, alert_after_consecutive_failures: 2,
      auto_restart: true, max_restart_attempts: 3, restart_cooldown_seconds: 300,
    }]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('(b)/(c) stale rows and inactive policies are excluded by the query (no row → no watch)', async () => {
    dbMock._resetQueue([[]]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE())).toEqual([]);
  });

  it.each([
    ['enforceMode off', { ...ARMED, enforceMode: false }],
    ['autoInstall absent', { ...ARMED, remediationOptions: {} }],
    ['audit mode', { ...ARMED, mode: 'audit' }],
  ])('(c) a disarmed policy (%s) still delivers the watch, with auto_restart false', async (_label, policy) => {
    dbMock._resetQueue([[statusRow(['ctrld'], policy)]]);
    const [watch] = await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(watch).toMatchObject({ name: 'ctrld', auto_restart: false });
  });

  it('a name under two policies is armed if any policy is armed, and is delivered once', async () => {
    dbMock._resetQueue([[statusRow(['CtrlD'], { ...ARMED, enforceMode: false }), statusRow(['ctrld'])]]);
    const watches = await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ name: 'CtrlD', auto_restart: true });
  });

  it('ignores malformed service_watches entries', async () => {
    dbMock._resetQueue([[{ ...ARMED, serviceWatches: [{ name: '' }, { nope: 1 }, 'x', { name: 'ctrld' }] }, { ...ARMED, serviceWatches: 'bad' }]]);
    expect((await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE())).map((w) => w.name)).toEqual(['ctrld']);
  });

  it('(h) 60 derived names → the first 50 after a case-insensitive sort', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `svc-${String(59 - i).padStart(2, '0')}`);
    dbMock._resetQueue([[statusRow(names)]]);
    const watches = await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(watches).toHaveLength(50);
    expect(watches[0]!.name).toBe('svc-00');
    expect(watches[49]!.name).toBe('svc-49');
  });

  it('(g) a beat policy set whose applicable candidates carry neither link → [] with ZERO statements', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    const opts = policySet([candidate({ pam: link('pam') })]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, opts)).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('(g) a software_policy link on a candidate that does NOT apply (another org) still pre-filters to zero statements', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    const opts = policySet([candidate({ software_policy: link('software_policy') }, { policyOrgId: 'org-other' })]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, opts)).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('(g) an unassigned-pool device does not admit its partner\'s partner-wide software_policy link', async () => {
    const opts = policySet([candidate({ software_policy: link('software_policy') }, {
      policyOrgId: null, policyPartnerId: PARTNER_ID, level: 'partner', targetId: PARTNER_ID,
    })], 'unassigned_pool');
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, opts)).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('a security_agents link alone passes the pre-filter (generated policies) and runs the query', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    const opts = policySet([candidate({ security_agents: link('security_agents') })]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID, opts)).toHaveLength(1);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('without a policy set (display / set-error path) the query runs', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    expect(await resolveSoftwarePolicyServiceWatches(DEVICE_ID)).toHaveLength(1);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('(i) never opens a system DB context', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    await resolveSoftwarePolicyServiceWatches(DEVICE_ID, SET_WITH_SOFTWARE());
    await resolveSoftwarePolicyServiceWatches(DEVICE_ID);
    expect(dbModule.withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(dbModule.runOutsideDbContext).not.toHaveBeenCalled();
  });
});

describe('buildMonitoringConfigUpdate — derived software watches (#6958 PR E4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null);
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [] });
    ctxMock.mockReturnValue(undefined);
  });

  it('(e) only derived watches → resolved, check_interval_seconds 300 (not none_applies)', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(out).toEqual({
      check_interval_seconds: 300,
      watches: [expect.objectContaining({ watch_type: 'service', name: 'ctrld', auto_restart: true })],
    });
    // `resolved` is cached; `none_applies` is not.
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it('emits exactly the frozen monitoring_settings watch key set for a derived watch', async () => {
    dbMock._resetQueue([[statusRow(['ctrld'])]]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(Object.keys(out!.watches[0]!).sort()).toEqual([
      'alert_after_consecutive_failures', 'alert_on_stop', 'auto_restart', 'max_restart_attempts',
      'name', 'restart_cooldown_seconds', 'watch_type',
    ]);
  });

  it('no derived and no monitor watch → none_applies (explicit clear, not cached)', async () => {
    dbMock._resetQueue([[]]);
    expect(await buildMonitoringConfigUpdate(DEVICE_ID, SET_WITH_SOFTWARE())).toEqual({ check_interval_seconds: 60, watches: [] });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('(d)/(f) a monitor watch "CtrlD" wins over a derived "ctrld"; monitors keep the existing 60 s interval', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'monitor-1', enabled: true, overrides: null }] });
    dbMock._resetQueue([[monitorDef('CtrlD')], [statusRow(['ctrld', 'nextdns'])]]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(out!.check_interval_seconds).toBe(60);
    expect(out!.watches).toEqual([
      expect.objectContaining({ name: 'CtrlD', alert_on_stop: true, auto_restart: false }),
      expect.objectContaining({ name: 'nextdns', alert_on_stop: false, auto_restart: true }),
    ]);
  });

  it('a PROCESS monitor watch of the same name does not suppress the derived service watch', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'monitor-1', enabled: true, overrides: null }] });
    dbMock._resetQueue([[{ id: 'monitor-1', kind: 'process', condition: { processName: 'ctrld' }, responses: [] }], [statusRow(['ctrld'])]]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, SET_WITH_SOFTWARE());
    expect(out!.watches.map((w) => `${w.watch_type}:${w.name}`)).toEqual(['process:ctrld', 'service:ctrld']);
  });

  it('(f) a monitors-link interval still wins when derived watches are present', async () => {
    const opts = policySet([candidate({ software_policy: link('software_policy'), monitors: link('monitors') })]);
    dbMock._resetQueue([[{ policyId: 'cp-1', checkIntervalSeconds: 45 }], [statusRow(['ctrld'])]]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, opts);
    expect(out).toEqual({ check_interval_seconds: 45, watches: [expect.objectContaining({ name: 'ctrld' })] });
  });

  it('(g) the beat with a set carrying neither link spends zero statements on monitoring', async () => {
    dbMock._resetQueue([]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID, policySet([candidate({ pam: link('pam') })]));
    expect(out).toEqual({ check_interval_seconds: 60, watches: [] });
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('(j) resolveMonitoringConfigForDisplay includes derived watches', async () => {
    ctxMock.mockReturnValue({ scope: 'organization', currentPartnerId: PARTNER_ID });
    dbMock._resetQueue([
      [{ orgId: ORG_ID, siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' }],
      [{ partnerId: PARTNER_ID }],
      [],
      [],
      [statusRow(['ctrld'])],
    ]);
    const out = await resolveMonitoringConfigForDisplay(DEVICE_ID, ORG_ID);
    expect(out).toEqual({ check_interval_seconds: 300, watches: [expect.objectContaining({ name: 'ctrld' })] });
    expect(dbModule.withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
