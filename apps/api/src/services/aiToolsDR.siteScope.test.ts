import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./drExecutionService', () => ({
  createDrExecutionAndEnqueue: vi.fn(async () => ({ id: 'exec-1', status: 'pending' })),
}));

import { db } from '../db';
import { createDrExecutionAndEnqueue } from './drExecutionService';
import { registerDRTools } from './aiToolsDR';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockEnqueue = createDrExecutionAndEnqueue as unknown as ReturnType<typeof vi.fn>;

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDRTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as AuthContext;
}

// Thenable that resolves to `rows` and supports any query-builder chaining shape.
function chain(rows: unknown[]): any {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy']) {
    p[m] = () => p;
  }
  p.limit = (value: number) => {
    limitCalls.push(value);
    return p;
  };
  return p;
}

const limitCalls: number[] = [];

function seqSelect(results: Array<unknown[]>) {
  let call = 0;
  mockDb.select.mockImplementation(() => chain(results[call++] ?? []));
}

const PLAN = { id: 'p1', orgId: 'org-1', name: 'Plan 1', status: 'active' };

describe('execute_dr_plan — durable authorization subject handoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the complete caller context to the durable execution service', async () => {
    const auth = makeAuth(['site-A']);
    seqSelect([
      [PLAN],                                            // loadPlanWithAccess
      [{ id: 'g1', name: 'G1', sequence: 0, devices: ['dev-A', 'dev-B'], restoreConfig: {}, estimatedDurationMinutes: null }], // groups
    ]);
    const result = await handlerFor('execute_dr_plan')({ planId: 'p1', executionType: 'failover' }, auth);
    expect(JSON.parse(result).success).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ auth }));
  });

  it('does not persist a mutable device-list snapshot as authority', async () => {
    seqSelect([
      [PLAN],
      [{ id: 'g1', name: 'G1', sequence: 0, devices: ['dev-A'], restoreConfig: {}, estimatedDurationMinutes: null }],
    ]);
    const result = await handlerFor('execute_dr_plan')({ planId: 'p1', executionType: 'failover' }, makeAuth(['site-A']));
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0]![0]).not.toHaveProperty('authorizedDeviceIds');
  });

  it('also passes an unrestricted caller as a durable subject input', async () => {
    const auth = makeAuth(undefined);
    seqSelect([
      [PLAN],
      [{ id: 'g1', name: 'G1', sequence: 0, devices: ['dev-A', 'dev-B'], restoreConfig: {}, estimatedDurationMinutes: null }],
    ]);
    const result = await handlerFor('execute_dr_plan')({ planId: 'p1', executionType: 'failover' }, auth);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(mockEnqueue.mock.calls[0]![0].auth).toBe(auth);
  });
});

