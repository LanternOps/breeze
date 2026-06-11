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
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
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

describe('generateVerificationToken', () => {
  beforeEach(() => vi.resetAllMocks());

  it('inserts a SHA-256 hashed token row and returns the raw nanoid', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);

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
      chainSelect([
        {
          id: 'evt-1',
          partnerId: 'p-1',
          userId: 'u-1',
          email: 'a@b.com',
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
        },
      ]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'consumed' });
  });

  it('returns expired when expires_at is in the past', async () => {
    vi.mocked(db.select).mockReturnValue(
      chainSelect([
        {
          id: 'evt-1',
          partnerId: 'p-1',
          userId: 'u-1',
          email: 'a@b.com',
          expiresAt: new Date(Date.now() - 1000),
          consumedAt: null,
        },
      ]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'expired' });
  });

  it('marks token consumed, stamps users + partners email_verified_at on success without auto-activating', async () => {
    const future = new Date(Date.now() + 60_000);
    const tokenSelect = chainSelect([
      {
        id: 'evt-1',
        partnerId: 'p-1',
        userId: 'u-1',
        email: 'a@b.com',
        expiresAt: future,
        consumedAt: null,
      },
    ]);
    const partnerSelect = chainSelect([
      { id: 'p-1', status: 'pending', paymentMethodAttachedAt: null },
    ]);
    vi.mocked(db.select)
      .mockReturnValueOnce(tokenSelect as any)
      .mockReturnValueOnce(partnerSelect as any);

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
    const future = new Date(Date.now() + 60_000);
    const tokenSelect = chainSelect([
      {
        id: 'evt-1',
        partnerId: 'p-1',
        userId: 'u-1',
        email: 'a@b.com',
        expiresAt: future,
        consumedAt: null,
      },
    ]);
    const partnerSelect = chainSelect([
      { id: 'p-1', status: 'pending', paymentMethodAttachedAt: new Date() },
    ]);
    vi.mocked(db.select)
      .mockReturnValueOnce(tokenSelect as any)
      .mockReturnValueOnce(partnerSelect as any);

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
      expect(result.autoActivated).toBe(true);
    }

    const partnerSetCall = (partnerUpdate.set as any).mock.calls[0][0];
    expect(partnerSetCall.status).toBe('active');
    expect(partnerSetCall).toHaveProperty('emailVerifiedAt');
  });

  it('returns superseded when supersededAt is set on the row (resend invalidated this link)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      chainSelect([
        {
          id: 'evt-1',
          partnerId: 'p-1',
          userId: 'u-1',
          email: 'a@b.com',
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
          supersededAt: new Date(Date.now() - 1000),
        },
      ]) as any
    );

    const result = await consumeVerificationToken('rawtoken');
    expect(result).toEqual({ ok: false, error: 'superseded' });
  });

  it('does NOT auto-activate a suspended partner even if payment is attached', async () => {
    const future = new Date(Date.now() + 60_000);
    vi.mocked(db.select)
      .mockReturnValueOnce(
        chainSelect([
          {
            id: 'evt-1',
            partnerId: 'p-1',
            userId: 'u-1',
            email: 'a@b.com',
            expiresAt: future,
            consumedAt: null,
            supersededAt: null,
          },
        ]) as any
      )
      .mockReturnValueOnce(
        chainSelect([
          { id: 'p-1', status: 'suspended', paymentMethodAttachedAt: new Date() },
        ]) as any
      );

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
    const future = new Date(Date.now() + 60_000);
    vi.mocked(db.select).mockReturnValueOnce(
      chainSelect([
        {
          id: 'evt-1',
          partnerId: 'p-1',
          userId: 'u-1',
          email: 'a@b.com',
          expiresAt: future,
          consumedAt: null,
        },
      ]) as any
    );

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
