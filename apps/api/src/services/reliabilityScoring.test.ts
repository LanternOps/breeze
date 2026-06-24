import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {}
}));

import { reliabilityScoringInternals } from './reliabilityScoring';

function makeBucket(overrides: Record<string, unknown>) {
  return {
    date: '2026-02-20',
    sampleCount: 1,
    uptimeSecondsMax: 3600,
    crashCount: 0,
    hangCount: 0,
    unresolvedHangCount: 0,
    serviceFailureCount: 0,
    recoveredServiceCount: 0,
    hardwareErrorCount: 0,
    hardwareCriticalCount: 0,
    hardwareErrorSeverityCount: 0,
    hardwareWarningCount: 0,
    ...overrides,
  };
}

function makeHistoryRow(overrides: Record<string, unknown>) {
  return {
    id: 'history-1',
    deviceId: 'device-1',
    orgId: 'org-1',
    collectedAt: new Date('2026-02-20T10:00:00.000Z'),
    uptimeSeconds: 600,
    bootTime: new Date('2026-02-20T09:50:00.000Z'),
    crashEvents: [],
    appHangs: [],
    serviceFailures: [],
    hardwareErrors: [],
    rawMetrics: {},
    ...overrides,
  };
}

describe('reliabilityScoringInternals', () => {
  it('merges multiple history rows into the same daily bucket', () => {
    const rows = [
      makeHistoryRow({
        crashEvents: [{ timestamp: '2026-02-20T10:01:00.000Z' }],
        appHangs: [{ timestamp: '2026-02-20T10:02:00.000Z', resolved: false }],
      }),
      makeHistoryRow({
        collectedAt: new Date('2026-02-20T12:00:00.000Z'),
        uptimeSeconds: 1200,
        crashEvents: [{ timestamp: '2026-02-20T12:01:00.000Z' }],
        serviceFailures: [{ timestamp: '2026-02-20T12:05:00.000Z', recovered: true }],
        hardwareErrors: [{ timestamp: '2026-02-20T12:10:00.000Z', severity: 'critical' }],
      }),
    ] as any[];

    const map = new Map<string, any>();
    reliabilityScoringInternals.mergeRowsIntoDailyBuckets(map, rows as any);
    const [bucket] = reliabilityScoringInternals.sortDailyBuckets(map);
    expect(bucket).toBeDefined();

    expect(bucket!.sampleCount).toBe(2);
    expect(bucket!.uptimeSecondsMax).toBe(1200);
    expect(bucket!.crashCount).toBe(2);
    expect(bucket!.hangCount).toBe(1);
    expect(bucket!.unresolvedHangCount).toBe(1);
    expect(bucket!.serviceFailureCount).toBe(1);
    expect(bucket!.recoveredServiceCount).toBe(1);
    expect(bucket!.hardwareCriticalCount).toBe(1);
    expect(bucket!.lastCrashAt).toBe('2026-02-20T12:01:00.000Z');
  });

  it('builds trend points only for observed days (no default-100 gaps)', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [
      makeBucket({ date: '2026-02-01', crashCount: 0 }),
      makeBucket({ date: '2026-02-10', crashCount: 1 }),
      makeBucket({ date: '2026-02-20', crashCount: 4 }),
    ] as any[];

    const points = reliabilityScoringInternals.buildDailyTrendPoints(buckets, 30, now);
    expect(points).toHaveLength(3);

    const trend = reliabilityScoringInternals.computeTrend(buckets, now);
    expect(trend.direction).toBe('degrading');
    expect(trend.confidence).toBeGreaterThan(0);
  });

  it('computes MTBF from aggregated failures and observed up-days', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    // 90 observed up-days (operating hours = 90*24 = 2160) and 9 failures → 240h.
    const buckets = [makeBucket({ date: '2026-02-20', crashCount: 9 })] as any[];

    const mtbfHours = reliabilityScoringInternals.computeMtbfHours(buckets, 90, now);
    expect(mtbfHours).toBe(240);
  });

  it('returns null MTBF when there are no observed up-days', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [makeBucket({ date: '2026-02-20', crashCount: 9 })] as any[];
    expect(reliabilityScoringInternals.computeMtbfHours(buckets, 0, now)).toBeNull();
  });

  it('parses stored aggregate state and prunes out-of-window buckets', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const state = reliabilityScoringInternals.parseAggregateState({
      aggregates: {
        lastProcessedAt: '2026-02-20T23:59:00.000Z',
        dailyBuckets: [
          makeBucket({ date: '2025-10-01', crashCount: 5 }),
          makeBucket({ date: '2026-02-20', crashCount: 1 }),
        ],
      },
    } as any, now);

    expect(state?.lastProcessedAt?.toISOString()).toBe('2026-02-20T23:59:00.000Z');
    expect(state?.dailyBuckets.size).toBe(1);
    expect(state?.dailyBuckets.has('2026-02-20')).toBe(true);
  });
});

