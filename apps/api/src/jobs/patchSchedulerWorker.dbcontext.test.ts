import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// #1896 — patchSchedulerWorker.scanAndCreateJobs must NOT run the whole scan
// (policies → assignments → devices → maintenance checks → insert) inside ONE
// held system DB context. That single open transaction pinned a pooled
// connection for the entire multi-policy/device scan (#1105 conn-hold pattern).
// The fix gives each DB touch its OWN short context. We track context depth and
// assert: every DB op (and the per-device checkDeviceMaintenanceWindow) runs at
// depth 1, depth never nests beyond 1, and many separate contexts are opened —
// i.e. no single context spans the scan.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const dbCallDepths: number[] = [];
const maintenanceDepths: number[] = [];
let contextOpenCount = 0;
let maxDepth = 0;
let selectResults: unknown[][] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'values', 'returning',
    'set', 'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(selectResults.shift() ?? []);
    }),
    insert: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain([{ id: 'job-1' }]);
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
    delete: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextOpenCount += 1;
    contextDepth += 1;
    maxDepth = Math.max(maxDepth, contextDepth);
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: { id: 'cp.id', name: 'cp.name', orgId: 'cp.orgId', status: 'cp.status' },
  configPolicyFeatureLinks: { id: 'fl.id', configPolicyId: 'fl.cpId', featureType: 'fl.type' },
  configPolicyAssignments: { configPolicyId: 'a.cpId', level: 'a.level', targetId: 'a.targetId' },
  patchJobs: { id: 'pj.id', configPolicyId: 'pj.cpId', orgId: 'pj.orgId', createdAt: 'pj.createdAt' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: { deviceId: 'dgm.deviceId', groupId: 'dgm.groupId', orgId: 'dgm.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', settings: 'organizations.settings' },
  partners: { id: 'partners.id', timezone: 'partners.timezone', settings: 'partners.settings' },
  sites: { id: 'sites.id', timezone: 'sites.timezone' },
}));

const checkDeviceMaintenanceWindow = vi.fn(async () => {
  maintenanceDepths.push(contextDepth);
  return { active: false, suppressAlerts: false, suppressPatching: false, suppressAutomations: false, suppressScripts: false, rebootIfPending: false };
});
vi.mock('../services/featureConfigResolver', () => ({ checkDeviceMaintenanceWindow }));

const loadPolicyLocalPatchConfig = vi.fn(async () => ({
  ring: { valid: true, ringId: 'ring-1', classification: 'ok' },
  settings: { scheduleFrequency: 'daily', scheduleTime: '02:00' },
}));
vi.mock('../services/configPolicyPatching', () => ({
  backfillMissingPatchSettings: vi.fn(),
  listAllPatchInventory: vi.fn(),
  loadPolicyLocalPatchConfig,
  summarizePatchInventory: vi.fn(),
}));

const selectStaleScheduledJobIds = vi.fn(async () => {
  dbCallDepths.push(contextDepth);
  return [];
});
vi.mock('./patchJobExecutor', () => ({
  enqueuePatchJob: vi.fn(),
  selectStaleScheduledJobIds,
  filterOrphanedJobIds: vi.fn(async () => []),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/patchJobSnapshot', () => ({ buildPatchesSnapshot: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

const { __testOnly } = await import('./patchSchedulerWorker');

const { scanAndCreateJobs } = __testOnly;

describe('patchSchedulerWorker.scanAndCreateJobs — DB context boundaries (#1896)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 02:00 UTC so a daily/02:00 schedule for a UTC device is due now.
    vi.setSystemTime(new Date('2026-06-25T02:00:00.000Z'));
    contextDepth = 0;
    contextOpenCount = 0;
    maxDepth = 0;
    dbCallDepths.length = 0;
    maintenanceDepths.length = 0;
    selectResults = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs each DB op (incl. per-device maintenance check) in its own short context — no single context spans the scan', async () => {
    selectResults = [
      // 1. patchPoliciesWithSchedules
      [{ configPolicyId: 'cp-1', policyName: 'Daily Patch', policyOrgId: 'org-1', featureLinkId: 'fl-1' }],
      // 2. assignments
      [{ level: 'device', targetId: 'dev-1' }],
      // 3. resolveDeviceIdsForAssignment (device case)
      [{ id: 'dev-1' }],
      // 4. loadDeviceSchedulingContexts (join) — UTC device so 02:00 schedule is due
      [{ deviceId: 'dev-1', orgId: 'org-1', siteTimezone: 'UTC', orgSettings: null, partnerTimezone: null, partnerSettings: null }],
      // 5. hasExistingOccurrenceJob — none exists yet
      [],
    ];

    const result = await scanAndCreateJobs();

    // The due path completed end-to-end (proves we exercised maintenance + insert).
    expect(result.created).toBe(1);
    expect(checkDeviceMaintenanceWindow).toHaveBeenCalledWith('dev-1');

    // Every DB read/write ran inside a context...
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) expect(depth).toBe(1);
    // ...including the per-device maintenance lookup.
    expect(maintenanceDepths).toEqual([1]);
    // No nesting: depth never exceeded 1 (i.e. no big outer wrapper around the scan).
    expect(maxDepth).toBe(1);
    // Many SEPARATE short contexts were opened — not one spanning the whole scan.
    expect(contextOpenCount).toBeGreaterThanOrEqual(5);
  });
});
