import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('./authLifecycle', () => ({
  advanceUserEpochs: vi.fn(async (_tx: unknown, userId: string) => ({
    authEpoch: userId === 'user-1' ? 4 : 7,
    mfaEpoch: userId === 'user-1' ? 2 : 3,
    emailEpoch: 1,
    passwordResetEpoch: 1,
  })),
  lockActiveRefreshFamiliesForUsers: vi.fn(async () => undefined),
  revokeAllRefreshFamilies: vi.fn(async () => undefined),
}));

import {
  shouldActivatePendingPartner,
  activatePartnerRow,
  activatePendingPartnerAndInvalidateSessions,
  billingStatusContradictsPayment,
} from './partnerActivation';
import {
  advanceUserEpochs,
  lockActiveRefreshFamiliesForUsers,
  revokeAllRefreshFamilies,
} from './authLifecycle';
import {
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  users,
} from '../db/schema';

describe('shouldActivatePendingPartner (#718 reconciliation predicate)', () => {
  const verified = new Date('2026-06-13T00:00:00Z');
  const paid = new Date('2026-06-13T00:05:00Z');

  it('activates a pending partner with BOTH email verified and payment attached', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: verified,
        paymentMethodAttachedAt: paid,
      }),
    ).toBe(true);
  });

  it('does NOT activate on email-verified alone (no payment) — never comp a non-payer', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: verified,
        paymentMethodAttachedAt: null,
      }),
    ).toBe(false);
  });

  it('does NOT activate on payment alone (email not verified) — verification gate holds', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: null,
        paymentMethodAttachedAt: paid,
      }),
    ).toBe(false);
  });

  it('does NOT activate when neither precondition is met', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: null,
        paymentMethodAttachedAt: null,
      }),
    ).toBe(false);
  });

  it.each(['suspended', 'churned', 'active'])(
    'never resurrects a %s partner even with both preconditions met',
    (status) => {
      expect(
        shouldActivatePendingPartner({
          status,
          emailVerifiedAt: verified,
          paymentMethodAttachedAt: paid,
        }),
      ).toBe(false);
    },
  );

  it('does NOT activate a soft-deleted partner even when both preconditions are met', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: verified,
        paymentMethodAttachedAt: paid,
        deletedAt: new Date(),
      }),
    ).toBe(false);
  });

  it('treats string timestamps (DB driver shape) as present', () => {
    expect(
      shouldActivatePendingPartner({
        status: 'pending',
        emailVerifiedAt: '2026-06-13T00:00:00Z',
        paymentMethodAttachedAt: '2026-06-13T00:05:00Z',
      }),
    ).toBe(true);
  });

  // The payment stamp was demonstrably writable without a capture (audited
  // 2026-07-29: 34 of 55 stamped partners had zero successful Stripe charges,
  // because an `incomplete_expired` subscription.updated backfilled it). These
  // cases stop the stamp alone from granting access.
  describe('billing-status veto', () => {
    it.each(['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused'])(
      'does NOT activate when the billing mirror reads %s, despite both preconditions',
      (billingSubscriptionStatus) => {
        expect(
          shouldActivatePendingPartner({
            status: 'pending',
            emailVerifiedAt: verified,
            paymentMethodAttachedAt: paid,
            billingSubscriptionStatus,
          }),
        ).toBe(false);
      },
    );

    it.each(['active', 'past_due', 'trialing'])(
      'still activates when the billing mirror reads %s',
      (billingSubscriptionStatus) => {
        expect(
          shouldActivatePendingPartner({
            status: 'pending',
            emailVerifiedAt: verified,
            paymentMethodAttachedAt: paid,
            billingSubscriptionStatus,
          }),
        ).toBe(true);
      },
    );

    // This is a VETO, not a REQUIREMENT — and that distinction is the whole
    // point of #718. A lost `subscription.updated` webhook leaves the mirror
    // NULL on a partner who really did pay; requiring a good status would
    // strand them permanently, which is the exact bug #718 exists to fix.
    it('activates when the mirror is NULL (never populated / webhook lost)', () => {
      expect(
        shouldActivatePendingPartner({
          status: 'pending',
          emailVerifiedAt: verified,
          paymentMethodAttachedAt: paid,
          billingSubscriptionStatus: null,
        }),
      ).toBe(true);
    });

    it('activates when the field is omitted entirely (caller predates the veto)', () => {
      expect(
        shouldActivatePendingPartner({
          status: 'pending',
          emailVerifiedAt: verified,
          paymentMethodAttachedAt: paid,
        }),
      ).toBe(true);
    });

    // Fails open on purpose: an unrecognised future Stripe status must not
    // silently start locking out paying partners.
    it('activates on an unrecognised status rather than failing closed', () => {
      expect(
        shouldActivatePendingPartner({
          status: 'pending',
          emailVerifiedAt: verified,
          paymentMethodAttachedAt: paid,
          billingSubscriptionStatus: 'some_future_stripe_status',
        }),
      ).toBe(true);
    });
  });
});