describe('scoreUptime', () => {
  const { scoreUptime } = reliabilityScoringInternals;

  it('returns 100 at 100% uptime', () => expect(scoreUptime(100)).toBe(100));
  it('returns 0 at exactly 90% uptime (cliff boundary)', () => expect(scoreUptime(90)).toBe(0));
  it('returns 0 below 90% uptime', () => expect(scoreUptime(89)).toBe(0));
  it('returns 0 at 0%', () => expect(scoreUptime(0)).toBe(0));
  it('returns 50 at 95% uptime (midpoint of linear range)', () => expect(scoreUptime(95)).toBe(50));
});

describe('computeUptimePercent', () => {
  const { computeUptimePercent } = reliabilityScoringInternals;
  const now = new Date('2026-02-20T00:00:00.000Z');
  const DAY = 24 * 60 * 60;
  const NONE = new Set<string>(); // no observed-online days (no reliability buckets)

  function makeLatest(uptimeSeconds: number, bootOffsetSeconds: number) {
    return {
      collectedAt: now,
      uptimeSeconds,
      // bootTime = now - bootOffsetSeconds
      bootTime: new Date(now.getTime() - bootOffsetSeconds * 1000),
    };
  }

  // Day-keys (UTC) for the `now - n*DAY` calendar days, used to build the
  // "observed online" set for the established-device cases.
  function dayKeyOffset(daysAgo: number): string {
    return new Date(now.getTime() - daysAgo * DAY * 1000).toISOString().slice(0, 10);
  }

  it('returns 100 with no history snapshot', () => {
    expect(computeUptimePercent(null, NONE, 90, now)).toBe(100);
    expect(computeUptimePercent(null, NONE, 90, now, new Date(now.getTime() - 2 * DAY * 1000))).toBe(100);
  });

  it('penalizes a young device against the full window when enrollment is ignored', () => {
    // Device booted 2 days ago, no observed history, no enrollment clamp: only
    // the 3 calendar days covered by the current boot span count as up, against
    // a 91-day window ≈ 3.3%.
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now)).toBeCloseTo((3 / 91) * 100, 1);
  });

  it('clamps the window to enrollment so a 2-day-old all-up device scores 100%', () => {
    // Enrolled 2 days ago, booted at enrollment, up the whole time → 100%.
    const enrolledAt = new Date(now.getTime() - 2 * DAY * 1000);
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(100);
    expect(computeUptimePercent(latest, NONE, 30, now, enrolledAt)).toBe(100);
  });

  it('counts unobserved days within a young device lifetime as downtime', () => {
    // Enrolled 4 days ago, booted 2 days ago, and NO reliability samples for the
    // 2 pre-reboot days → only the 3 boot-covered calendar days count as up over
    // the 5-day clamped window = 60%. (Had it been reporting those days, they'd
    // be in `observedDays` and it would score ~100 — see the reboot case below.)
    const enrolledAt = new Date(now.getTime() - 4 * DAY * 1000);
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(60);
  });

  it('does NOT crater uptime for an established device that merely rebooted (the core fix)', () => {
    // Enrolled 200 days ago, reported reliability every day for the last 90 days,
    // but rebooted 5 days ago (current boot span only covers ~5 days). Under the
    // old boot-snapshot model this scored ~5/90 ≈ 5.6%. With day-coverage, every
    // day has an observed sample, so it is ~100%.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(5 * DAY, 5 * DAY); // booted 5 days ago
    const observed = new Set<string>();
    for (let d = 0; d <= 90; d += 1) observed.add(dayKeyOffset(d));
    expect(computeUptimePercent(latest, observed, 90, now, enrolledAt)).toBe(100);
  });

  it('reflects real offline gaps for an established device', () => {
    // Enrolled long ago, booted 5 days ago, but only reported on 81 of the 91
    // window days (offline ~10 days) → ~81 up-days + the boot span, ≈ 89%.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(5 * DAY, 5 * DAY);
    const observed = new Set<string>();
    // Report days 5..90 (86 days), leaving days 0..4 to the boot span; drop 10
    // older days (days 81..90 absent) to simulate an offline stretch.
    for (let d = 5; d <= 80; d += 1) observed.add(dayKeyOffset(d));
    const pct = computeUptimePercent(latest, observed, 90, now, enrolledAt);
    expect(pct).toBeGreaterThan(85);
    expect(pct).toBeLessThan(95);
  });

  it('leaves an old continuously-up device at 100', () => {
    // Enrolled 200 days ago, booted 120 days ago, up continuously → boot span
    // covers the whole window → 100% with or without observed buckets.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(120 * DAY, 120 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(computeUptimePercent(latest, NONE, 90, now));
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(100);
  });

  it('returns 100 when enrollment is at or after now (zero-length window)', () => {
    const latest = makeLatest(0, 0);
    expect(computeUptimePercent(latest, NONE, 90, now, now)).toBe(100);
    expect(computeUptimePercent(latest, NONE, 90, now, new Date(now.getTime() + DAY * 1000))).toBe(100);
  });
});

