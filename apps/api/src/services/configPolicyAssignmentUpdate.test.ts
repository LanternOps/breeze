import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `updateAssignment` (#12466, plan W02b G2): the staged Apply edits a row's
 * priority and filters in place. It never moves a row to another policy, and it
 * schedules the same three reconciles as `assignPolicy`, but only when a column
 * actually changed. Also: `listAssignmentsForTarget` carries the policy's owner
 * partner, which the Site page target listing needs (G5).
 */

const { complianceMock, oemMock, peripheralMock } = vi.hoisted(() => ({
  complianceMock: vi.fn(),
  oemMock: vi.fn(),
  peripheralMock: vi.fn(),
}));

vi.mock('./complianceAlertReconcileTrigger', () => ({ scheduleComplianceAlertReconcile: complianceMock }));
vi.mock('./oemUpdates/policySideRefreshTrigger', () => ({ scheduleOemPolicySideRefresh: oemMock }));
vi.mock('./peripheralLinkReconcileTrigger', async (importOriginal) => {
  const original = await importOriginal<typeof import('./peripheralLinkReconcileTrigger')>();
  return { ...original, schedulePeripheralLinkReconcile: peripheralMock };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { listAssignmentsForTarget, updateAssignment } from './configurationPolicy';
import { db } from '../db';

const POLICY_ID = 'policy-1';
const ASSIGNMENT_ID = 'assignment-1';
const SITE_ID = 'site-1';

const EXISTING = {
  id: ASSIGNMENT_ID,
  configPolicyId: POLICY_ID,
  level: 'site',
  targetId: SITE_ID,
  priority: 10,
  roleFilter: ['server'],
  osFilter: null,
  assignedBy: 'user-1',
  createdAt: new Date('2026-11-01T00:00:00Z'),
};

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['from', 'where', 'set', 'values', 'innerJoin', 'orderBy']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(rows));
  c.returning = vi.fn(() => Promise.resolve(rows));
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateAssignment', () => {
  it('updateAssignment changes priority and filters', async () => {
    const selectChain = chain([EXISTING]);
    vi.mocked(db.select).mockReturnValue(selectChain);
    const updated = { ...EXISTING, priority: 5, roleFilter: null, osFilter: ['windows'] };
    const updateChain = chain([updated]);
    vi.mocked(db.update).mockReturnValue(updateChain);

    const result = await updateAssignment(ASSIGNMENT_ID, POLICY_ID, {
      priority: 5,
      roleFilter: [], // normalized to null, as assignPolicy does
      osFilter: ['windows'],
    });

    expect(result).toEqual({ assignment: updated, changed: true });
    expect(updateChain.set).toHaveBeenCalledWith({ priority: 5, roleFilter: null, osFilter: ['windows'] });
    // Never moves a row: level, target and policy are not in the patch.
    const setArg = updateChain.set.mock.calls[0]![0];
    expect(setArg).not.toHaveProperty('configPolicyId');
    expect(setArg).not.toHaveProperty('level');
    expect(setArg).not.toHaveProperty('targetId');
  });

  it('updateAssignment returns null for another policy\'s row', async () => {
    vi.mocked(db.select).mockReturnValue(chain([]));

    const result = await updateAssignment(ASSIGNMENT_ID, 'other-policy', { priority: 1 });

    expect(result).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
    expect(complianceMock).not.toHaveBeenCalled();
  });

  it('updateAssignment returns null when the row vanished before the write', async () => {
    vi.mocked(db.select).mockReturnValue(chain([EXISTING]));
    vi.mocked(db.update).mockReturnValue(chain([]));

    const result = await updateAssignment(ASSIGNMENT_ID, POLICY_ID, { priority: 1 });

    expect(result).toBeNull();
    expect(complianceMock).not.toHaveBeenCalled();
    expect(peripheralMock).not.toHaveBeenCalled();
  });

  it('updateAssignment schedules the reconciles only when a row changed', async () => {
    vi.mocked(db.select).mockReturnValue(chain([EXISTING]));
    vi.mocked(db.update).mockReturnValue(chain([{ ...EXISTING, priority: 3 }]));

    await updateAssignment(ASSIGNMENT_ID, POLICY_ID, { priority: 3 });

    expect(complianceMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'assignment-update');
    expect(oemMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID, onlyIfOemLinked: true }, 'assignment-update');
    expect(peripheralMock).toHaveBeenCalledWith(
      { configPolicyId: POLICY_ID, assignments: [{ level: 'site', targetId: SITE_ID }] },
      'assignment-update',
    );

    // Same values (filter order aside, and [] vs null on an empty filter): no
    // write, no reconcile, and the row comes back so Apply does not read it as
    // a conflict.
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue(chain([EXISTING]));
    const unchanged = await updateAssignment(ASSIGNMENT_ID, POLICY_ID, { priority: 10, roleFilter: ['server'], osFilter: [] });
    expect(unchanged).toEqual({ assignment: EXISTING, changed: false });
    expect(db.update).not.toHaveBeenCalled();
    expect(complianceMock).not.toHaveBeenCalled();
    expect(oemMock).not.toHaveBeenCalled();
    expect(peripheralMock).not.toHaveBeenCalled();
  });

  it('treats an omitted field as unchanged and a null filter as "every device"', async () => {
    vi.mocked(db.select).mockReturnValue(chain([EXISTING]));
    const updateChain = chain([{ ...EXISTING, roleFilter: null }]);
    vi.mocked(db.update).mockReturnValue(updateChain);

    await updateAssignment(ASSIGNMENT_ID, POLICY_ID, { roleFilter: null });

    expect(updateChain.set).toHaveBeenCalledWith({ roleFilter: null });
  });

  it('uses the executor it is given', async () => {
    const executor: any = { select: vi.fn(() => chain([EXISTING])), update: vi.fn(() => chain([{ ...EXISTING, priority: 1 }])) };

    await updateAssignment(ASSIGNMENT_ID, POLICY_ID, { priority: 1 }, executor);

    expect(executor.select).toHaveBeenCalled();
    expect(executor.update).toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('listAssignmentsForTarget', () => {
  it('listAssignmentsForTarget returns policyPartnerId', async () => {
    const selectChain = chain([]);
    vi.mocked(db.select).mockReturnValue(selectChain);

    await listAssignmentsForTarget('site', SITE_ID);

    const projection = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(projection)).toEqual(
      expect.arrayContaining(['assignment', 'policyName', 'policyStatus', 'policyOrgId', 'policyPartnerId']),
    );
  });
});
