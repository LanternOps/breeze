import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for automationWorker's config-policy assignment device
// resolution (#2286) — the automation-run sibling of the patch-scheduler
// TOCTOU clamp added in PR #2285 (#2280 review). These tests prove the query
// SHAPE: that a partner-owned library policy's SUBSET assignment resolution
// joins organizations and carries BOTH the target filter and the policy's
// partner clamp in its WHERE predicate, and that an org-owned policy keeps its
// org clamp without the join. The real-Postgres enforcement proof lives in
// __tests__/integration/automationWorkerPartnerResolution.integration.test.ts.

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

// Thin schema stub — the worker imports many tables but the unit under test
// only references them as opaque column handles passed to the mocked db chain.
vi.mock('../db/schema', () => ({
  automations: {},
  configPolicyAutomations: {},
  configPolicyFeatureLinks: {},
  configurationPolicies: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
    orgId: 'deviceGroupMemberships.orgId',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
}));

// Side-effect-heavy imports the module pulls in at load time — stub so importing
// the worker doesn't spin up Redis/BullMQ or the full resolver graph.
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('../services/eventBus', () => ({ getEventBus: vi.fn() }));
vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: vi.fn(),
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(),
  normalizeAutomationTrigger: vi.fn(),
}));
vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(),
}));
vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn() }));
vi.mock('../services/bullmqValidation', () => ({
  assertQueueJobName: vi.fn(),
  parseQueueJobData: vi.fn(),
}));
vi.mock('./queueSchemas', () => ({ automationQueueJobDataSchema: {} }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { __testOnly } from './automationWorker';
import { db } from '../db';
import { organizations } from '../db/schema';

const { resolveDeviceIdsForAssignment } = __testOnly;

// Drizzle's `eq`/`and` build a real SQL AST (queryChunks tree), even though our
// mocked schema columns are plain strings rather than real Column objects —
// `sql\`${left} = ${right}\`` inserts both raw operands directly into
// queryChunks (they don't satisfy isDriverValueEncoder, so neither side gets
// wrapped in a Param). That means the exact identifiers passed to eq()/and()
// are recoverable by walking the tree, which lets a test assert on the ACTUAL
// filter values a `.where(...)` call was built with, instead of trusting a
// mock that returns a fixed row regardless of what was asked for.
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

describe('automationWorker resolveDeviceIdsForAssignment — partner re-clamp (#2286)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('does NOT partner-clamp an org-owned policy (policyOrgId set) — org clamp only, no join', async () => {
    // The mock chain below has no `.innerJoin`, so attempting the organizations
    // join would throw — proving the org-owned path stays join-free.
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

  it('re-clamps an ORGANIZATION-level SUBSET assignment on a partner-owned library policy to the policy partner', async () => {
    // Partner-owned policies can carry org/site/group/device SUBSET assignments
    // (#2280 library model); a null policyOrgId is the NORMAL case for those.
    // The target org was partner-scoped at ASSIGN time only — if it's later
    // reparented to a different partner, a stale assignment row must not keep
    // resolving those devices.
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('organization', 'org-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    // The where() predicate carries BOTH the target-org filter and the partner
    // clamp — not just one or the other, and not a fixed mock return.
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('org-x');
    expect(whereArgs).toContain('partner-123');
  });

  it('re-clamps a SITE-level SUBSET assignment on a partner-owned library policy to the policy partner', async () => {
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

  it('re-clamps a DEVICE_GROUP-level SUBSET assignment on a partner-owned library policy to the policy partner', async () => {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ deviceId: 'dev-a' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('device_group', 'group-x', null, 'partner-123');

    expect(ids).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('group-x');
    expect(whereArgs).toContain('partner-123');
  });

  it('re-clamps a DEVICE-level SUBSET assignment on a partner-owned library policy to the policy partner', async () => {
    // The device branch additionally chains .limit(1) after .where(), unlike
    // the site/device_group/organization branches above.
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

  it('resolves a partner-level assignment via a single organizations join on the target partner', async () => {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-a' }, { id: 'dev-b' }])),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const ids = await resolveDeviceIdsForAssignment('partner', 'partner-123', null, 'partner-123');

    expect(ids).toEqual(['dev-a', 'dev-b']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const whereArgs = collectSqlLeafStrings(chain.where.mock.calls[0][0]);
    expect(whereArgs).toContain('partner-123');
  });

  it('returns [] for an unknown assignment level without querying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = await resolveDeviceIdsForAssignment('bogus', 'x', null, null);
    expect(ids).toEqual([]);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