describe('query_dr_plans — requires whole-plan site visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitCalls.length = 0;
  });

  it('hides a plan whose devices are all outside the caller\'s site scope', async () => {
    seqSelect([
      [{ id: 'p1', name: 'P1', groupCount: 1 }, { id: 'p2', name: 'P2', groupCount: 1 }], // plans
      [{ planId: 'p1', devices: ['dev-A'] }, { planId: 'p2', devices: ['dev-B'] }],       // groups per plan
      // Both ids resolve to a live device; only dev-A sits in the ceiling. Every
      // id is looked up in ONE chunked query, so both rows come back together.
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    const result = await handlerFor('query_dr_plans')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(1);
    expect(parsed.plans.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('omits a mixed plan and filters before applying the requested limit', async () => {
    seqSelect([
      [{ id: 'mixed', name: 'Mixed', groupCount: 1 }, { id: 'visible', name: 'Visible', groupCount: 1 }],
      [{ planId: 'mixed', devices: ['dev-A', 'dev-B'] }, { planId: 'visible', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({ limit: 1 }, makeAuth(['site-A'])));
    expect(parsed.plans.map((p: any) => p.id)).toEqual(['visible']);
    expect(parsed.showing).toBe(1);
  });

  // `dr_plan_groups.devices` is jsonb with no FK and is not scrubbed by the
  // device cascade, so a decommissioned machine leaves a permanently
  // unresolvable id behind. Treating that as "hidden" would wedge the plan out
  // of view for every restricted tech forever. The write side already decided
  // this the other way (`authorizeStoredDevices`, routes/dr.ts).
  it('ignores a stale device identity that no longer resolves to any org device', async () => {
    seqSelect([
      [{ id: 'stale', name: 'Stale', groupCount: 1 }],
      [{ planId: 'stale', devices: ['missing-device', 'dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, makeAuth(['site-A'])));
    expect(parsed.plans.map((plan: any) => plan.id)).toEqual(['stale']);
  });

  it('still denies when a SURVIVING member device sits outside the ceiling', async () => {
    seqSelect([
      [{ id: 'mixed', name: 'Mixed', groupCount: 1 }],
      [{ planId: 'mixed', devices: ['missing-device', 'dev-A', 'dev-B'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, makeAuth(['site-A'])));
    expect(parsed.plans).toEqual([]);
  });

  it('denies when a surviving member device carries no site at all', async () => {
    seqSelect([
      [{ id: 'orphan', name: 'Orphan', groupCount: 1 }],
      [{ planId: 'orphan', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: null }],
    ]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, makeAuth(['site-A'])));
    expect(parsed.plans).toEqual([]);
  });

  // Regression for the org-guard fail-CLOSED bug: a system-scope session has no
  // auth.orgId and no accessibleOrgIds, so guarding on getOrgId() turned every
  // system read into an empty list.
  it('system-scope session keeps the unfiltered single-query path', async () => {
    const auth = makeAuth(undefined);
    auth.principal = { kind: 'system' } as any;
    (auth as any).orgId = null;
    (auth as any).accessibleOrgIds = null;
    seqSelect([[{ id: 'p1', name: 'P1', groupCount: 1 }, { id: 'p2', name: 'P2', groupCount: 1 }]]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, auth));
    expect(parsed.plans.map((plan: any) => plan.id)).toEqual(['p1', 'p2']);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(limitCalls).toEqual([25]);
  });

  it('a RESTRICTED caller with no resolvable org still fails closed', async () => {
    const auth = makeAuth(['site-A']);
    (auth as any).orgId = null;
    (auth as any).accessibleOrgIds = null;
    seqSelect([[{ id: 'p1', name: 'P1', groupCount: 1 }]]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, auth));
    expect(parsed.plans).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('unrestricted caller sees all plans (no regression)', async () => {
    seqSelect([
      [{ id: 'p1', name: 'P1', groupCount: 1 }, { id: 'p2', name: 'P2', groupCount: 1 }],
    ]);
    const result = await handlerFor('query_dr_plans')({}, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(2);
    expect(limitCalls).toEqual([25]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns no plans for an empty site ceiling without subsidiary reads', async () => {
    seqSelect([[{ id: 'p1', name: 'P1', groupCount: 0 }]]);
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, makeAuth([])));
    expect(parsed.plans).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('keyset-scans past a full hidden page before applying limit 1', async () => {
    const hiddenPlans = Array.from({ length: 100 }, (_, index) => ({
      id: `hidden-${String(index).padStart(3, '0')}`,
      name: `Hidden ${index}`,
      createdAt: new Date(200_000 - index),
      groupCount: 1,
    }));
    seqSelect([
      hiddenPlans,
      hiddenPlans.map((plan) => ({ planId: plan.id, devices: ['dev-B'] })),
      [{ id: 'dev-B', siteId: 'site-B' }],
      [{ id: 'visible', name: 'Visible', createdAt: new Date(1), groupCount: 1 }],
      [{ planId: 'visible', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);

    const parsed = JSON.parse(await handlerFor('query_dr_plans')({ limit: 1 }, makeAuth(['site-A'])));
    expect(parsed.plans.map((plan: any) => plan.id)).toEqual(['visible']);
    expect(limitCalls).toEqual([100, 100]);
    expect(mockDb.select).toHaveBeenCalledTimes(6);
  });

  it('chunks large device membership lookups below the bind ceiling', async () => {
    const deviceIds = Array.from({ length: 501 }, (_, index) => `dev-${index}`);
    seqSelect([
      [{ id: 'large', name: 'Large', createdAt: new Date(1), groupCount: 1 }],
      [{ planId: 'large', devices: deviceIds }],
      deviceIds.slice(0, 500).map((id) => ({ id, siteId: 'site-A' })),
      [{ id: deviceIds[500], siteId: 'site-A' }],
    ]);

    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, makeAuth(['site-A'])));
    expect(parsed.plans.map((plan: any) => plan.id)).toEqual(['large']);
    expect(mockDb.select).toHaveBeenCalledTimes(4);
  });

  it('fails closed without querying for an unsupported principal kind', async () => {
    const auth = makeAuth(undefined);
    auth.principal = { kind: 'unknown' };
    const parsed = JSON.parse(await handlerFor('query_dr_plans')({}, auth));
    expect(parsed.plans).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('DR detail reads — current and historical site visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitCalls.length = 0;
  });

  it('returns an opaque denial for mixed plan details', async () => {
    seqSelect([
      [PLAN],
      [{ planId: 'p1', devices: ['dev-A', 'dev-B'], restoreConfig: { secretRef: 'hidden' } }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    const parsed = JSON.parse(await handlerFor('get_dr_plan_details')({ planId: 'p1' }, makeAuth(['site-A'])));
    expect(parsed).toEqual({ error: 'Plan not found or access denied' });
    expect(JSON.stringify(parsed)).not.toContain('hidden');
  });

  it('denies execution history when an immutable result names a hidden device', async () => {
    const results = {
      plannedGroups: [{ id: 'g1', deviceCount: 1 }],
      groupResults: [{ groupId: 'g1', devices: [{ id: 'dev-B', status: 'completed' }] }],
      queuedCommands: [], failedDispatches: [],
    };
    seqSelect([
      [{ id: 'e1', planId: 'p1', orgId: 'org-1', results }],
      [PLAN],
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    const parsed = JSON.parse(await handlerFor('get_dr_execution_status')({ executionId: 'e1' }, makeAuth(['site-A'])));
    expect(parsed).toEqual({ error: 'Execution not found or access denied' });
  });

  it('denies malformed legacy execution results', async () => {
    seqSelect([
      [{ id: 'e1', planId: 'p1', orgId: 'org-1', results: { plannedGroups: [{ restoreConfig: { x: 1 } }] } }],
      [PLAN], [{ planId: 'p1', devices: ['dev-A'] }], [{ planId: 'p1', devices: ['dev-A'] }],
    ]);
    const parsed = JSON.parse(await handlerFor('get_dr_execution_status')({ executionId: 'e1' }, makeAuth(['site-A'])));
    expect(parsed.error).toMatch(/access denied/i);
  });

  it('keyset-scans past hidden execution history before applying limit 1', async () => {
    const resultFor = (deviceId: string) => ({
      plannedGroups: [{ id: 'g1', deviceCount: 1 }],
      groupResults: [{ groupId: 'g1', devices: [{ id: deviceId, status: 'completed' }] }],
      queuedCommands: [],
      failedDispatches: [],
    });
    const hiddenExecutions = Array.from({ length: 100 }, (_, index) => ({
      id: `hidden-exec-${String(index).padStart(3, '0')}`,
      planId: 'p1',
      createdAt: new Date(200_000 - index),
      results: resultFor('dev-B'),
    }));
    seqSelect([
      hiddenExecutions,
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
      [{ id: 'visible-exec', planId: 'p1', createdAt: new Date(1), results: resultFor('dev-A') }],
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);

    const parsed = JSON.parse(await handlerFor('get_dr_execution_status')({ limit: 1 }, makeAuth(['site-A'])));
    expect(parsed.executions.map((execution: any) => execution.id)).toEqual(['visible-exec']);
    expect(limitCalls).toEqual([100, 100]);
    expect(mockDb.select).toHaveBeenCalledTimes(6);
  });
});

// ── #3653 ───────────────────────────────────────────────────────────────────
// The central `deviceArgs` gate org+site checks the ids a caller SUBMITS. It
// cannot see what a group already holds, so these mutations need their own
// barrier against the stored membership.
describe('manage_dr_plan — stored group membership is site-scoped', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Chain that also answers the write-builder methods. */
  function writeChain(rows: unknown[]): any {
    const p: any = Promise.resolve(rows);
    for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning']) p[m] = () => p;
    return p;
  }

  const GROUP_SPANNING_SITES = {
    id: 'g1',
    orgId: 'org-1',
    devices: ['dev-A', 'dev-B'],
  };
  const ORG_DEVICES = [
    { id: 'dev-A', siteId: 'site-A' },
    { id: 'dev-B', siteId: 'site-B' },
  ];

  it('refuses an update that would silently drop an out-of-site device', async () => {
    mockDb.update.mockImplementation(() => writeChain([]));
    seqSelect([[GROUP_SPANNING_SITES], ORG_DEVICES]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_group', planId: 'p1', groupId: 'g1', devices: ['dev-A'] },
      makeAuth(['site-A']),
    );

    expect(JSON.parse(result).error).toMatch(/access denied/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('refuses deleting a group that holds an out-of-site device', async () => {
    mockDb.delete.mockImplementation(() => writeChain([]));
    seqSelect([[GROUP_SPANNING_SITES], ORG_DEVICES]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'delete_group', planId: 'p1', groupId: 'g1' },
      makeAuth(['site-A']),
    );

    expect(JSON.parse(result).error).toMatch(/access denied/i);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('allows updating a group confined to the caller sites', async () => {
    mockDb.update.mockImplementation(() => writeChain([{ id: 'g1', name: 'Renamed' }]));
    seqSelect([[{ id: 'g1', orgId: 'org-1', devices: ['dev-A'] }], ORG_DEVICES]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_group', planId: 'p1', groupId: 'g1', name: 'Renamed' },
      makeAuth(['site-A']),
    );

    expect(JSON.parse(result).success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('leaves an unrestricted caller unaffected and issues no partition query', async () => {
    mockDb.update.mockImplementation(() => writeChain([{ id: 'g1', name: 'Renamed' }]));
    seqSelect([[GROUP_SPANNING_SITES]]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_group', planId: 'p1', groupId: 'g1', name: 'Renamed' },
      makeAuth(undefined),
    );

    expect(JSON.parse(result).success).toBe(true);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

// Plan status gates execution and archival disables recovery outright, so
// update_plan is a control-plane action over every site the plan touches.
describe('manage_dr_plan — plan mutations are site-scoped', () => {
  beforeEach(() => vi.clearAllMocks());

  function writeChain(rows: unknown[]): any {
    const p: any = Promise.resolve(rows);
    for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning']) p[m] = () => p;
    return p;
  }

  const ORG_DEVICES = [
    { id: 'dev-A', siteId: 'site-A' },
    { id: 'dev-B', siteId: 'site-B' },
  ];

  it('refuses to archive a plan reaching sites the caller cannot access', async () => {
    mockDb.update.mockImplementation(() => writeChain([]));
    seqSelect([
      [PLAN],                                  // loadPlanWithAccess
      ORG_DEVICES,                             // site partition
      [{ devices: ['dev-A', 'dev-B'] }],       // the plan's groups
    ]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_plan', planId: 'p1', status: 'archived' },
      makeAuth(['site-A']),
    );

    expect(JSON.parse(result).error).toMatch(/access denied/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('allows updating a plan confined to the caller sites', async () => {
    mockDb.update.mockImplementation(() => writeChain([{ id: 'p1', name: 'Renamed' }]));
    seqSelect([
      [PLAN],
      ORG_DEVICES,
      [{ devices: ['dev-A'] }],
    ]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_plan', planId: 'p1', name: 'Renamed' },
      makeAuth(['site-A']),
    );

    expect(JSON.parse(result).success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('leaves an unrestricted caller unaffected and loads no group membership', async () => {
    mockDb.update.mockImplementation(() => writeChain([{ id: 'p1', name: 'Renamed' }]));
    seqSelect([[PLAN]]);

    const result = await handlerFor('manage_dr_plan')(
      { action: 'update_plan', planId: 'p1', name: 'Renamed' },
      makeAuth(undefined),
    );

    expect(JSON.parse(result).success).toBe(true);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});
