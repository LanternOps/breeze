import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured SET payloads from the pending-email transaction.
const { setCalls, updateReturning } = vi.hoisted(() => ({
  setCalls: [] as Array<Record<string, unknown>>,
  updateReturning: vi.fn(async () => [{ id: 'u1' }]),
}));

vi.mock('../db', () => {
  const txUpdate = () => ({
    set: (values: Record<string, unknown>) => {
      setCalls.push(values);
      return {
        where: () => ({
          returning: () => updateReturning(),
        }),
      };
    },
  });
  return {
    db: {
      transaction: vi.fn(async (fn: any) => fn({ update: txUpdate })),
    },
    runOutsideDbContext: vi.fn((fn: any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  };
});

vi.mock('../db/schema', () => ({ users: {} }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: vi.fn(actual.eq) };
});

vi.mock('./authLifecycle', () => ({
  advanceUserEpochs: vi.fn(async () => ({
    authEpoch: 1,
    mfaEpoch: 1,
    emailEpoch: 5,
    passwordResetEpoch: 1,
  })),
}));

vi.mock('./emailVerification', () => ({
  generateVerificationToken: vi.fn(async () => 'raw-token-mock'),
  invalidateOpenTokens: vi.fn(async () => 0),
}));

import { requestPendingEmailChange } from './pendingEmail';
import { advanceUserEpochs } from './authLifecycle';
import { generateVerificationToken, invalidateOpenTokens } from './emailVerification';

describe('requestPendingEmailChange (SR2-17)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCalls.length = 0;
    updateReturning.mockResolvedValue([{ id: 'u1' }]);
  });

  it('writes pending_email + pending_email_requested_at, advances ONLY email_epoch, and mints an email_change token', async () => {
    const out = await requestPendingEmailChange({ userId: 'u1', partnerId: 'p1', newEmail: 'New@corp.com' });

    expect(setCalls[0]).toMatchObject({ pendingEmail: 'new@corp.com' });
    expect(setCalls[0]!.pendingEmailRequestedAt).toBeInstanceOf(Date);
    // users.email is NOT touched — that is the whole finding.
    expect(setCalls[0]).not.toHaveProperty('email');
    // Only email_epoch advances — no auth_epoch (no sign-out at initiation).
    expect(vi.mocked(advanceUserEpochs)).toHaveBeenCalledWith(expect.anything(), 'u1', { email: true });
    expect(vi.mocked(invalidateOpenTokens)).toHaveBeenCalledWith('u1');
    expect(vi.mocked(generateVerificationToken)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', partnerId: 'p1', email: 'new@corp.com', purpose: 'email_change' }),
    );
    expect(out.rawToken).toBe('raw-token-mock');
    expect(out.emailEpoch).toBe(5);
  });

  it('fails closed when the pending-email UPDATE matches 0 rows (RLS-filtered) — no token minted', async () => {
    updateReturning.mockResolvedValueOnce([]); // 0 rows
    await expect(
      requestPendingEmailChange({ userId: 'u1', partnerId: 'p1', newEmail: 'new@corp.com' }),
    ).rejects.toThrow(/pending email/i);
    expect(vi.mocked(generateVerificationToken)).not.toHaveBeenCalled();
    expect(vi.mocked(invalidateOpenTokens)).not.toHaveBeenCalled();
  });
});
