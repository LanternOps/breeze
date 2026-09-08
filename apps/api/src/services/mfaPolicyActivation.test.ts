import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { countMfaPolicyLockouts, mfaPolicyLockoutResponse } from './mfaPolicyActivation';

vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: (callback: () => unknown) => callback(),
  withSystemDbAccessContext: (callback: () => unknown) => callback(),
  assertInTransaction: vi.fn(),
}));

const scope = { kind: 'partner', id: '00000000-0000-4000-8000-000000000167' } as const;

describe('MFA activation failure disposition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('propagates unavailable inventory instead of treating it as zero users', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(countMfaPolicyLockouts(scope, {})).rejects.toThrow('database unavailable');
  });

  it.each([{ rows: [] }, { rows: [{ count: -1 }] }, { rows: [{ count: null }] }])('rejects unexpected aggregate result $rows', async ({ rows }) => {
    vi.mocked(db.execute).mockResolvedValueOnce(rows as never);
    await expect(countMfaPolicyLockouts(scope, {})).rejects.toThrow('MFA policy inventory count unavailable');
  });

  it('labels capped counts and provides an actionable message without identities', () => {
    expect(mfaPolicyLockoutResponse(1000)).toEqual({
      code: 'mfa_policy_would_lock_out_users', count: 1000, countCapped: true,
      error: 'Enroll an allowed MFA method for affected users before changing this policy.',
    });
  });
});
