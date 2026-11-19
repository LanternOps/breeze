import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db } from '../db';
import { drPlanGroups, drPlans } from '../db/schema';
import { addDrPlanGroup, deleteDrPlanGroup, updateDrPlanGroup } from './drPlanWrites';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_GROUP_ID = '44444444-4444-4444-4444-444444444444';

/** Thenable query chain resolving to `rows`; records the table it was read from. */
function chain(rows: unknown[]) {
  const c: any = Promise.resolve(rows);
  for (const m of ['where', 'limit', 'for', 'orderBy', 'values', 'set', 'returning']) c[m] = vi.fn(() => c);
  c.from = vi.fn(() => c);
  return c;
}

/** Reads in order: plan row lock, active execution check, then whatever the write reads. */
function queueReads(...reads: unknown[][]) {
  const chains: any[] = [];
  vi.mocked(db.select).mockImplementation((() => {
    const c = chain(reads[chains.length] ?? []);
    chains.push(c);
    return c;
  }) as any);
  return chains;
}

const LOCKED = [{ id: PLAN_ID }];
const NO_EXECUTION: unknown[] = [];

describe('drPlanWrites — group dependencies are checked under the plan lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockImplementation((() => chain([{ id: GROUP_ID }])) as any);
    vi.mocked(db.update).mockImplementation((() => chain([{ id: GROUP_ID }])) as any);
    vi.mocked(db.delete).mockImplementation((() => chain([{ id: GROUP_ID }])) as any);
  });

  it('adds a group whose predecessor is another group of the same plan', async () => {
    const chains = queueReads(LOCKED, NO_EXECUTION, [{ id: OTHER_GROUP_ID }]);
    const result = await addDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, values: { name: 'g', dependsOnGroupId: OTHER_GROUP_ID } });
    expect(result.status).toBe('written');
    expect(chains[2].from).toHaveBeenCalledWith(drPlanGroups);
  });

  it('refuses to add a group whose predecessor is not a group of the same plan and org, writing nothing', async () => {
    queueReads(LOCKED, NO_EXECUTION, []);
    const result = await addDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, values: { name: 'g', dependsOnGroupId: OTHER_GROUP_ID } });
    expect(result).toEqual({ status: 'invalid_dependency' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses an update that points a group at a group outside its plan, writing nothing', async () => {
    queueReads(LOCKED, NO_EXECUTION, []);
    const result = await updateDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID, changes: { dependsOnGroupId: OTHER_GROUP_ID } });
    expect(result).toEqual({ status: 'invalid_dependency' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses an update that makes a group depend on itself', async () => {
    queueReads(LOCKED, NO_EXECUTION);
    const result = await updateDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID, changes: { dependsOnGroupId: GROUP_ID } });
    expect(result).toEqual({ status: 'invalid_dependency' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('clears a dependency without a lookup', async () => {
    const chains = queueReads(LOCKED, NO_EXECUTION);
    const result = await updateDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID, changes: { dependsOnGroupId: null } });
    expect(result.status).toBe('written');
    expect(chains).toHaveLength(2);
  });

  it('checks the dependency only after taking the plan lock and the execution check', async () => {
    const chains = queueReads(LOCKED, NO_EXECUTION, [{ id: OTHER_GROUP_ID }]);
    await updateDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID, changes: { dependsOnGroupId: OTHER_GROUP_ID } });
    expect(chains[0].from).toHaveBeenCalledWith(drPlans);
    expect(chains[0].for).toHaveBeenCalledWith('update');
    expect(chains[2].from).toHaveBeenCalledWith(drPlanGroups);
  });

  it('refuses to delete a group another group depends on', async () => {
    queueReads(LOCKED, NO_EXECUTION, [{ id: OTHER_GROUP_ID }]);
    const result = await deleteDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID });
    expect(result).toEqual({ status: 'group_has_dependents' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('reports a dependent this scope cannot see (foreign-key refusal) as group_has_dependents', async () => {
    queueReads(LOCKED, NO_EXECUTION, []);
    vi.mocked(db.delete).mockImplementation((() => {
      const c = chain([]);
      c.returning = vi.fn(() => Promise.reject(Object.assign(new Error('violates foreign key constraint'), { code: '23503' })));
      return c;
    }) as any);
    const result = await deleteDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID });
    expect(result).toEqual({ status: 'group_has_dependents' });
  });

  it('deletes a group nothing depends on', async () => {
    queueReads(LOCKED, NO_EXECUTION, []);
    const result = await deleteDrPlanGroup({ planId: PLAN_ID, orgId: ORG_ID, groupId: GROUP_ID });
    expect(result.status).toBe('written');
    expect(db.delete).toHaveBeenCalled();
  });
});
