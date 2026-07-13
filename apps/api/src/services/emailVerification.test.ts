import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => {
  // Drizzle's `db.transaction(fn)` calls fn with a `tx` that has the same
  // CRUD surface as `db`. We pass `db` itself so existing chain mocks work.
  const dbInner = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbInner)),
  };
  return {
    db: dbInner,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  emailVerificationTokens: {
    id: 'evt.id',
    tokenHash: 'evt.tokenHash',
    partnerId: 'evt.partnerId',
    userId: 'evt.userId',
    email: 'evt.email',
    emailEpoch: 'evt.emailEpoch',
    expiresAt: 'evt.expiresAt',
    consumedAt: 'evt.consumedAt',
    supersededAt: 'evt.supersededAt',
  },
  partners: {
    id: 'partners.id',
    status: 'partners.status',
    paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt',
    emailVerifiedAt: 'partners.emailVerifiedAt',
    settings: 'partners.settings',
    updatedAt: 'partners.updatedAt',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
    emailEpoch: 'users.emailEpoch',
    emailVerifiedAt: 'users.emailVerifiedAt',
  },
}));

import { db } from '../db';
import {
  consumeVerificationToken,
  generateVerificationToken,
  invalidateOpenTokens,
} from './emailVerification';

function chainSelect(rows: unknown[]) {
  // `.limit(1)` is awaited directly by most callers, but the live-user read in
  // consumeVerificationToken continues with `.for('update')` (row lock — see
  // the check-then-act race it closes). Model the node as an awaitable that
  // also carries `.for`, so both shapes resolve to the same rows.
  const limitNode = Promise.resolve(rows) as Promise<unknown[]> & {
    for: (mode: string) => Promise<unknown[]>;
  };
  limitNode.for = vi.fn().mockResolvedValue(rows);

  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue(limitNode),
      }),
    }),
  };
}

function chainUpdateReturning(rows: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function chainUpdateNoReturning() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

const future = () => new Date(Date.now() + 60_000);

/** A live, unconsumed token row bound to a@b.com at email_epoch 1. */
function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    partnerId: 'p-1',
    userId: 'u-1',
    email: 'a@b.com',
    emailEpoch: 1,
    expiresAt: future(),
    consumedAt: null,
    supersededAt: null,
    ...overrides,
  };
}

/**
 * consumeVerificationToken issues three SELECTs in order: the token row, the
 * live user row (#2428 generation check), then the partner row.
 */
function mockConsumeSelects(
  token: Record<string, unknown>,
  liveUser: Record<string, unknown> | null = { email: 'a@b.com', emailEpoch: 1 },
  partner: Record<string, unknown> | null = { id: 'p-1', status: 'pending', paymentMethodAttachedAt: null }
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chainSelect([token]) as any)
    .mockReturnValueOnce(chainSelect(liveUser ? [liveUser] : []) as any)
    .mockReturnValueOnce(chainSelect(partner ? [partner] : []) as any);
}

describe('generateVerificationToken', () => {
  beforeEach(() => vi.resetAllMocks());

  it('inserts a SHA-256 hashed token row and returns the raw nanoid', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
    vi.mocked(db.select).mockReturnValue(chainSelect([{ emailEpoch: 1 }]) as any);

    const raw = await generateVerificationToken({
      partnerId: 'p-1',
      userId: 'u-1',
      email: 'TEST@example.com',
    });

    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThanOrEqual(48);
    expect(valuesSpy).toHaveBeenCalledOnce();

    const inserted = valuesSpy.mock.calls[0]![0]!;
    expect(inserted.partnerId).toBe('p-1');
    expect(inserted.userId).toBe('u-1');
    expect(inserted.email).toBe('test@example.com');
    expect(inserted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted.tokenHash).not.toBe(raw);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // #2428: the row records the generation it was minted under, so a later email
  // change (which advances email_epoch) invalidates it at consume.
  it('binds the token to the user CURRENT email_epoch', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
    vi.mocked(db.select).mockReturnValue(chainSelect([{ emailEpoch: 7 }]) as any);

    await generateVerificationToken({ partnerId: 'p-1', userId: 'u-1', email: 'a@b.com' });

    expect(valuesSpy.mock.calls[0]![0]!.emailEpoch).toBe(7);
  });

  // Fail CLOSED: a NULL epoch disables the generation check at consume, so it
  // must only ever come from a pre-migration row — never be minted fresh
  // because the user row was invisible in the current DB context.
  it('throws rather than minting a NULL-epoch (generation-unbound) token when the user row is unreadable', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
    vi.mocked(db.select).mockReturnValue(chainSelect([]) as any);

    await expect(
      generateVerificationToken({ partnerId: 'p-1', userId: 'u-1', email: 'a@b.com' })
    ).rejects.toThrow(/not readable/i);

    expect(valuesSpy).not.toHaveBeenCalled();
  });
});

