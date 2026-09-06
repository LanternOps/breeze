import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for loadDeviceSchedulingContexts' partner-timezone resolution
// (#1318). The scheduling context is what drives which partner-local clock a
// device's patch window is evaluated against, so the explicit -> site -> org ->
// partner -> UTC precedence (and its fallback when the partner row is absent)
// must hold. We mock only the `db` select chain and the side-effect-heavy
// service imports so the real shared `resolveEffectiveTimezone` precedence runs.

let mockRows: Array<Record<string, unknown>> = [];

// loadDeviceSchedulingContexts query shape:
//   from(devices).innerJoin(organizations).leftJoin(partners).leftJoin(sites)
//     .where(inArray(devices.id, deviceIds))
// The partners join is a LEFT join (#1318 review): under org scope the partner
// row is RLS-invisible, and an inner join would drop the device row entirely.
// The chain resolves to the rows array at the final .where() (no .limit()).
vi.mock('../db', () => {
  const where = vi.fn(() => Promise.resolve(mockRows));
  const leftJoinSites = vi.fn(() => ({ where }));
  const leftJoinPartners = vi.fn(() => ({ leftJoin: leftJoinSites }));
  // innerJoinOrgs terminates two shapes: loadDeviceSchedulingContexts chains
  // two more leftJoins; resolveDeviceIdsForAssignment's partner branch calls
  // .where() directly after the single innerJoin.
  const innerJoinOrgs = vi.fn(() => ({ leftJoin: leftJoinPartners, where }));
  const from = vi.fn(() => ({ innerJoin: innerJoinOrgs }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
  };
});

// Thin schema stub — the worker imports many tables but the unit under test
// only references them as opaque column handles passed to the mocked db chain.
vi.mock('../db/schema', () => ({
  configurationPolicies: {},
  configPolicyFeatureLinks: {},
  configPolicyAssignments: {},
  patchJobs: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
    orgId: 'deviceGroupMemberships.orgId',
  },
  deviceGroups: {
    id: 'deviceGroups.id',
    orgId: 'deviceGroups.orgId',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', settings: 'organizations.settings' },
  partners: { id: 'partners.id', timezone: 'partners.timezone', settings: 'partners.settings' },
  sites: { id: 'sites.id', timezone: 'sites.timezone' },
}));

// Side-effect-heavy imports the module pulls in at load time — stub so importing
// the worker doesn't spin up Redis/BullMQ or the full resolver graph.
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/featureConfigResolver', () => ({ checkDeviceMaintenanceWindow: vi.fn() }));
vi.mock('./patchJobExecutor', () => ({
  enqueuePatchJob: vi.fn(),
  selectStaleScheduledJobIds: vi.fn(),
  filterOrphanedJobIds: vi.fn(),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/patchJobSnapshot', () => ({ buildPatchesSnapshot: vi.fn() }));
vi.mock('../services/configPolicyPatching', () => ({
  backfillMissingPatchSettings: vi.fn(),
  listAllPatchInventory: vi.fn(),
  loadPolicyLocalPatchConfig: vi.fn(),
  summarizePatchInventory: vi.fn(),
}));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

import { __testOnly } from './patchSchedulerWorker';
import { enqueuePatchJob, filterOrphanedJobIds } from './patchJobExecutor';
import { captureException } from '../services/sentry';

const {
  loadDeviceSchedulingContexts,
  enqueueScanResults,
  resolveDeviceIdsForAssignment,
  resetReconcileTracking,
  PATCH_RECONCILE_STALL_SWEEPS,
} = __testOnly;

// Drizzle's `eq`/`and` build a real SQL AST (queryChunks tree), even though our
// mocked schema columns are plain strings rather than real Column objects —
// `sql\`${left} = ${right}\`` inserts both raw operands directly into
// queryChunks (they don't satisfy isDriverValueEncoder, so neither side gets
// wrapped in a Param). That means the exact identifiers passed to eq()/and()
// are recoverable by walking the tree, which lets a test assert on the ACTUAL
// filter values a `.where(...)` call was built with, instead of trusting a
// mock that returns a fixed row regardless of what was asked for (the gap
// this suite is closing, #2280 review).
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

describe('resolveDeviceIdsForAssignment (partner-wide patch, #1724)', () => {
  beforeEach(() => {
    mockRows = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves every device under the partner when the policy has no owning org (partner-wide)', async () => {
    // A partner-wide patch policy carries policyOrgId === null and is assigned
    // at the partner level. Resolution must NOT early-return or clamp to an org
    // — it returns all the partner's devices for the scheduler to group by org.
    mockRows = [{ id: 'dev-a' }, { id: 'dev-b' }];
    const ids = await resolveDeviceIdsForAssignment(
      'partner',
      '88888888-8888-4888-8888-888888888888',
      null,
      null
    );
    expect(ids).toEqual(['dev-a', 'dev-b']);
  });

  it('does NOT partner-clamp an org-owned policy (policyOrgId set) — existing org clamp only, no join', async () => {
    // Baseline/regression guard for the pre-#2280 org-owned path: no partner is
    // threaded through, and the resolver must not attempt an organizations join
    // (the mock chain below has no `.innerJoin`, so calling it would throw).
    const { db } = await import('../db');
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('organization', 'org-x', 'org-x', null);

    expect(ids).toEqual(['dev-a']);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('org-x');
  });

  it('re-clamps an ORGANIZATION-level SUBSET assignment on a partner-owned library policy to the policy partner (TOCTOU re-clamp, #2280 review)', async () => {
    // Partner-owned policies can now carry org/site/group/device SUBSET
    // assignments (#2280 library model), not just the partner-wide 'partner'
    // level. A null policyOrgId here is the NORMAL case for those. The target
    // org was partner-scoped at ASSIGN time only — if it's later reparented to
    // a different partner, a stale assignment row must not keep resolving those
    // devices. So resolution now re-verifies via an inner join on organizations
    // and clamps to the policy's partnerId on every run, mirroring the
    // 'partner' branch's re-verification of assignmentTargetId.
    const { db } = await import('../db');
    const { organizations } = await import('../db/schema');
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('organization', 'org-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    // Joined against organizations specifically (not some other table).
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    // The where() predicate actually carries BOTH the target-org filter and the
    // partner clamp — not just one or the other, and not a fixed mock return.
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('org-x');
    expect(whereArgs).toContain('partner-123');
  });

  it('re-clamps a SITE-level SUBSET assignment on a partner-owned library policy to the policy partner (#2280 review)', async () => {
    // Structurally parallel to the organization-level re-clamp above: the site
    // branch also joins organizations and must carry BOTH the site filter and
    // the partner clamp in its WHERE predicate.
    const { db } = await import('../db');
    const { organizations } = await import('../db/schema');
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('site', 'site-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('site-x');
    expect(whereArgs).toContain('partner-123');
  });

  it('re-clamps a DEVICE_GROUP-level SUBSET assignment on a partner-owned library policy to the policy partner (#2280 review)', async () => {
    const { db } = await import('../db');
    const { organizations, deviceGroups, devices } = await import('../db/schema');
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ deviceId: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('device_group', 'group-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    // Three joins: organizations for the partner re-clamp, deviceGroups and
    // devices for the #3182 tightened membership -> group -> device chain
    // (each carrying its own org-equality condition, not just an id match) —
    // plus the pre-existing Quick Support ephemeral exclusion on devices.
    expect(chain.innerJoin).toHaveBeenCalledTimes(3);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    expect(chain.innerJoin.mock.calls[1][0]).toBe(deviceGroups);
    expect(chain.innerJoin.mock.calls[2][0]).toBe(devices);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('group-x');
    expect(whereArgs).toContain('partner-123');
  });

  it('#3182 — device_group join conditions tie deviceGroups/devices org_id to the membership row, not just id (tightened join, org-owned branch)', async () => {
    // Structurally parallel to the #2280 partner-clamp test above, but exercises
    // the OTHER device_group branch (policyOrgId set, no partner re-clamp) so
    // there are exactly two joins to inspect. A membership row could — pre-#3182
    // composite FK — name a group in a different org than the membership itself,
    // letting a cross-org device slip through a bare id join. Asserting on the
    // actual join predicates (not just table identity) means this test fails if
    // the `eq(deviceGroups.orgId, deviceGroupMemberships.orgId)` /
    // `eq(devices.orgId, deviceGroupMemberships.orgId)` conditions are ever
    // reverted back to a bare id-equality join.
    const { db } = await import('../db');
    const { deviceGroups, devices, deviceGroupMemberships } = await import('../db/schema');
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      // Empty result simulates what a real DB would return once the tightened
      // join filters out a membership row whose group/device sit in a
      // different org than the membership itself.
      where: vi.fn(() => Promise.resolve([])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('device_group', 'group-x', 'org-y', null);

    expect(ids).toEqual([]);
    expect(chain.innerJoin).toHaveBeenCalledTimes(2);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(deviceGroups);
    expect(chain.innerJoin.mock.calls[1][0]).toBe(devices);

    const groupJoinArgs = collectSqlLeafStrings(chain.innerJoin.mock.calls[0][1]);
    expect(groupJoinArgs).toContain(deviceGroupMemberships.groupId);
    expect(groupJoinArgs).toContain(deviceGroups.id);
    expect(groupJoinArgs).toContain(deviceGroups.orgId);
    expect(groupJoinArgs).toContain(deviceGroupMemberships.orgId);

    const deviceJoinArgs = collectSqlLeafStrings(chain.innerJoin.mock.calls[1][1]);
    expect(deviceJoinArgs).toContain(deviceGroupMemberships.deviceId);
    expect(deviceJoinArgs).toContain(devices.id);
    expect(deviceJoinArgs).toContain(devices.orgId);
    expect(deviceJoinArgs).toContain(deviceGroupMemberships.orgId);
  });

  it('re-clamps a DEVICE-level SUBSET assignment on a partner-owned library policy to the policy partner (#2280 review)', async () => {
    // The device branch additionally chains .limit(1) after .where(), unlike
    // the site/device_group/organization branches above.
    const { db } = await import('../db');
    const { organizations } = await import('../db/schema');
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('device', 'dev-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('dev-x');
    expect(whereArgs).toContain('partner-123');
  });
});

describe('loadDeviceSchedulingContexts (#1318 partner tz)', () => {
  beforeEach(() => {
    mockRows = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty array without querying when no device ids are given', async () => {
    expect(await loadDeviceSchedulingContexts([])).toEqual([]);
  });

  it('applies the partner timezone column when site and org are unset (partner visible)', async () => {
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: null,
        orgSettings: {},
        partnerTimezone: 'Europe/London',
        partnerSettings: {},
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx).toMatchObject({ deviceId: 'dev-1', orgId: 'org-1', timezone: 'Europe/London' });
  });

  it('reads the legacy partner settings.timezone key when the column is still default UTC', async () => {
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: null,
        orgSettings: {},
        partnerTimezone: 'UTC',
        partnerSettings: { timezone: 'Asia/Tokyo' },
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx?.timezone).toBe('Asia/Tokyo');
  });

  it('prefers site over org over partner (precedence)', async () => {
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: 'America/Chicago',
        orgSettings: { timezone: 'America/Denver' },
        partnerTimezone: 'America/Los_Angeles',
        partnerSettings: {},
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx?.timezone).toBe('America/Chicago');
  });

  it('falls back to the org tz when the partner row is absent (RLS-invisible left join)', async () => {
    // Under a hypothetical org-scoped read the leftJoin yields null partner
    // columns. The device row must survive (left, not inner join) and resolve
    // through site -> org. An inner join would drop the device entirely.
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: null,
        orgSettings: { timezone: 'America/Denver' },
        partnerTimezone: null,
        partnerSettings: null,
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx?.timezone).toBe('America/Denver');
  });

  it('falls back to UTC when nothing (incl. partner) resolves', async () => {
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: null,
        orgSettings: {},
        partnerTimezone: 'UTC',
        partnerSettings: {},
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx?.timezone).toBe('UTC');
  });

  it('coerces a garbage stored tz to UTC via normalizeTimezone', async () => {
    mockRows = [
      {
        deviceId: 'dev-1',
        orgId: 'org-1',
        siteTimezone: 'Not/AZone',
        orgSettings: {},
        partnerTimezone: 'UTC',
        partnerSettings: {},
      },
    ];
    const [ctx] = await loadDeviceSchedulingContexts(['dev-1']);
    expect(ctx?.timezone).toBe('UTC');
  });
});

describe('enqueueScanResults orphan reconcile (#1733)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The streak tracking behind the BREEZE-1A stall escalation is module-level
    // (the scheduler is a singleton), so it must be cleared between cases.
    resetReconcileTracking();
  });

  const now = new Date('2026-06-21T09:00:00Z');

  it('enqueues created jobs then re-enqueues only the orphaned scheduled jobs', async () => {
    // staleScheduledJobs includes the just-created job-1 (already enqueued) plus
    // job-orphan (lost its enqueue, past run time). filterOrphanedJobIds is what
    // distinguishes them — here it reports only job-orphan as needing recovery.
    const orphan = { id: 'job-orphan', scheduledAt: new Date('2026-06-21T08:00:00Z') };
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([orphan]);

    const result = await enqueueScanResults({
      enqueueJobIds: ['job-1'],
      staleScheduledJobs: [{ id: 'job-1', scheduledAt: now }, orphan],
      staleScheduledJobsComplete: true,
    }, now);

    expect(filterOrphanedJobIds).toHaveBeenCalledWith([{ id: 'job-1', scheduledAt: now }, orphan]);
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-1');
    // run time already passed → no delay (undefined)
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-orphan', undefined);
    expect(enqueuePatchJob).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ enqueued: 1, recovered: 1 });
    // A NEW orphan is surfaced so the #1733 race rate stays observable — but as
    // a named, warning-level notice, not an anonymous error (BREEZE-1A).
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'PatchOrphanRecoveredNotice',
        message: expect.stringContaining('#1733 race active'),
      }),
      undefined,
      { patch_reconcile_stage: 'recovered', patch_reconcile_repeat: '1' },
    );
  });

  it('preserves the remaining delay when recovering a future-scheduled orphan (regression: no early fire)', async () => {
    // A POST-route job scheduled 1h in the future whose delayed enqueue was lost.
    // Recovering it must NOT fire immediately — it must re-enqueue with the
    // remaining delay so it runs at its intended window.
    const futureOrphan = { id: 'job-future', scheduledAt: new Date('2026-06-21T10:00:00Z') };
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([futureOrphan]);

    const result = await enqueueScanResults({
      enqueueJobIds: [],
      staleScheduledJobs: [futureOrphan],
      staleScheduledJobsComplete: true,
    }, now);

    // 10:00 - 09:00 = 3,600,000ms remaining delay
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-future', 60 * 60 * 1000);
    expect(result).toEqual({ enqueued: 0, recovered: 1 });
  });

  it('does not throw or skip recovery when a fresh enqueue fails (still sweeps orphans)', async () => {
    const orphan = { id: 'job-orphan', scheduledAt: null };
    vi.mocked(enqueuePatchJob)
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue(undefined);
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([orphan]);

    const result = await enqueueScanResults({
      enqueueJobIds: ['job-fresh'],
      staleScheduledJobs: [orphan],
      staleScheduledJobsComplete: true,
    }, now);

    // fresh enqueue threw → enqueued stays 0, but the orphan sweep still ran
    expect(result).toEqual({ enqueued: 0, recovered: 1 });
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-orphan', undefined);
  });

  it('surfaces a failed orphan re-enqueue to Sentry (a lost run staying lost is page-worthy)', async () => {
    const orphan = { id: 'job-orphan', scheduledAt: null };
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([orphan]);
    vi.mocked(enqueuePatchJob).mockRejectedValueOnce(new Error('redis down'));

    const result = await enqueueScanResults({
      enqueueJobIds: [],
      staleScheduledJobs: [orphan],
      staleScheduledJobsComplete: true,
    }, now);

    expect(result).toEqual({ enqueued: 0, recovered: 0 });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { patch_reconcile_stage: 'enqueue_failed' },
    );
  });

  it('recovers nothing when no scheduled rows are orphaned', async () => {
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([]);

    const result = await enqueueScanResults({
      enqueueJobIds: ['job-1'],
      staleScheduledJobs: [{ id: 'job-1', scheduledAt: now }],
      staleScheduledJobsComplete: true,
    }, now);

    expect(result).toEqual({ enqueued: 1, recovered: 0 });
    expect(enqueuePatchJob).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('swallows a reconcile-sweep failure without losing the fresh enqueues (but surfaces it)', async () => {
    vi.mocked(filterOrphanedJobIds).mockRejectedValueOnce(new Error('queue read failed'));

    const result = await enqueueScanResults({
      enqueueJobIds: ['job-1'],
      staleScheduledJobs: [{ id: 'job-1', scheduledAt: now }],
      staleScheduledJobsComplete: true,
    }, now);

    expect(result).toEqual({ enqueued: 1, recovered: 0 });
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-1');
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { patch_reconcile_stage: 'sweep_failed' },
    );
  });
});