describe('scoreCrashes', () => {
  const { scoreCrashes } = reliabilityScoringInternals;

  it('returns 100 with no crashes', () => expect(scoreCrashes(0, 0)).toBe(100));
  it('reduces score proportionally', () => expect(scoreCrashes(0, 1)).toBe(80));
  it('applies 0.5x weight to 7d crashes', () => expect(scoreCrashes(2, 0)).toBe(80));
  it('clamps to 0 with many crashes', () => expect(scoreCrashes(10, 10)).toBe(0));
});

describe('scoreHangs', () => {
  const { scoreHangs } = reliabilityScoringInternals;

  it('returns 100 with no hangs', () => expect(scoreHangs(0, 0)).toBe(100));
  it('unresolved hangs carry 2x penalty vs resolved (no double-count)', () => {
    // A resolved hang costs 10 (→90); an unresolved hang costs 10 + 10 = 20
    // (→80), NOT 30. `unresolvedHangCount` is a subset of `hangCount`, so it adds
    // a single extra 10 rather than being penalised twice.
    const oneResolved = scoreHangs(1, 0);
    const oneUnresolved = scoreHangs(1, 1);
    expect(oneResolved).toBe(90);
    expect(oneUnresolved).toBe(80);
  });
  it('clamps to 0', () => expect(scoreHangs(20, 20)).toBe(0));
});

describe('scoreServiceFailures', () => {
  const { scoreServiceFailures } = reliabilityScoringInternals;

  it('returns 100 with no failures', () => expect(scoreServiceFailures(0, 0)).toBe(100));
  it('recovered services add 5 points each', () => expect(scoreServiceFailures(1, 1)).toBe(90));
  it('clamps to 0 with many failures', () => expect(scoreServiceFailures(10, 0)).toBe(0));
  it('clamps to 100 even with many recoveries', () => expect(scoreServiceFailures(0, 10)).toBe(100));
});

describe('scoreHardwareErrors', () => {
  const { scoreHardwareErrors } = reliabilityScoringInternals;

  it('returns 100 with no errors', () => expect(scoreHardwareErrors(0, 0, 0)).toBe(100));
  it('one critical error removes 30 points', () => expect(scoreHardwareErrors(1, 0, 0)).toBe(70));
  it('one error severity removes 15 points', () => expect(scoreHardwareErrors(0, 1, 0)).toBe(85));
  it('one warning removes 5 points', () => expect(scoreHardwareErrors(0, 0, 1)).toBe(95));
  it('clamps to 0 with 4+ critical errors', () => expect(scoreHardwareErrors(4, 0, 0)).toBe(0));
});

describe('scoreBand', () => {
  const { scoreBand } = reliabilityScoringInternals;

  it('returns critical at 50', () => expect(scoreBand(50)).toBe('critical'));
  it('returns poor at 51', () => expect(scoreBand(51)).toBe('poor'));
  it('returns poor at 70', () => expect(scoreBand(70)).toBe('poor'));
  it('returns fair at 71', () => expect(scoreBand(71)).toBe('fair'));
  it('returns fair at 85', () => expect(scoreBand(85)).toBe('fair'));
  it('returns good at 86', () => expect(scoreBand(86)).toBe('good'));
  it('returns good at 100', () => expect(scoreBand(100)).toBe('good'));
});

