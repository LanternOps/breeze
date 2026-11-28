import { describe, it, expect, vi, beforeEach } from 'vitest';

const ownerRows = vi.hoisted(() => ({ value: [] as Array<{ id: string; partnerId: string }> }));
const escape = vi.hoisted(() => ({ calls: 0 }));
const savepoint = vi.hoisted(() => ({ open: false, readsInside: 0 }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      if (savepoint.open) savepoint.readsInside += 1;
      return { from: () => ({ where: async () => ownerRows.value }) };
    }),
  },
  withDbTransactionIfHeld: vi.fn(async (fn: () => Promise<unknown>) => {
    savepoint.open = true;
    try {
      return await fn();
    } finally {
      savepoint.open = false;
    }
  }),
}));
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(async (fn: () => Promise<unknown>) => {
    escape.calls += 1;
    return fn();
  }),
}));
vi.mock('./authenticatorPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./authenticatorPolicy')>();
  return { ...actual, loadPartnerPolicy: vi.fn(async () => null) };
});

import { db } from '../db';
import { loadPartnerPolicy } from './authenticatorPolicy';
import {
  approvalPolicyFloorOverrides,
  isApprovalPolicySetEnforcing,
  loadApprovalPolicySet,
} from './approvalAssurancePolicy';

const NOW = new Date('2026-11-26T12:00:00Z');
// The test setup moves the platform default date into the future, so a
// missing row (null) reads as NOT enforcing unless a test sets the env.
const OFF = { partnerId: 'p-a', requireEnrollment: false, enforceFrom: null, floorOverrides: {} } as any;
const ON = { partnerId: 'p-b', requireEnrollment: true, enforceFrom: new Date('2026-01-01T00:00:00Z'), floorOverrides: {} } as any;
const GRACE = { partnerId: 'p-c', requireEnrollment: true, enforceFrom: new Date('2027-01-01T00:00:00Z'), floorOverrides: {} } as any;

beforeEach(() => {
  vi.clearAllMocks();
  ownerRows.value = [];
  escape.calls = 0;
  savepoint.open = false;
  savepoint.readsInside = 0;
  vi.mocked(loadPartnerPolicy).mockResolvedValue(null);
});

describe('loadApprovalPolicySet: a failed read stays contained', () => {
  it('runs the owner and policy reads in a savepoint of the held transaction', async () => {
    ownerRows.value = [{ id: 'org-b', partnerId: 'p-b' }];
    let policyReadInside = false;
    vi.mocked(loadPartnerPolicy).mockImplementation(async () => {
      policyReadInside ||= savepoint.open;
      return null;
    });

    await loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-b'] });

    expect(savepoint.readsInside).toBe(1);
    expect(policyReadInside).toBe(true);
  });

  it('still propagates the error, so the approve is refused', async () => {
    ownerRows.value = [{ id: 'org-b', partnerId: 'p-b' }];
    vi.mocked(loadPartnerPolicy).mockRejectedValue(new Error('pool exhausted'));

    await expect(loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-b'] })).rejects.toThrow('pool exhausted');
  });
});

describe('loadApprovalPolicySet', () => {
  it('with no row orgs, reads only the session partner, with no extra escape or org read', async () => {
    vi.mocked(loadPartnerPolicy).mockResolvedValue(OFF);

    const set = await loadApprovalPolicySet({ sessionPartnerId: 'p-a' });

    expect(set).toEqual([OFF]);
    expect(loadPartnerPolicy).toHaveBeenCalledTimes(1);
    expect(loadPartnerPolicy).toHaveBeenCalledWith('p-a');
    expect(db.select).not.toHaveBeenCalled();
    expect(escape.calls).toBe(0);
  });

  it("adds the policy of the partner that owns the row's org", async () => {
    ownerRows.value = [{ id: 'org-b', partnerId: 'p-b' }];
    vi.mocked(loadPartnerPolicy).mockImplementation(async (id) => (id === 'p-a' ? OFF : id === 'p-b' ? ON : null));

    const set = await loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-b'] });

    expect(set).toEqual([OFF, ON]);
    expect(escape.calls).toBe(1); // one system-context escape for all of it
  });

  it('reads a partner once when the row org belongs to the session partner', async () => {
    ownerRows.value = [{ id: 'org-a', partnerId: 'p-a' }];

    await loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-a', 'org-a'] });

    expect(loadPartnerPolicy).toHaveBeenCalledTimes(1);
  });

  it('an org that no longer resolves contributes the platform default, never nothing', async () => {
    vi.mocked(loadPartnerPolicy).mockImplementation(async (id) => (id === 'p-a' ? OFF : null));

    const set = await loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-gone'] });

    expect(set).toEqual([OFF, null]);
    expect(loadPartnerPolicy).toHaveBeenCalledWith(null);
  });

  it('ignores empty org ids', async () => {
    await loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: [null, undefined, ''] });

    expect(db.select).not.toHaveBeenCalled();
  });

  it('propagates a read failure (the approve is refused, never decided under a guessed policy)', async () => {
    ownerRows.value = [{ id: 'org-b', partnerId: 'p-b' }];
    vi.mocked(loadPartnerPolicy).mockImplementation(async (id) => {
      if (id === 'p-b') throw new Error('pool exhausted');
      return OFF;
    });

    await expect(loadApprovalPolicySet({ sessionPartnerId: 'p-a', rowOrgIds: ['org-b'] })).rejects.toThrow('pool exhausted');
  });
});

describe('isApprovalPolicySetEnforcing', () => {
  it('enforces when ANY policy enforces at the tier, whichever side it is on', () => {
    expect(isApprovalPolicySetEnforcing([OFF, ON], NOW, 'high')).toBe(true);
    expect(isApprovalPolicySetEnforcing([ON, OFF], NOW, 'high')).toBe(true);
  });

  it('does not enforce when every policy is off or in grace', () => {
    expect(isApprovalPolicySetEnforcing([OFF, GRACE], NOW, 'high')).toBe(false);
  });

  it('reads an empty set as the platform default', () => {
    const before = process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2000-01-01T00:00:00Z';
    try {
      expect(isApprovalPolicySetEnforcing([], NOW, 'high')).toBe(true);
      expect(isApprovalPolicySetEnforcing([OFF, null], NOW, 'high')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
      else process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = before;
    }
  });
});

describe('approvalPolicyFloorOverrides', () => {
  it('takes the highest override per tier across the set', () => {
    const a = { ...OFF, floorOverrides: { low: 2, high: 4 } };
    const b = { ...ON, floorOverrides: { low: 1, medium: 3 } };

    expect(approvalPolicyFloorOverrides([a, b, null])).toEqual({ low: 2, medium: 3, high: 4 });
  });

  it('is empty for a set with no overrides', () => {
    expect(approvalPolicyFloorOverrides([null, OFF])).toEqual({});
  });
});
