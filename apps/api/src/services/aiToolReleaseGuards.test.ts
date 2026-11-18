import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import { approverReleaseMismatch } from './aiToolReleaseGuards';

const auth = { user: { id: 'u-1' } } as unknown as AuthContext;

describe('approverReleaseMismatch (#6911, shared since #6268)', () => {
  it('is false with no approver-substituted release', () => {
    expect(approverReleaseMismatch(auth, undefined)).toBe(false);
    expect(approverReleaseMismatch(auth, { actionIntentId: 'i-1' })).toBe(false);
  });

  it('is false when the auth is the named approver and true otherwise', () => {
    expect(approverReleaseMismatch(auth, { approverRelease: { approverUserId: 'u-1' } })).toBe(false);
    expect(approverReleaseMismatch(auth, { approverRelease: { approverUserId: 'u-2' } })).toBe(true);
  });
});