// BREEZE-1A: 342 error-level events over 19 days, every one of them saying the
// backstop "recovered" something and none of them saying it was the SAME row on
// every scheduler tick. A healthy recovery is visible for exactly one sweep
// (processExecutePatchJob claims the row out of `scheduled`), so a streak means
// the re-enqueue is not taking effect.
describe('enqueueScanResults reconcile reporting (BREEZE-1A)', () => {
  const now = new Date('2026-06-21T09:00:00Z');
  const orphan = { id: 'job-stuck', scheduledAt: null };

  beforeEach(() => {
    vi.clearAllMocks();
    resetReconcileTracking();
  });

  async function sweepRecovering(ids: string[]) {
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce(
      ids.map((id) => ({ id, scheduledAt: null })),
    );
    return enqueueScanResults(
      { enqueueJobIds: [], staleScheduledJobs: [], staleScheduledJobsComplete: true },
      now,
    );
  }

  function noticeCalls() {
    return vi.mocked(captureException).mock.calls.filter(
      ([err]) => (err as Error)?.name === 'PatchOrphanRecoveredNotice',
    );
  }

  function stallCalls() {
    return vi.mocked(captureException).mock.calls.filter(
      ([err]) => (err as Error)?.name === 'PatchReconcileStalledError',
    );
  }

  it('reports the same orphan once, not once per sweep, below the stall threshold', async () => {
    for (let sweep = 0; sweep < PATCH_RECONCILE_STALL_SWEEPS - 1; sweep += 1) {
      await sweepRecovering([orphan.id]);
    }

    expect(noticeCalls()).toHaveLength(1);
    expect(stallCalls()).toHaveLength(0);
  });

  it('escalates to a named error exactly once when a job keeps being re-enqueued', async () => {
    for (let sweep = 0; sweep < PATCH_RECONCILE_STALL_SWEEPS + 3; sweep += 1) {
      await sweepRecovering([orphan.id]);
    }

    const stalls = stallCalls();
    expect(stalls).toHaveLength(1);
    expect((stalls[0]?.[0] as Error).message).toContain('job-stuck');
    expect(stalls[0]?.[2]).toEqual({
      patch_reconcile_stage: 'stalled',
      patch_reconcile_repeat: '5-9',
    });
  });

  it('resets a streak once the job stops being recovered, and re-reports it as new', async () => {
    await sweepRecovering([orphan.id]);
    await sweepRecovering([orphan.id]);
    // Sweep that recovered nothing → the row left `scheduled`, streak is over.
    await sweepRecovering([]);
    await sweepRecovering([orphan.id]);

    // Two separate episodes → two "new orphan" notices, no stall escalation.
    expect(noticeCalls()).toHaveLength(2);
    expect(stallCalls()).toHaveLength(0);
  });

  it('does not clear streaks when the queue-state pass itself throws', async () => {
    for (let sweep = 0; sweep < PATCH_RECONCILE_STALL_SWEEPS - 1; sweep += 1) {
      await sweepRecovering([orphan.id]);
    }
    // A sweep that throws knows nothing about which ids are still orphaned; if
    // it cleared the streak the stall would never be reachable under a flapping
    // Redis connection — exactly the condition that strands the row.
    vi.mocked(filterOrphanedJobIds).mockRejectedValueOnce(new Error('queue read failed'));
    await enqueueScanResults(
      { enqueueJobIds: [], staleScheduledJobs: [], staleScheduledJobsComplete: true },
      now,
    );

    await sweepRecovering([orphan.id]);

    expect(stallCalls()).toHaveLength(1);
  });

  // The production shape of a failed sweep, and the one the try/catch could NOT
  // see. When selectStaleScheduledJobIds rejects, scanAndCreateJobs hands back
  // `staleScheduledJobs: []` — and filterOrphanedJobIds([]) early-returns []
  // WITHOUT throwing (pinned by patchJobExecutor.test.ts,
  // "filterOrphanedJobIds short-circuits on an empty list"), so nothing
  // downstream can be mocked into
  // rejecting here without inventing a failure that production never produces.
  // The sweep therefore looked complete and wiped every streak. One failed read
  // per <=4 minutes then holds the counter under PATCH_RECONCILE_STALL_SWEEPS
  // forever: the error-level escalation becomes unreachable while the
  // warning-level notice re-fires — a severity downgrade on a stranded run.
  describe('a stale-jobs read that failed', () => {
    beforeEach(() => {
      // Real behaviour, not a convenience stub: `if (jobs.length === 0) return [];`
      vi.mocked(filterOrphanedJobIds).mockImplementation(
        async (jobs) => (jobs.length === 0 ? [] : jobs),
      );
    });

    async function failedReadSweep() {
      return enqueueScanResults(
        // Exactly what scanAndCreateJobs returns when the read rejects — see
        // patchSchedulerWorker.dbcontext.test.ts for that half of the chain.
        { enqueueJobIds: [], staleScheduledJobs: [], staleScheduledJobsComplete: false },
        now,
      );
    }

    it('leaves the streak intact instead of reporting an all-clear sweep', async () => {
      for (let sweep = 0; sweep < PATCH_RECONCILE_STALL_SWEEPS - 1; sweep += 1) {
        await sweepRecovering([orphan.id]);
      }

      await failedReadSweep();
      await sweepRecovering([orphan.id]);

      // Streak survived the blind sweep and reached the threshold.
      expect(stallCalls()).toHaveLength(1);
    });

    it('keeps the stall escalation reachable when reads fail between every sweep', async () => {
      for (let sweep = 0; sweep < PATCH_RECONCILE_STALL_SWEEPS; sweep += 1) {
        await sweepRecovering([orphan.id]);
        await failedReadSweep();
      }

      // Before the fix: every failed read reset the streak to 0, so `sweeps`
      // never passed 1 — no stall event ever, and one fresh-orphan WARNING per
      // recovery instead.
      expect(stallCalls()).toHaveLength(1);
      expect(noticeCalls()).toHaveLength(1);
    });

    it('reports nothing new of its own — the read failure is reported by the scan', async () => {
      await sweepRecovering([orphan.id]);
      vi.mocked(captureException).mockClear();

      await failedReadSweep();

      expect(captureException).not.toHaveBeenCalled();
    });
  });

  // The primary enqueue path. enqueuePatchJob can now throw
  // StaleQueueJobRemovalError, which PROVES the job was not queued — and the
  // reconcile sweep deliberately skips that same wedged id, so console-only
  // logging left a lost run with no Sentry event anywhere.
  it('reports a failure to enqueue a freshly created job', async () => {
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([]);
    const wedged = new Error('re-enqueuing this id would be a silent no-op');
    vi.mocked(enqueuePatchJob).mockRejectedValueOnce(wedged);

    const result = await enqueueScanResults(
      { enqueueJobIds: ['job-new'], staleScheduledJobs: [], staleScheduledJobsComplete: true },
      now,
    );

    expect(result).toEqual({ enqueued: 0, recovered: 0 });
    expect(captureException).toHaveBeenCalledWith(
      wedged,
      undefined,
      { patch_reconcile_stage: 'scheduled_enqueue_failed' },
    );
  });

  it('counts distinct new orphans in one sweep as a single notice', async () => {
    await sweepRecovering(['job-a', 'job-b', 'job-c']);

    const notices = noticeCalls();
    expect(notices).toHaveLength(1);
    expect((notices[0]?.[0] as Error).message).toContain('Recovered 3');
  });
});
