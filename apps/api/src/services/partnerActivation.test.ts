import { describe, it, expect, vi } from 'vitest';
import { shouldActivatePendingPartner, activatePartnerRow } from './partnerActivation';

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
});

describe('activatePartnerRow', () => {
  it('issues an UPDATE flipping status to active, clearing the banner, guarded on pending', async () => {
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    const setSpy = vi.fn().mockReturnValue({ where: whereSpy });
    const updateSpy = vi.fn().mockReturnValue({ set: setSpy });
    const tx = { update: updateSpy } as any;

    const now = new Date('2026-06-13T01:00:00Z');
    await activatePartnerRow(tx, 'p-1', now);

    expect(updateSpy).toHaveBeenCalledOnce();
    const setArg = setSpy.mock.calls[0]![0]!;
    expect(setArg.status).toBe('active');
    expect(setArg).toHaveProperty('settings');
    expect(setArg.updatedAt).toBe(now);
    // The UPDATE must carry a WHERE so a concurrent activation is idempotent
    // (status='pending' guard) and can never clobber a different partner.
    expect(whereSpy).toHaveBeenCalledOnce();
  });
});
