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
  const innerJoinOrgs = vi.fn(() => ({ leftJoin: leftJoinPartners }));
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
vi.mock('./patchJobExecutor', () => ({ enqueuePatchJob: vi.fn() }));
vi.mock('../services/patchJobSnapshot', () => ({ buildPatchesSnapshot: vi.fn() }));
vi.mock('../services/configPolicyPatching', () => ({
  backfillMissingPatchSettings: vi.fn(),
  listAllPatchInventory: vi.fn(),
  loadPolicyLocalPatchConfig: vi.fn(),
  summarizePatchInventory: vi.fn(),
}));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

import { __testOnly } from './patchSchedulerWorker';

const { loadDeviceSchedulingContexts } = __testOnly;

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