describe('billingStatusContradictsPayment', () => {
  it.each(['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused'])(
    'contradicts a payment stamp for %s',
    (status) => {
      expect(billingStatusContradictsPayment(status)).toBe(true);
    },
  );

  it.each(['active', 'past_due', 'trialing', 'unknown_status'])(
    'does not contradict for %s',
    (status) => {
      expect(billingStatusContradictsPayment(status)).toBe(false);
    },
  );

  it.each([null, undefined])('does not contradict for %s', (status) => {
    expect(billingStatusContradictsPayment(status)).toBe(false);
  });
});

describe('activatePartnerRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues an UPDATE flipping status to active, clearing the banner, guarded on pending', async () => {
    const returningSpy = vi.fn().mockResolvedValue([{ id: 'p-1' }]);
    const whereSpy = vi.fn().mockReturnValue({ returning: returningSpy });
    const setSpy = vi.fn().mockReturnValue({ where: whereSpy });
    const updateSpy = vi.fn().mockReturnValue({ set: setSpy });
    const tx = { update: updateSpy } as any;

    const now = new Date('2026-06-13T01:00:00Z');
    await expect(activatePartnerRow(tx, 'p-1', now)).resolves.toBe(true);

    expect(updateSpy).toHaveBeenCalledOnce();
    const setArg = setSpy.mock.calls[0]![0]!;
    expect(setArg.status).toBe('active');
    expect(setArg).toHaveProperty('settings');
    expect(setArg.updatedAt).toBe(now);
    // The UPDATE must carry a WHERE so a concurrent activation is idempotent
    // (status='pending' guard) and can never clobber a different partner.
    expect(whereSpy).toHaveBeenCalledOnce();
    expect(returningSpy).toHaveBeenCalledOnce();
  });

  it('locks users and families before activation, then advances epochs and revokes old families', async () => {
    const events: string[] = [];
    const rowsByTable = new Map<unknown, unknown[]>([
      [organizations, [{ id: 'org-1' }]],
      [partnerUsers, [{ userId: 'user-2' }, { userId: 'user-1' }]],
      [organizationUsers, [{ userId: 'user-2' }]],
    ]);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn((table: unknown) => {
          if (table === users) {
            return {
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  for: vi.fn(async () => {
                    events.push('lock:users');
                    return [
                      { id: 'user-1', authEpoch: 3, mfaEpoch: 2 },
                      { id: 'user-2', authEpoch: 6, mfaEpoch: 3 },
                    ];
                  }),
                }),
              }),
            };
          }
          return { where: vi.fn().mockResolvedValue(rowsByTable.get(table) ?? []) };
        }),
      }),
      update: vi.fn((table: unknown) => {
        if (table === partners) events.push('update:partner');
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'p-1' }]),
            }),
          }),
        };
      }),
    } as any;
    vi.mocked(lockActiveRefreshFamiliesForUsers).mockImplementationOnce(async () => {
      events.push('lock:families');
    });

    const result = await activatePendingPartnerAndInvalidateSessions(tx, 'p-1');

    expect(events).toEqual(['lock:users', 'lock:families', 'update:partner']);
    expect(result).toEqual({
      activated: true,
      epochs: [
        { userId: 'user-1', authEpoch: 4, mfaEpoch: 2 },
        { userId: 'user-2', authEpoch: 7, mfaEpoch: 3 },
      ],
    });
    expect(advanceUserEpochs).toHaveBeenNthCalledWith(1, tx, 'user-1', { auth: true });
    expect(advanceUserEpochs).toHaveBeenNthCalledWith(2, tx, 'user-2', { auth: true });
    expect(lockActiveRefreshFamiliesForUsers).toHaveBeenCalledWith(tx, ['user-1', 'user-2']);
    expect(revokeAllRefreshFamilies).toHaveBeenNthCalledWith(1, tx, 'user-1', 'partner-activated');
    expect(revokeAllRefreshFamilies).toHaveBeenNthCalledWith(2, tx, 'user-2', 'partner-activated');
  });
});
