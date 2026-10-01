import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Compliance alerts close when their rule stops applying (follow-up to #7518).
 * The config write paths that can make a compliance rule stop applying schedule
 * a reconcile for the policy once their transaction settles; the periodic sweep
 * (policyEvaluationWorker `reconcile-compliance-alerts`) is the safety net for
 * every other path. The real-DB proof of what the reconcile resolves is
 * complianceAlertReconcile.integration.test.ts.
 *
 * Also: two rule sets with one name in the same link are refused before any
 * write, because a rule set is identified by (feature link, name).
 */

const { scheduleMock } = vi.hoisted(() => ({ scheduleMock: vi.fn() }));

vi.mock('./complianceAlertReconcileTrigger', () => ({
  scheduleComplianceAlertReconcile: scheduleMock,
}));

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

import {
  addFeatureLink,
  assignPolicy,
  deleteConfigPolicy,
  DuplicateComplianceItemNameError,
  removeFeatureLink,
  unassignPolicy,
  updateConfigPolicy,
  updateFeatureLink,
} from './configurationPolicy';
import { db } from '../db';

const POLICY_ID = 'policy-1';
const LINK_ID = 'link-1';
// Fresh objects per item: the reserved-key scan refuses shared references.
const item = (name: string) => ({ name, rules: [{ type: 'disk_space_minimum', minGb: 5 }] });
const DUPLICATED = { items: [item('Baseline'), item('Baseline')] };
const DISTINCT = { items: [item('Baseline'), item('Other')] };

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['from', 'where', 'set', 'values', 'onConflictDoNothing', 'innerJoin']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(rows));
  c.returning = vi.fn(() => Promise.resolve(rows));
  c.for = vi.fn(() => Promise.resolve(rows));
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

/** A transaction whose first select returns `existing` and whose writes succeed. */
function mockTx(existing: Record<string, unknown>) {
  const tx: any = {
    select: vi.fn(() => chain([existing])),
    update: vi.fn(() => chain([existing])),
    delete: vi.fn(() => chain([existing])),
    insert: vi.fn(() => chain([existing])),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return tx;
}

const COMPLIANCE_LINK = { id: LINK_ID, configPolicyId: POLICY_ID, featureType: 'compliance', featurePolicyId: null, inlineSettings: DISTINCT };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('duplicate compliance rule set names', () => {
  it('addFeatureLink refuses them before the transaction opens', async () => {
    await expect(addFeatureLink(POLICY_ID, 'compliance', null, DUPLICATED)).rejects.toBeInstanceOf(DuplicateComplianceItemNameError);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('updateFeatureLink refuses them before the rule sets are deleted and re-inserted', async () => {
    const tx = mockTx(COMPLIANCE_LINK);
    const err = await updateFeatureLink(LINK_ID, { inlineSettings: DUPLICATED }, POLICY_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateComplianceItemNameError);
    expect((err as DuplicateComplianceItemNameError).names).toEqual(['Baseline']);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe('config writes that can make a compliance rule stop applying schedule a reconcile', () => {
  it('saving a compliance rule set', async () => {
    mockTx(COMPLIANCE_LINK);
    await updateFeatureLink(LINK_ID, { inlineSettings: DISTINCT }, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-update');
  });

  it('adding the compliance feature (it can take precedence over another policy)', async () => {
    mockTx({ ...COMPLIANCE_LINK });
    await addFeatureLink(POLICY_ID, 'compliance', null, DISTINCT);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-add');
  });

  it('removing the compliance feature', async () => {
    mockTx(COMPLIANCE_LINK);
    await removeFeatureLink(LINK_ID, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-remove');
  });

  it('but not saving an unrelated feature', async () => {
    mockTx({ ...COMPLIANCE_LINK, featureType: 'pam', inlineSettings: {} });
    await updateFeatureLink(LINK_ID, { inlineSettings: { uacInterceptionEnabled: false } }, POLICY_ID);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  const auth = { scope: 'system', orgCondition: () => undefined, user: { id: 'user-1' } } as never;
  const ORG_POLICY = { id: POLICY_ID, orgId: 'org-1', partnerId: null, name: 'P', status: 'active' };

  it('changing the policy status', async () => {
    vi.mocked(db.select).mockReturnValue(chain([ORG_POLICY]) as never);
    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, status: 'inactive' }]) as never);
    await updateConfigPolicy(POLICY_ID, { status: 'inactive' }, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'policy-status');
  });

  it('but not renaming the policy', async () => {
    vi.mocked(db.select).mockReturnValue(chain([ORG_POLICY]) as never);
    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, name: 'Renamed' }]) as never);
    await updateConfigPolicy(POLICY_ID, { name: 'Renamed' }, auth);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('deleting the policy (scoped by its owner, since the policy is gone when the reconcile runs)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([ORG_POLICY]) as never).mockReturnValueOnce(chain([]) as never);
    vi.mocked(db.delete).mockReturnValue(chain([ORG_POLICY]) as never);
    await deleteConfigPolicy(POLICY_ID, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ orgId: 'org-1' }, 'policy-delete');

    scheduleMock.mockClear();
    const wide = { ...ORG_POLICY, orgId: null, partnerId: 'partner-1' };
    vi.mocked(db.select).mockReturnValueOnce(chain([wide]) as never).mockReturnValueOnce(chain([]) as never);
    vi.mocked(db.delete).mockReturnValue(chain([wide]) as never);
    await deleteConfigPolicy(POLICY_ID, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ partnerId: 'partner-1' }, 'policy-delete');
  });

  it('assigning and unassigning the policy', async () => {
    vi.mocked(db.insert).mockReturnValue(chain([{ id: 'a-1' }]) as never);
    await assignPolicy(POLICY_ID, 'organization', 'org-1', 0, 'user-1');
    expect(scheduleMock).toHaveBeenLastCalledWith({ configPolicyId: POLICY_ID }, 'assignment-add');

    vi.mocked(db.delete).mockReturnValue(chain([{ id: 'a-1' }]) as never);
    await unassignPolicy('a-1', POLICY_ID);
    expect(scheduleMock).toHaveBeenLastCalledWith({ configPolicyId: POLICY_ID }, 'assignment-remove');
  });

  it('but not an assignment that already existed', async () => {
    vi.mocked(db.insert).mockReturnValue(chain([]) as never);
    await assignPolicy(POLICY_ID, 'organization', 'org-1', 0, 'user-1');
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
