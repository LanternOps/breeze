import { describe, it, expect, vi } from 'vitest';

// vetBinding is pure; `db` is only imported at module load by the query
// helpers, so an empty stub keeps this a true unit test.
vi.mock('../../db', () => ({ db: {} }));

import { vetBinding, type BindingWithUser } from './officeAddinBindings';

function bound(overrides?: {
  binding?: Partial<BindingWithUser['binding']>;
  user?: Partial<BindingWithUser['user']>;
}): BindingWithUser {
  return {
    binding: {
      id: 'binding-1',
      userId: 'user-1',
      partnerId: 'partner-1',
      boundAuthEpoch: 3,
      mfaVerifiedAt: new Date(),
      ...overrides?.binding,
    },
    user: {
      id: 'user-1',
      email: 'tech@msp.example.com',
      name: 'Tech User',
      status: 'active',
      authEpoch: 3,
      partnerId: 'partner-1',
      ...overrides?.user,
    },
  };
}

describe('vetBinding', () => {
  it('ok for an active user whose epoch and partner still match the binding', () => {
    expect(vetBinding(bound())).toEqual({ ok: true });
  });

  it.each(['invited', 'disabled'] as const)('denies user_inactive for status %s', (status) => {
    expect(vetBinding(bound({ user: { status } }))).toEqual({ ok: false, reason: 'user_inactive' });
  });

  it('denies epoch_advanced when the user authEpoch moved past boundAuthEpoch', () => {
    expect(vetBinding(bound({ user: { authEpoch: 4 } }))).toEqual({
      ok: false,
      reason: 'epoch_advanced',
    });
  });

  it('denies membership_revoked when the user left the binding partner', () => {
    expect(vetBinding(bound({ user: { partnerId: 'partner-2' } }))).toEqual({
      ok: false,
      reason: 'membership_revoked',
    });
  });

  it('deny precedence: an inactive user reports user_inactive even with a stale epoch and partner', () => {
    expect(
      vetBinding(bound({ user: { status: 'disabled', authEpoch: 9, partnerId: 'partner-2' } }))
    ).toEqual({ ok: false, reason: 'user_inactive' });
  });
});