describe('computeTopIssues', () => {
  const { computeTopIssues } = reliabilityScoringInternals;
  const now = new Date('2026-02-20T00:00:00.000Z');

  it('returns empty array when all counts are zero', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    expect(issues).toHaveLength(0);
  });

  it('sets crash severity to critical at 3+ crashes', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 3,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const crashes = issues.find((i) => i.type === 'crashes');
    expect(crashes?.severity).toBe('critical');
  });

  it('caps result to 5 issues', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 5,
      hangCount30d: 5,
      serviceFailureCount30d: 5,
      hardwareErrorCount30d: 5,
      criticalHardwareCount30d: 2,
    });
    expect(issues.length).toBeLessThanOrEqual(5);
  });

  // #1738: a newly-enrolled device that has been up its whole (short) life now
  // computes uptime30d === 100 thanks to the enrollment clamp, so it must NOT
  // be flagged with an `uptime` top-issue purely for time before it existed.
  it('does not flag an uptime issue when uptime30d is 100 (young all-up device)', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
  });

  it('flags an uptime issue (warning) when uptime30d is between 90 and 95', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 92,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const uptime = issues.find((i) => i.type === 'uptime');
    expect(uptime?.severity).toBe('warning');
  });

  it('flags an uptime issue (critical) when uptime30d is below 90', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const uptime = issues.find((i) => i.type === 'uptime');
    expect(uptime?.severity).toBe('critical');
  });

  // Issue #1721: workstation/laptop roles should not be flagged with an uptime
  // top-issue, since regular sleep/shutdown is expected for those devices.
  it('suppresses the uptime issue when suppressUptimeIssue is true (low uptime)', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: true,
    });
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
  });

  it('still flags non-uptime issues when suppressUptimeIssue is true', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 3,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: true,
    });
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
    expect(issues.find((i) => i.type === 'crashes')?.severity).toBe('critical');
  });

  it('still flags the uptime issue when suppressUptimeIssue is false (default behaviour preserved)', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: false,
    });
    expect(issues.find((i) => i.type === 'uptime')?.severity).toBe('critical');
  });
});

// Issue #1721: device-type-aware reliability weight profiles.
describe('device-role weight profiles', () => {
  const {
    resolveWeightProfile,
    isWorkstationRole,
    INFRA_FACTOR_WEIGHTS,
    WORKSTATION_FACTOR_WEIGHTS,
  } = reliabilityScoringInternals;

  const sum = (w: typeof INFRA_FACTOR_WEIGHTS) =>
    w.uptime + w.crashes + w.hangs + w.serviceFailures + w.hardwareErrors;

  it('both profiles sum to 100', () => {
    expect(sum(INFRA_FACTOR_WEIGHTS)).toBe(100);
    expect(sum(WORKSTATION_FACTOR_WEIGHTS)).toBe(100);
  });

  it('the infra profile keeps the historical uptime weight of 30', () => {
    expect(INFRA_FACTOR_WEIGHTS.uptime).toBe(30);
  });

  it('the workstation profile drops uptime to zero', () => {
    expect(WORKSTATION_FACTOR_WEIGHTS.uptime).toBe(0);
  });

  it('classifies only the workstation role as workstation-class', () => {
    expect(isWorkstationRole('workstation')).toBe(true);
    expect(isWorkstationRole('server')).toBe(false);
    expect(isWorkstationRole('nas')).toBe(false);
    expect(isWorkstationRole('unknown')).toBe(false);
    expect(isWorkstationRole(null)).toBe(false);
    expect(isWorkstationRole(undefined)).toBe(false);
  });

  it('resolves the workstation profile (name + weights) for workstation devices', () => {
    const profile = resolveWeightProfile('workstation');
    expect(profile.name).toBe('workstation');
    expect(profile.weights).toBe(WORKSTATION_FACTOR_WEIGHTS);
  });

  it.each(['server', 'nas', 'router', 'switch', 'firewall', 'printer', 'unknown', null, undefined])(
    'resolves the infra profile (name + weights) for role %s',
    (role) => {
      const profile = resolveWeightProfile(role as string | null | undefined);
      expect(profile.name).toBe('infra');
      expect(profile.weights).toBe(INFRA_FACTOR_WEIGHTS);
    }
  );

  // A normally-rebooting laptop (low uptime, otherwise clean) should score far
  // higher under the workstation profile than under the infra profile, because
  // uptime no longer drags the weighted total down.
  it('a low-uptime but otherwise-clean device scores higher under the workstation profile', () => {
    const uptimeScore = 0; // <=90% uptime -> 0 on the uptime factor
    const cleanScore = 100; // no crashes/hangs/service/hardware faults
    const weighted = (w: typeof INFRA_FACTOR_WEIGHTS) =>
      (uptimeScore * w.uptime
        + cleanScore * w.crashes
        + cleanScore * w.hangs
        + cleanScore * w.serviceFailures
        + cleanScore * w.hardwareErrors) / 100;

    const infra = weighted(INFRA_FACTOR_WEIGHTS);
    const workstation = weighted(WORKSTATION_FACTOR_WEIGHTS);

    expect(infra).toBe(70); // 30% uptime weight lost entirely
    expect(workstation).toBe(100); // uptime carries no weight
    expect(workstation).toBeGreaterThan(infra);
  });
});

