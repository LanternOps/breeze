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
  deviceGroupMemberships: {},
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

const { loadDeviceSchedulingContexts, enqueueScanResults, resolveDeviceIdsForAssignment } = __testOnly;

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
      null
    );
    expect(ids).toEqual(['dev-a', 'dev-b']);
  });

  it('resolves an ORGANIZATION-level SUBSET assignment on a partner-owned library policy (policyOrgId null, #2280)', async () => {
    // Partner-owned policies can now carry org/site/group/device SUBSET
    // assignments (#2280 library model), not just the partner-wide 'partner'
    // level. A null policyOrgId here is the NORMAL case for those — resolution
    // must NOT no-op; it queries devices by the target org alone (no extra
    // clamp, since there's no single owning org for a library policy). This
    // branch's query shape is `.from(devices).where(...)` directly (no
    // innerJoin), which the shared module-level mock doesn't model, so this
    // test overrides db.select for its one call.
    const { db } = await import('../db');
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('organization', 'org-x', null);
    expect(ids).toEqual(['dev-a']);
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
    }, now);

    expect(filterOrphanedJobIds).toHaveBeenCalledWith([{ id: 'job-1', scheduledAt: now }, orphan]);
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-1');
    // run time already passed → no delay (undefined)
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-orphan', undefined);
    expect(enqueuePatchJob).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ enqueued: 1, recovered: 1 });
    // recovered > 0 → surfaced to Sentry so the #1733 race rate is observable
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('#1733 race active') }),
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
    }, now);

    expect(result).toEqual({ enqueued: 0, recovered: 0 });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it('recovers nothing when no scheduled rows are orphaned', async () => {
    vi.mocked(filterOrphanedJobIds).mockResolvedValueOnce([]);

    const result = await enqueueScanResults({
      enqueueJobIds: ['job-1'],
      staleScheduledJobs: [{ id: 'job-1', scheduledAt: now }],
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
    }, now);

    expect(result).toEqual({ enqueued: 1, recovered: 0 });
    expect(enqueuePatchJob).toHaveBeenCalledWith('job-1');
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});
