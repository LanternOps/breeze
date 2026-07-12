import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('./authLifecycle', () => ({
  advanceUserSecurityState: vi.fn().mockResolvedValue({ authEpoch: 2 }),
  revokeAllUserSessionFamilies: vi.fn().mockResolvedValue(1),
}));

import {
  shouldActivatePendingPartner,
  activatePartnerRow,
  activatePendingPartnerAndInvalidateSessions,
} from './partnerActivation';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
} from './authLifecycle';
import { organizationUsers, organizations, partners, partnerUsers } from '../db/schema';

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

  it('reports a concurrent activation loser without invalidating sessions twice', async () => {
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      }),
      select: vi.fn(),
    } as any;

    await expect(
      activatePendingPartnerAndInvalidateSessions(tx, 'p-1'),
    ).resolves.toEqual({ activated: false, userIds: [] });
    expect(tx.select).not.toHaveBeenCalled();
    expect(advanceUserSecurityState).not.toHaveBeenCalled();
    expect(revokeAllUserSessionFamilies).not.toHaveBeenCalled();
  });

  it('applies hook status metadata in the guarded activation update', async () => {
    const setSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'p-1' }]),
      }),
    });
    const tx = { update: vi.fn().mockReturnValue({ set: setSpy }) } as any;
    const metadata = {
      message: 'Ready',
      actionUrl: '/welcome',
      actionLabel: 'Continue',
    };

    await activatePartnerRow(tx, 'p-1', new Date('2026-06-13T01:00:00Z'), metadata);

    const settingsSql = setSpy.mock.calls[0]![0]!.settings as {
      queryChunks?: unknown[];
    };
    expect(settingsSql.queryChunks).toEqual(expect.arrayContaining([
      JSON.stringify({
        statusMessage: 'Ready',
        statusActionUrl: '/welcome',
        statusActionLabel: 'Continue',
      }),
    ]));
  });

  it('advances every partner tenant user auth epoch and revokes families after activation', async () => {
    const rowsByTable = new Map<unknown, unknown[]>([
      [organizations, [{ id: 'org-1' }]],
      [partnerUsers, [{ userId: 'user-1' }, { userId: 'user-2' }]],
      [organizationUsers, [{ userId: 'user-2' }, { userId: 'user-3' }]],
    ]);
    const tx = {
      update: vi.fn((table: unknown) => {
        expect(table).toBe(partners);
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'p-1' }]),
            }),
          }),
        };
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn((table: unknown) => ({
          where: vi.fn().mockResolvedValue(rowsByTable.get(table) ?? []),
        })),
      }),
    } as any;

    await expect(
      activatePendingPartnerAndInvalidateSessions(
        tx,
        'p-1',
        new Date('2026-06-13T01:00:00Z'),
      ),
    ).resolves.toEqual({
      activated: true,
      userIds: ['user-1', 'user-2', 'user-3'],
    });

    expect(advanceUserSecurityState).toHaveBeenCalledTimes(3);
    expect(revokeAllUserSessionFamilies).toHaveBeenCalledTimes(3);
    for (const userId of ['user-1', 'user-2', 'user-3']) {
      expect(advanceUserSecurityState).toHaveBeenCalledWith(tx, userId);
      expect(revokeAllUserSessionFamilies).toHaveBeenCalledWith(
        tx,
        userId,
        'partner-activated',
      );
    }
  });

  it('propagates lifecycle failure so the caller transaction rolls back activation', async () => {
    vi.mocked(revokeAllUserSessionFamilies).mockRejectedValueOnce(new Error('family write failed'));
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'p-1' }]),
          }),
        }),
      }),
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: 'user-1' }]),
          }),
        }),
    } as any;

    await expect(
      activatePendingPartnerAndInvalidateSessions(tx, 'p-1'),
    ).rejects.toThrow('family write failed');
  });
});