describe('reliability explanation drivers', () => {
  it('orders drivers by weighted lost points and keeps numeric evidence only', () => {
    const drivers = reliabilityScoringInternals.buildReliabilityDrivers({
      factors: {
        uptime: { score: 90, weight: 30, uptime30d: 99.2, ignored: 'not-number' },
        crashes: { score: 20, weight: 25, crashCount30d: 4 },
        hangs: { score: 100, weight: 15, hangCount30d: 0 },
      },
    });

    expect(drivers.map((driver) => driver.factor)).toEqual(['crashes', 'uptime', 'hangs']);
    expect(drivers[0]).toEqual(expect.objectContaining({
      factor: 'crashes',
      label: 'Crashes',
      lostPoints: 20,
      evidence: { crashCount30d: 4 },
    }));
    expect(drivers[1]?.evidence).toEqual({ uptime30d: 99.2 });
  });
});

describe('computeReliabilityEvaluationSummary', () => {
  const devices = [
    {
      deviceId: 'device-a',
      orgId: 'org-1',
      siteId: 'site-1',
      hostname: 'alpha',
      reliabilityScore: 45,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
    {
      deviceId: 'device-b',
      orgId: 'org-1',
      siteId: 'site-1',
      hostname: 'beta',
      reliabilityScore: 62,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
    {
      deviceId: 'device-c',
      orgId: 'org-1',
      siteId: 'site-2',
      hostname: 'gamma',
      reliabilityScore: 91,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
  ];

  it('computes precision from labeled at-risk devices and reports missed failures', () => {
    const summary = reliabilityScoringInternals.computeReliabilityEvaluationSummary(devices, [
      { deviceId: 'device-a', outcome: 'failure_confirmed', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
      { deviceId: 'device-b', outcome: 'false_alarm', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
      { deviceId: 'device-c', outcome: 'replaced', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
    ], { atRiskMaxScore: 70, labelWindowDays: 90 });

    expect(summary).toEqual(expect.objectContaining({
      evaluatedDevices: 3,
      atRiskDevices: 2,
      labeledAtRiskDevices: 2,
      truePositiveDevices: 1,
      falsePositiveDevices: 1,
      missedFailureDevices: 1,
      unlabeledAtRiskDevices: 0,
      confirmedFailureLabels: 1,
      replacementLabels: 1,
      falseAlarmLabels: 1,
      precision: 0.5,
    }));
  });

  it('uses the latest label per device for prediction outcome scoring', () => {
    const summary = reliabilityScoringInternals.computeReliabilityEvaluationSummary(devices, [
      { deviceId: 'device-a', outcome: 'false_alarm', occurredAt: new Date('2026-06-18T12:00:00.000Z') },
      { deviceId: 'device-a', outcome: 'failure_confirmed', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
    ], { atRiskMaxScore: 70, labelWindowDays: 90 });

    expect(summary.truePositiveDevices).toBe(1);
    expect(summary.falsePositiveDevices).toBe(0);
    expect(summary.unlabeledAtRiskDevices).toBe(1);
    expect(summary.precision).toBe(1);
  });
});
