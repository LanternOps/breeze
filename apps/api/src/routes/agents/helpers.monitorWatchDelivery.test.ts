/**
 * Service/process watch delivery from resolved MONITORS (#5287 W04, #5291).
 *
 * Before this wave the heartbeat's `monitoring_settings` block came only from
 * the config-policy Monitoring tab. W02 made `service` / `process` monitors
 * first-class authoring objects, so a technician could attach one and nothing
 * would ever reach the agent. This inverts the source of truth: monitor-derived
 * watches are computed first and the policy tab's watches are unioned over
 * them, emitting the IDENTICAL `MonitoringConfigUpdate` shape.
 *
 * Two invariants are load-bearing and both are pinned here:
 *
 *  1. **The wire shape is frozen.** `monitoring_settings` on the wire is
 *     consumed by the Go agent's `MonitorConfig` / `WatchConfig`
 *     (agent/internal/monitoring/types.go). No key added, removed or renamed.
 *     The Go side proves the same thing from its end in
 *     agent/internal/monitoring/monitor_w04_wire_test.go.
 *  2. **auto_restart is never LOWERED.** It drives the agent's offline-capable
 *     local restart. The union ORs the flag across sources; a monitor-derived
 *     watch that happens to carry no restart response must not switch off a
 *     restart the policy tab already delivers. Without that test the union is
 *     a downgrade vector.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, redisMock, getRedisImpl, ownershipMock, resolveMonitorsMock } = vi.hoisted(() => {
  let selectCallQueue: unknown[][] = [];
  let selectCallIdx = 0;

  const makeSelectChain = () => {
    const result = selectCallQueue[selectCallIdx] ?? [];
    selectCallIdx++;

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
    _resetQueue(queue: unknown[][]) {
      selectCallQueue = queue;
      selectCallIdx = 0;
      dbMock.select.mockImplementation(() => makeSelectChain());
    },
  };

  const redisMock = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };

  return {
    dbMock,
    redisMock,
    getRedisImpl: vi.fn(() => redisMock as any),
    ownershipMock: vi.fn(() => 'OWNERSHIP_CONDITION' as any),
    resolveMonitorsMock: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  // A system-context escape on this path is the forbidden request-path
  // escalation (#2417 / #1105) — the partner-wide SELECT branch is what grants
  // a partner-wide monitor definition on the agent's own context.
  runOutsideDbContext: vi.fn(() => {
    throw new Error('helpers.ts must not open a nested system DB context');
  }),
  withSystemDbAccessContext: vi.fn(() => {
    throw new Error('helpers.ts must not open a nested system DB context');
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  db: dbMock,
}));

vi.mock('../../services/configPolicyOwnership', () => ({ policyOwnershipCondition: ownershipMock }));
vi.mock('../../services/monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: resolveMonitorsMock,
}));

// The real schema module is used as-is: they are plain table descriptors and
// the mocked db never evaluates a predicate.

vi.mock('../../services/redis', () => ({ getRedis: getRedisImpl }));

const { buildMonitoringConfigUpdate } = await import('./helpers');

const DEVICE_ID = 'device-1';

/**
 * The five reads the POLICY half performs, in order. The policy half runs
 * FIRST (see resolveDeviceMonitoringSettings), so a monitor-definitions read
 * queues AFTER these.
 */
function policyQueue(opts: {
  checkIntervalSeconds?: number;
  watches?: Array<Record<string, unknown>>;
  resolved?: boolean;
}): unknown[][] {
  const resolved = opts.resolved ?? true;
  const head: unknown[][] = [
    [{ orgId: 'org-1', siteId: 'site-1' }], // devices
    [{ partnerId: 'partner-1' }], // organizations
    [], // deviceGroupMemberships
  ];
  // No matching policy row short-circuits BEFORE the watches read, so the
  // queue must not reserve a slot for it.
  if (!resolved) return [...head, []];
  return [
    ...head,
    [{ level: 'organization', assignmentPriority: 0, settingsId: 'settings-1', checkIntervalSeconds: 45 }],
    opts.watches ?? [],
  ];
}

function policyWatchRow(overrides: Record<string, unknown> = {}) {
  return {
    watchType: 'service',
    name: 'Spooler',
    alertOnStop: true,
    alertAfterConsecutiveFailures: 2,
    autoRestart: false,
    maxRestartAttempts: 3,
    restartCooldownSeconds: 300,
    cpuThresholdPercent: null,
    memoryThresholdMb: null,
    thresholdDurationSeconds: null,
    ...overrides,
  };
}

function monitorDefRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'monitor-1',
    name: 'Spooler watch',
    kind: 'service',
    enabled: true,
    condition: { serviceName: 'Spooler' },
    responses: [],
    ...overrides,
  };
}