describe('consumeVerificationToken', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns invalid when token row is not found', async () => {
    vi.mocked(db.select).mockReturnValue(chainSelect([]) as any);
    const result = await consumeVerificationToken('does-not-exist');
    expect(result).toEqual({ ok: false, error: 'invalid' });
  });

  it('returns consumed when consumed_at is already set', async () => {
    vi.mocked(db.select).mockReturnValue(
      chainSelect([tokenRow({ consumedAt: new Date() })]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'consumed' });
  });

  it('returns expired when expires_at is in the past', async () => {
    vi.mocked(db.select).mockReturnValue(
      chainSelect([tokenRow({ expiresAt: new Date(Date.now() - 1000) })]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'expired' });
  });

  it('marks token consumed, stamps users + partners email_verified_at on success without auto-activating', async () => {
    mockConsumeSelects(tokenRow());

    const tokenUpdate = chainUpdateReturning([{ id: 'evt-1' }]);
    const userUpdate = chainUpdateNoReturning();
    const partnerUpdate = chainUpdateNoReturning();

    vi.mocked(db.update)
      .mockReturnValueOnce(tokenUpdate as any)
      .mockReturnValueOnce(userUpdate as any)
      .mockReturnValueOnce(partnerUpdate as any);

    const result = await consumeVerificationToken('rawtoken');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partnerId).toBe('p-1');
      expect(result.userId).toBe('u-1');
      expect(result.email).toBe('a@b.com');
      expect(result.autoActivated).toBe(false);
    }

    const partnerSetCall = (partnerUpdate.set as any).mock.calls[0][0];
    expect(partnerSetCall).toHaveProperty('emailVerifiedAt');
    expect(partnerSetCall).not.toHaveProperty('status');
  });

  it('auto-activates partner when status=pending and payment method attached', async () => {
    mockConsumeSelects(tokenRow(), { email: 'a@b.com', emailEpoch: 1 }, {
      id: 'p-1',
      status: 'pending',
      paymentMethodAttachedAt: new Date(),
    });

    const tokenUpdate = chainUpdateReturning([{ id: 'evt-1' }]);
    const userUpdate = chainUpdateNoReturning();
    // On the auto-activate path the partner write splits in two: first the
    // email_verified_at stamp, then activatePartnerRow flips status + clears
    // the inactive banner (shared with partnerGuard).
    const partnerEmailUpdate = chainUpdateNoReturning();
    const partnerActivateUpdate = chainUpdateNoReturning();

    vi.mocked(db.update)
      .mockReturnValueOnce(tokenUpdate as any)
      .mockReturnValueOnce(userUpdate as any)
      .mockReturnValueOnce(partnerEmailUpdate as any)
      .mockReturnValueOnce(partnerActivateUpdate as any);

    const result = await consumeVerificationToken('rawtoken');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autoActivated).toBe(true);
    }

    const emailSetCall = (partnerEmailUpdate.set as any).mock.calls[0][0];
    expect(emailSetCall).toHaveProperty('emailVerifiedAt');

    const activateSetCall = (partnerActivateUpdate.set as any).mock.calls[0][0];
    expect(activateSetCall.status).toBe('active');
    expect(activateSetCall).toHaveProperty('settings');
  });

  it('returns superseded when supersededAt is set on the row (resend invalidated this link)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      chainSelect([tokenRow({ supersededAt: new Date(Date.now() - 1000) })]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'superseded' });
  });

  // #2428 — the generation gate. Without it, a link mailed to the OLD address
  // still redeems after an email change and stamps email_verified_at on the
  // NEW address, which nobody ever proved control of.
  describe('email generation binding (#2428)', () => {
    // 'address_changed', NOT 'superseded': no newer link was sent, so the copy
    // must not tell the user to go find one. See ConsumeFailureReason.
    it('returns address_changed when the user email_epoch has moved on (email changed since issue)', async () => {
      mockConsumeSelects(tokenRow({ emailEpoch: 1 }), { email: 'a@b.com', emailEpoch: 2 });

      const result = await consumeVerificationToken('rawtoken');

      expect(result).toEqual({ ok: false, error: 'address_changed' });
      // Fail closed BEFORE any write: the stale link must not consume itself,
      // and must never stamp email_verified_at.
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('returns address_changed when the live address no longer matches the token address', async () => {
      mockConsumeSelects(tokenRow({ email: 'old@b.com' }), { email: 'new@b.com', emailEpoch: 1 });

      const result = await consumeVerificationToken('rawtoken');

      expect(result).toEqual({ ok: false, error: 'address_changed' });
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('returns superseded when the user row is gone', async () => {
      mockConsumeSelects(tokenRow(), null);

      const result = await consumeVerificationToken('rawtoken');

      expect(result).toEqual({ ok: false, error: 'superseded' });
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('accepts a legacy NULL-epoch row (pre-migration) whose address still matches', async () => {
      mockConsumeSelects(tokenRow({ emailEpoch: null }), { email: 'a@b.com', emailEpoch: 4 });

      vi.mocked(db.update)
        .mockReturnValueOnce(chainUpdateReturning([{ id: 'evt-1' }]) as any)
        .mockReturnValueOnce(chainUpdateNoReturning() as any)
        .mockReturnValueOnce(chainUpdateNoReturning() as any);

      const result = await consumeVerificationToken('rawtoken');

      // In-flight signup links must survive the deploy rather than hard-fail.
      expect(result.ok).toBe(true);
    });

    it('matches the address case-insensitively', async () => {
      mockConsumeSelects(tokenRow({ email: 'A@B.com' }), { email: 'a@b.com', emailEpoch: 1 });

      vi.mocked(db.update)
        .mockReturnValueOnce(chainUpdateReturning([{ id: 'evt-1' }]) as any)
        .mockReturnValueOnce(chainUpdateNoReturning() as any)
        .mockReturnValueOnce(chainUpdateNoReturning() as any);

      const result = await consumeVerificationToken('rawtoken');
      expect(result.ok).toBe(true);
    });
  });

  it('does NOT auto-activate a suspended partner even if payment is attached', async () => {
    mockConsumeSelects(tokenRow(), { email: 'a@b.com', emailEpoch: 1 }, {
      id: 'p-1',
      status: 'suspended',
      paymentMethodAttachedAt: new Date(),
    });

    const tokenUpdate = chainUpdateReturning([{ id: 'evt-1' }]);
    const userUpdate = chainUpdateNoReturning();
    const partnerUpdate = chainUpdateNoReturning();
    vi.mocked(db.update)
      .mockReturnValueOnce(tokenUpdate as any)
      .mockReturnValueOnce(userUpdate as any)
      .mockReturnValueOnce(partnerUpdate as any);

    const result = await consumeVerificationToken('rawtoken');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autoActivated).toBe(false);
    }

    // The partner update must NOT include status=active. A suspended-then-
    // verify should leave status=suspended (the abuse path is enforced by
    // not the active-flip predicate, by design — a future broadening of the
    // predicate to "not active" would re-activate suspended partners).
    const partnerSetCall = (partnerUpdate.set as any).mock.calls[0][0];
    expect(partnerSetCall.status).toBeUndefined();
  });

  it('returns consumed if a concurrent request claimed the token first', async () => {
    mockConsumeSelects(tokenRow());

    // Conditional UPDATE returns no rows — another request claimed it.
    vi.mocked(db.update).mockReturnValueOnce(chainUpdateReturning([]) as any);

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'consumed' });
  });
});

describe('invalidateOpenTokens', () => {
  beforeEach(() => vi.resetAllMocks());

  it('updates all unconsumed tokens for the user and returns the count', async () => {
    vi.mocked(db.update).mockReturnValue(
      chainUpdateReturning([{ id: 'evt-1' }, { id: 'evt-2' }]) as any
    );

    const count = await invalidateOpenTokens('u-1');
    expect(count).toBe(2);
  });

  it('returns 0 when no live tokens exist', async () => {
    vi.mocked(db.update).mockReturnValue(chainUpdateReturning([]) as any);
    const count = await invalidateOpenTokens('u-1');
    expect(count).toBe(0);
  });
});
