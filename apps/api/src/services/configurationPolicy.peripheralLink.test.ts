import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9619 — a Peripheral Control feature link is authoritative for which devices
 * get the peripheral policy, so every config write that can change that set
 * (link added / changed / removed, policy status flipped or deleted, assignment
 * added or removed) schedules peripheral reconciliation for the affected
 * devices. The device resolution behind the trigger is covered in
 * peripheralLinkReconcileTrigger.test.ts.
 */

const { scheduleMock, complianceMock } = vi.hoisted(() => ({ scheduleMock: vi.fn(), complianceMock: vi.fn() }));

vi.mock('./peripheralLinkReconcileTrigger', () => ({
  schedulePeripheralLinkReconcile: scheduleMock,
  capturePeripheralLinkDeleteScope: vi.fn(async () => ({
    assignments: [{ level: 'site', targetId: 'site-1' }],
    peripheralPolicyIds: ['periph-1'],
  })),
}));
vi.mock('./complianceAlertReconcileTrigger', () => ({
  scheduleComplianceAlertReconcile: complianceMock,
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
  removeFeatureLink,
  unassignPolicy,
  updateConfigPolicy,
  updateFeatureLink,
} from './configurationPolicy';
import { db } from '../db';

const POLICY_ID = 'policy-1';
const LINK_ID = 'link-1';
const PERIPH_A = 'periph-1';
const PERIPH_B = 'periph-2';

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['from', 'where', 'set', 'values', 'onConflictDoNothing', 'innerJoin']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(rows));
  c.returning = vi.fn(() => Promise.resolve(rows));
  c.for = vi.fn(() => Promise.resolve(rows));
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

function mockTx(existing: Record<string, unknown>, updated: Record<string, unknown> = existing) {
  const tx: any = {
    select: vi.fn(() => chain([existing])),
    update: vi.fn(() => chain([updated])),
    delete: vi.fn(() => chain([existing])),
    insert: vi.fn(() => chain([existing])),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return tx;
}

const link = (featurePolicyId: string | null, featureType = 'peripheral_control') => ({
  id: LINK_ID, configPolicyId: POLICY_ID, featureType, featurePolicyId, inlineSettings: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('peripheral_control feature-link writes schedule peripheral reconciliation', () => {
  it('linking a peripheral policy', async () => {
    mockTx(link(PERIPH_A));
    await addFeatureLink(POLICY_ID, 'peripheral_control' as never, PERIPH_A);
    expect(scheduleMock).toHaveBeenCalledWith(
      { configPolicyId: POLICY_ID, peripheralPolicyIds: [PERIPH_A], standalone: true },
      'feature-link-add',
    );
  });

  it('re-pointing the link covers both the old and the new peripheral policy', async () => {
    mockTx(link(PERIPH_A), link(PERIPH_B));
    await updateFeatureLink(LINK_ID, { featurePolicyId: PERIPH_B }, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith(
      { configPolicyId: POLICY_ID, peripheralPolicyIds: expect.arrayContaining([PERIPH_A, PERIPH_B]), standalone: true },
      'feature-link-update',
    );
  });

  it('unlinking', async () => {
    const tx = mockTx(link(PERIPH_A));
    // First select locks the link row; the follow-up lookups (monitoring
    // settings, retired history) find nothing, so the row is really deleted.
    tx.select.mockImplementationOnce(() => chain([link(PERIPH_A)])).mockImplementation(() => chain([]));
    await removeFeatureLink(LINK_ID, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith(
      { configPolicyId: POLICY_ID, peripheralPolicyIds: [PERIPH_A], standalone: true },
      'feature-link-remove',
    );
  });

  it('but not a link of another feature type', async () => {
    mockTx(link(null, 'pam'));
    await removeFeatureLink(LINK_ID, POLICY_ID);
    mockTx(link(null, 'pam'));
    await updateFeatureLink(LINK_ID, { inlineSettings: { uacInterceptionEnabled: false } }, POLICY_ID);
    mockTx(link(null, 'pam'));
    await addFeatureLink(POLICY_ID, 'pam', null, { uacInterceptionEnabled: true });
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe('config-policy lifecycle writes schedule peripheral reconciliation', () => {
  const auth = { scope: 'system', orgCondition: () => undefined, user: { id: 'user-1' } } as never;
  const ORG_POLICY = { id: POLICY_ID, orgId: 'org-1', partnerId: null, name: 'P', status: 'active' };

  it('changing the policy status (not a rename)', async () => {
    vi.mocked(db.select).mockReturnValue(chain([ORG_POLICY]) as never);
    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, status: 'inactive' }]) as never);
    await updateConfigPolicy(POLICY_ID, { status: 'inactive' }, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID, standalone: true }, 'policy-status');

    scheduleMock.mockClear();
    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, name: 'Renamed' }]) as never);
    await updateConfigPolicy(POLICY_ID, { name: 'Renamed' }, auth);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('deleting the policy uses the assignments/links captured before the cascade', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([ORG_POLICY]) as never).mockReturnValueOnce(chain([]) as never);
    vi.mocked(db.delete).mockReturnValue(chain([ORG_POLICY]) as never);
    await deleteConfigPolicy(POLICY_ID, auth);
    expect(scheduleMock).toHaveBeenCalledWith(
      {
        assignments: [{ level: 'site', targetId: 'site-1' }],
        peripheralPolicyIds: ['periph-1'],
        standalone: true,
      },
      'policy-delete',
    );
  });

  it('assigning and unassigning', async () => {
    vi.mocked(db.insert).mockReturnValue(chain([{ id: 'a-1', level: 'site', targetId: 'site-1' }]) as never);
    await assignPolicy(POLICY_ID, 'site', 'site-1', 0, 'user-1');
    expect(scheduleMock).toHaveBeenLastCalledWith(
      { configPolicyId: POLICY_ID, assignments: [{ level: 'site', targetId: 'site-1' }] },
      'assignment-add',
    );

    vi.mocked(db.delete).mockReturnValue(chain([{ id: 'a-1', level: 'site', targetId: 'site-1' }]) as never);
    await unassignPolicy('a-1', POLICY_ID);
    expect(scheduleMock).toHaveBeenLastCalledWith(
      { configPolicyId: POLICY_ID, assignments: [{ level: 'site', targetId: 'site-1' }] },
      'assignment-remove',
    );
  });

  it('but not an assignment that already existed', async () => {
    vi.mocked(db.insert).mockReturnValue(chain([]) as never);
    await assignPolicy(POLICY_ID, 'site', 'site-1', 0, 'user-1');
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
