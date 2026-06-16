import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setApproverPin, verifyPinAttempt } from './pin';
import { db } from '../db';
import { hashPassword, verifyPassword } from './password';

// ============================================
// Mocks
// ============================================

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'id',
    approverPinHash: 'approverPinHash',
    approverPinSetAt: 'approverPinSetAt',
    approverPinFailedCount: 'approverPinFailedCount',
    approverPinLockedUntil: 'approverPinLockedUntil',
  },
}));

vi.mock('./password', () => ({
  hashPassword: vi.fn(async (pin: string) => `hashed:${pin}`),
  verifyPassword: vi.fn(async (hash: string, pin: string) => hash === `hashed:${pin}`),
}));

const mockDb = db as unknown as {
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

const mockHashPassword = hashPassword as unknown as ReturnType<typeof vi.fn>;
const mockVerifyPassword = verifyPassword as unknown as ReturnType<typeof vi.fn>;

/**
 * Wire up chainable db mocks.
 * `capture.updateSet` holds the object passed to `db.update(users).set({...})`.
 * `selectRow` is the single row returned by `db.select(...).from(...).where(...).limit(1)`.
 */
function setupDbMocks(selectRow: Record<string, unknown> | undefined) {
  const capture: { updateSet?: Record<string, unknown> } = {};

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.updateSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  mockDb.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(selectRow ? [selectRow] : []),
      })),
    })),
  });

  return capture;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================
// setApproverPin
// ============================================

describe('setApproverPin', () => {
  it('hashes the PIN, stores it, and resets failed count + lockout', async () => {
    const capture = setupDbMocks(undefined);

    await setApproverPin('user-1', '1234');

    expect(mockHashPassword).toHaveBeenCalledWith('1234');
    expect(capture.updateSet).toBeDefined();
    expect(capture.updateSet!.approverPinHash).toBe('hashed:1234');
    expect(capture.updateSet!.approverPinSetAt).toBeInstanceOf(Date);
    expect(capture.updateSet!.approverPinFailedCount).toBe(0);
    expect(capture.updateSet!.approverPinLockedUntil).toBeNull();
  });
});

// ============================================
// verifyPinAttempt
// ============================================

describe('verifyPinAttempt', () => {
  it('returns verified:true and resets failed count on a matching PIN', async () => {
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 2,
      lockedUntil: null,
    });

    const result = await verifyPinAttempt('user-1', '1234');

    expect(result).toEqual({ verified: true, locked: false });
    expect(mockVerifyPassword).toHaveBeenCalledWith('hashed:1234', '1234');
    expect(capture.updateSet).toBeDefined();
    expect(capture.updateSet!.approverPinFailedCount).toBe(0);
    expect(capture.updateSet!.approverPinLockedUntil).toBeNull();
  });

  it('returns verified:false without locking on a mismatch below the threshold', async () => {
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 1,
      lockedUntil: null,
    });

    const result = await verifyPinAttempt('user-1', '9999');

    expect(result).toEqual({ verified: false, locked: false });
    expect(capture.updateSet!.approverPinFailedCount).toBe(2);
    expect(capture.updateSet!.approverPinLockedUntil).toBeNull();
  });

  it('locks the account at >= 5 failed attempts and sets lockedUntil ~15m out', async () => {
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 4,
      lockedUntil: null,
    });

    const before = Date.now();
    const result = await verifyPinAttempt('user-1', '9999');

    expect(result).toEqual({ verified: false, locked: true });
    expect(capture.updateSet!.approverPinFailedCount).toBe(5);
    const lockedUntil = capture.updateSet!.approverPinLockedUntil as Date;
    expect(lockedUntil).toBeInstanceOf(Date);
    const deltaMs = lockedUntil.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(deltaMs).toBeLessThanOrEqual(15 * 60_000 + 5000);
  });

  it('starts a FRESH window after an expired lock (wrong PIN → failed=1, not re-locked)', async () => {
    // Previously locked out (failed=5) but the lock has since expired. A wrong
    // PIN must reset the window to failed=1, NOT carry the stale 5 forward and
    // re-lock immediately (which would give 1 try per 15 min forever).
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 5,
      lockedUntil: new Date(Date.now() - 60_000), // expired a minute ago
    });

    const result = await verifyPinAttempt('user-1', '9999');

    expect(result).toEqual({ verified: false, locked: false });
    expect(capture.updateSet!.approverPinFailedCount).toBe(1);
    expect(capture.updateSet!.approverPinLockedUntil).toBeNull();
  });

  it('returns locked:true without checking the PIN when already locked', async () => {
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    const result = await verifyPinAttempt('user-1', '1234');

    expect(result).toEqual({ verified: false, locked: true });
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(capture.updateSet).toBeUndefined();
  });

  it('returns verified:false, locked:false when the user has no PIN set', async () => {
    const capture = setupDbMocks({
      hash: null,
      failed: 0,
      lockedUntil: null,
    });

    const result = await verifyPinAttempt('user-1', '1234');

    expect(result).toEqual({ verified: false, locked: false });
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(capture.updateSet).toBeUndefined();
  });

  it('returns verified:false, locked:false when the user is not found', async () => {
    setupDbMocks(undefined);

    const result = await verifyPinAttempt('missing', '1234');

    expect(result).toEqual({ verified: false, locked: false });
  });

  it('treats an expired lock as unlocked and proceeds to verify', async () => {
    const capture = setupDbMocks({
      hash: 'hashed:1234',
      failed: 5,
      lockedUntil: new Date(Date.now() - 60_000),
    });

    const result = await verifyPinAttempt('user-1', '1234');

    expect(result).toEqual({ verified: true, locked: false });
    expect(mockVerifyPassword).toHaveBeenCalledWith('hashed:1234', '1234');
    expect(capture.updateSet!.approverPinFailedCount).toBe(0);
  });
});
