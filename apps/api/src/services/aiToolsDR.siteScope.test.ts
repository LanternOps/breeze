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
  for (const m of ['from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy']) {
    p[m] = () => p;
  }
  return p;
}

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

describe('query_dr_plans — hides fully out-of-scope plans', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides a plan whose devices are all outside the caller\'s site scope', async () => {
    seqSelect([
      [{ id: 'p1', name: 'P1', groupCount: 1 }, { id: 'p2', name: 'P2', groupCount: 1 }], // plans
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],             // partition
      [{ planId: 'p1', devices: ['dev-A'] }, { planId: 'p2', devices: ['dev-B'] }],       // groups per plan
    ]);
    const result = await handlerFor('query_dr_plans')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(1);
    expect(parsed.plans.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('unrestricted caller sees all plans (no regression)', async () => {
    seqSelect([
      [{ id: 'p1', name: 'P1', groupCount: 1 }, { id: 'p2', name: 'P2', groupCount: 1 }],
    ]);
    const result = await handlerFor('query_dr_plans')({}, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(2);
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
