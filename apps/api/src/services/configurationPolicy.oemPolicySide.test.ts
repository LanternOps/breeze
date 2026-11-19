import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Config writes that can change which vendor updates link wins for a device ask for a
 * policy-side refresh (#11242); the trigger defers to commit and the worker tick is the
 * safety net. Mirrors configurationPolicy.complianceAlerts.test.ts.
 */

const { scheduleMock } = vi.hoisted(() => ({ scheduleMock: vi.fn() }));

vi.mock('./oemUpdates/policySideRefreshTrigger', () => ({
  scheduleOemPolicySideRefresh: scheduleMock,
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

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['from', 'where', 'set', 'values', 'onConflictDoNothing', 'innerJoin']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(rows));
  c.returning = vi.fn(() => Promise.resolve(rows));
  c.for = vi.fn(() => Promise.resolve(rows));
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

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

// Switched off, so the write narrows and needs no arming authorization.
const OFF = {
  version: 1,
  enabled: false,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7,
  reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: {}, blockedUpdateIds: [] } },
};

const link = (featureType: string) => ({
  id: LINK_ID, configPolicyId: POLICY_ID, featureType, featurePolicyId: null, inlineSettings: featureType === 'oem_updates' ? OFF : {},
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('vendor updates link writes schedule a policy-side refresh', () => {
  it('adding the oem_updates feature', async () => {
    mockTx(link('oem_updates'));
    await addFeatureLink(POLICY_ID, 'oem_updates', null, OFF);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-add');
  });

  it('updating the oem_updates feature', async () => {
    mockTx(link('oem_updates'));
    await updateFeatureLink(LINK_ID, { inlineSettings: OFF }, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-update');
  });

  it('removing the oem_updates feature (no onlyIfOemLinked: the link is gone by then)', async () => {
    mockTx(link('oem_updates'));
    await removeFeatureLink(LINK_ID, POLICY_ID);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID }, 'feature-link-remove');
  });

  it('but not a link of another feature type', async () => {
    mockTx({ ...link('pam'), inlineSettings: { uacInterceptionEnabled: false } });
    await addFeatureLink(POLICY_ID, 'pam', null, {});
    await updateFeatureLink(LINK_ID, { inlineSettings: { uacInterceptionEnabled: false } }, POLICY_ID);
    await removeFeatureLink(LINK_ID, POLICY_ID);
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe('policy-level writes schedule a policy-side refresh', () => {
  const auth = { scope: 'system', orgCondition: () => undefined, user: { id: 'user-1' } } as never;
  const ORG_POLICY = { id: POLICY_ID, orgId: 'org-1', partnerId: null, name: 'P', status: 'active' };

  it('assigning and unassigning only matter when the policy carries vendor updates', async () => {
    vi.mocked(db.insert).mockReturnValue(chain([{ id: 'a-1' }]) as never);
    await assignPolicy(POLICY_ID, 'organization', 'org-1', 0, 'user-1');
    expect(scheduleMock).toHaveBeenLastCalledWith({ configPolicyId: POLICY_ID, onlyIfOemLinked: true }, 'assignment-add');

    vi.mocked(db.delete).mockReturnValue(chain([{ id: 'a-1' }]) as never);
    await unassignPolicy('a-1', POLICY_ID);
    expect(scheduleMock).toHaveBeenLastCalledWith({ configPolicyId: POLICY_ID, onlyIfOemLinked: true }, 'assignment-remove');
  });

  it('changing the policy status, but not renaming it', async () => {
    vi.mocked(db.select).mockReturnValue(chain([ORG_POLICY]) as never);
    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, name: 'Renamed' }]) as never);
    await updateConfigPolicy(POLICY_ID, { name: 'Renamed' }, auth);
    expect(scheduleMock).not.toHaveBeenCalled();

    vi.mocked(db.update).mockReturnValue(chain([{ ...ORG_POLICY, status: 'inactive' }]) as never);
    await updateConfigPolicy(POLICY_ID, { status: 'inactive' }, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ configPolicyId: POLICY_ID, onlyIfOemLinked: true }, 'policy-status');
  });

  it('deleting the policy, scoped by its owner', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([ORG_POLICY]) as never).mockReturnValueOnce(chain([]) as never);
    vi.mocked(db.delete).mockReturnValue(chain([ORG_POLICY]) as never);
    await deleteConfigPolicy(POLICY_ID, auth);
    expect(scheduleMock).toHaveBeenCalledWith({ orgId: 'org-1' }, 'policy-delete');
  });
});