function effectiveMonitor(overrides: Record<string, unknown> = {}) {
  return {
    monitorId: 'monitor-1',
    enabled: true,
    overrides: null,
    sourcePolicyId: 'policy-1',
    sourceLevel: 'organization',
    inheritedFromParent: false,
    ...overrides,
  };
}

describe('buildMonitoringConfigUpdate — monitor-derived watches (#5291 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null);
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [] });
  });

  it('emits exactly the frozen monitoring_settings key set', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([...policyQueue({ resolved: false }), [monitorDefRow()]]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out).not.toBeNull();
    expect(Object.keys(out!).sort()).toEqual(['check_interval_seconds', 'watches']);
    expect(out!.watches).toHaveLength(1);
    expect(Object.keys(out!.watches[0]!).sort()).toEqual([
      'alert_after_consecutive_failures',
      'alert_on_stop',
      'auto_restart',
      'max_restart_attempts',
      'name',
      'restart_cooldown_seconds',
      'watch_type',
    ]);
  });

  it('delivers a monitor-only watch when no monitoring policy resolved', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([...policyQueue({ resolved: false }), [monitorDefRow()]]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out).toEqual({
      check_interval_seconds: 60,
      watches: [
        {
          watch_type: 'service',
          name: 'Spooler',
          alert_on_stop: true,
          alert_after_consecutive_failures: 2,
          auto_restart: false,
          max_restart_attempts: 3,
          restart_cooldown_seconds: 300,
        },
      ],
    });
  });

  it('leaves a policy-only resolution byte-identical to today (regression fence)', async () => {
    dbMock._resetQueue([...policyQueue({ watches: [policyWatchRow({ autoRestart: true })] })]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out).toEqual({
      check_interval_seconds: 45,
      watches: [
        {
          watch_type: 'service',
          name: 'Spooler',
          alert_on_stop: true,
          alert_after_consecutive_failures: 2,
          auto_restart: true,
          max_restart_attempts: 3,
          restart_cooldown_seconds: 300,
        },
      ],
    });
  });

  it('keeps both watches when the monitor and the policy name DIFFERENT services', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ watches: [policyWatchRow({ name: 'W32Time' })] }),
      [monitorDefRow({ condition: { serviceName: 'Spooler' } })],
    ]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out!.watches.map((w) => w.name).sort()).toEqual(['Spooler', 'W32Time']);
  });

  it('lets the MONITOR win on a name collision (consecutiveFailures 5 beats the policy tab 2)', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ watches: [policyWatchRow({ alertAfterConsecutiveFailures: 2 })] }),
      [monitorDefRow({ condition: { serviceName: 'Spooler', consecutiveFailures: 5 } })],
    ]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out!.watches).toHaveLength(1);
    expect(out!.watches[0]!.alert_after_consecutive_failures).toBe(5);
  });

  it('never LOWERS auto_restart: a monitor with no restart response keeps the policy tab true', async () => {
    // THE auto-restart regression test. `auto_restart` drives the agent's own
    // offline-capable restart; a union that let the monitor row's `false`
    // overwrite the policy's `true` would be a silent downgrade vector.
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ watches: [policyWatchRow({ autoRestart: true })] }),
      [monitorDefRow({ responses: [] })],
    ]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out!.watches).toHaveLength(1);
    expect(out!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 3, restart_cooldown_seconds: 300 });
  });

  it('compiles a restart_service response to auto_restart on the delivered watch', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler' }] })],
    ]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 3, restart_cooldown_seconds: 300 });
  });

  it('reads max_restart_attempts / restart_cooldown_seconds from the restart_service response, defaulting 3 / 300 (W05c1 spec C9)', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler', maxAttempts: 7, cooldownSeconds: 900 }] })],
    ]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(out!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 7, restart_cooldown_seconds: 900 });

    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler' }] })],
    ]);
    const defaults = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(defaults!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 3, restart_cooldown_seconds: 300 });
  });

  it('does not infer restart intent from command text or limits', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ responses: [{ type: 'execute_command', command: 'Restart-Service Spooler', maxAttempts: 7, cooldownSeconds: 120 }] })],
    ]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(out!.watches[0]).toMatchObject({ auto_restart: false, max_restart_attempts: 3, restart_cooldown_seconds: 300 });
  });

  it.each(['service', 'process'])('delivers normalized restart limits for a %s monitor', async (kind) => {
    const { normalizeAutomationActions } = await import('../../services/automationRuntime');
    const responses = normalizeAutomationActions([
      { type: 'execute_command', command: 'echo unrelated', maxAttempts: 1, cooldownSeconds: 30 },
      { type: 'execute_command', kind: 'restart_service', command: 'restart target', maxAttempts: 7, cooldownSeconds: 120 },
    ]);
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({ resolved: false }),
      [monitorDefRow({ kind, condition: kind === 'service' ? { serviceName: 'target' } : { processName: 'target' }, responses })],
    ]);
    const out = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(out!.watches[0]).toMatchObject({ auto_restart: true, max_restart_attempts: 7, restart_cooldown_seconds: 120 });
  });

  it('falls back to the policy row for process thresholds the monitor cannot author', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor()] });
    dbMock._resetQueue([
      ...policyQueue({
        watches: [
          policyWatchRow({
            watchType: 'process',
            name: 'chrome.exe',
            cpuThresholdPercent: 80,
            memoryThresholdMb: 2048,
            thresholdDurationSeconds: 300,
          }),
        ],
      }),
      [monitorDefRow({ kind: 'process', condition: { processName: 'chrome.exe' } })],
    ]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(out!.watches).toHaveLength(1);
    expect(out!.watches[0]!.cpu_threshold_percent).toBe(80);
    expect(out!.watches[0]!.memory_threshold_mb).toBe(2048);
    expect(out!.watches[0]!.threshold_duration_seconds).toBe(300);
  });

  it('contributes nothing for a monitor whose effective attachment is disabled', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'resolved', monitors: [effectiveMonitor({ enabled: false })] });
    dbMock._resetQueue([...policyQueue({ resolved: false })]);

    const out = await buildMonitoringConfigUpdate(DEVICE_ID);

    // Contributes nothing — and with no policy either, that is the explicit
    // "nothing applies" clear, not an omitted update (#2949).
    expect(out).toEqual({ check_interval_seconds: 60, watches: [] });
  });

  it('sends an explicit EMPTY config when no policy resolves and no monitor applies — the deleted/unassigned/deactivated policy case (#2949)', async () => {
    // Before: this returned null, heartbeat.ts omitted monitoring_settings,
    // and the agent (absent key = "no change") kept the watches of a policy
    // that no longer exists — forever.
    dbMock._resetQueue([...policyQueue({ resolved: false })]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toEqual({
      check_interval_seconds: 60,
      watches: [],
    });
  });

  it('does not cache the "nothing applies" clear, so a newly assigned policy still activates on the next heartbeat', async () => {
    dbMock._resetQueue([...policyQueue({ resolved: false })]);

    await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('omits the update (null) when the POLICY side cannot find the device — a vanished device is never read as "no policy applies" (#5677)', async () => {
    // Device lookup misses on the policy side. Even if the monitor side still
    // answers "resolved, nothing", the policy answer is unknown this cycle, so
    // no clear signal may be sent.
    dbMock._resetQueue([[]]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toBeNull();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('omits the update (null) when the device\'s ORG row cannot be read — partner-level targeting would silently drop and a partner-wide policy would read as "nothing applies"', async () => {
    // devices row present, organizations row missing (org deleted mid-race).
    dbMock._resetQueue([[{ orgId: 'org-1', siteId: 'site-1' }], []]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toBeNull();
  });

  it('omits the update (null) when the monitor side reports device_missing and no policy resolved', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'device_missing' });
    dbMock._resetQueue([...policyQueue({ resolved: false })]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toBeNull();
  });

  it('still emits an EMPTY watches array when a policy resolved with zero watches (#2949)', async () => {
    // The "stop watching" signal. Collapsing this to null makes heartbeat omit
    // the block entirely and strands watches on agents forever.
    dbMock._resetQueue([...policyQueue({ watches: [] })]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toEqual({
      check_interval_seconds: 45,
      watches: [],
    });
  });

  it('never sends the #2949 clear-all signal when the device raced a delete (#5677): device_missing must not be folded into "zero monitor-derived watches"', async () => {
    // A policy resolved with zero configured watches — on its own this is the
    // legitimate #2949 "stop watching" signal (previous test). But if the
    // monitor-derived side ALSO raced a device delete and came back as a
    // fabricated `[]` instead of `device_missing`, the union below would
    // still be `{ watches: [] }` — sent to the agent as an explicit clear,
    // even though nothing was actually resolved to zero. Must return null
    // instead: omit the update this heartbeat, exactly like a missing policy
    // device lookup already does.
    resolveMonitorsMock.mockResolvedValue({ kind: 'device_missing' });
    dbMock._resetQueue([...policyQueue({ watches: [] })]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toBeNull();
  });

  it('device_missing omits the whole monitoring update even when the policy side resolved real watches — the monitor answer is unreliable this cycle, so nothing is asserted either way', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'device_missing' });
    dbMock._resetQueue([...policyQueue({ watches: [policyWatchRow()] })]);

    expect(await buildMonitoringConfigUpdate(DEVICE_ID)).toBeNull();
  });
});
