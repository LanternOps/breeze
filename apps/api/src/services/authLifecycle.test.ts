import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  returningQueue: [] as unknown[][],
  selectQueue: [] as unknown[][],
  updateCalls: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    where: unknown;
  }>,
  failureQueue: [] as Array<Error | null>,
  selectCalls: [] as Array<{ fields: unknown; table: unknown; where: unknown }>,
}));

const contextState = vi.hoisted(() => ({
  scope: 'actor' as 'actor' | 'none' | 'system',
  observations: [] as string[],
}));

vi.mock('../db', () => ({
  db: { scopeTag: 'system-transaction' },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const previous = contextState.scope;
    contextState.scope = 'none';
    contextState.observations.push('outside');
    try {
      return fn();
    } finally {
      contextState.scope = previous;
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextState.observations.push(`system-from-${contextState.scope}`);
    const previous = contextState.scope;
    contextState.scope = 'system';
    try {
      return await fn();
    } finally {
      contextState.scope = previous;
    }
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...clauses: unknown[]) => ({ and: clauses })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: Array.from(strings).join('?'),
    values,
  })),
}));

vi.mock('../db/schema/users', () => ({
  users: {
    id: 'users.id',
    authEpoch: 'users.authEpoch',
    mfaEpoch: 'users.mfaEpoch',
    emailEpoch: 'users.emailEpoch',
    passwordResetEpoch: 'users.passwordResetEpoch',
  },
}));

vi.mock('../db/schema/refreshTokenFamilies', () => ({
  refreshTokenFamilies: {
    familyId: 'refreshTokenFamilies.familyId',
    userId: 'refreshTokenFamilies.userId',
    revokedAt: 'refreshTokenFamilies.revokedAt',
    revokedReason: 'refreshTokenFamilies.revokedReason',
  },
}));

import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  revokeUserSessionFamily,
  revokeUserSessionFamilyForLogout,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import * as authLifecycle from './authLifecycle';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';

function makeTx(): AuthLifecycleTransaction {
  return {
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: async () => {
            const failure = dbState.failureQueue.shift();
            if (failure) throw failure;
            dbState.updateCalls.push({ table, values, where });
            return dbState.returningQueue.shift() ?? [];
          },
        }),
      }),
    })),
    select: vi.fn((fields: unknown) => ({
      from: (table: unknown) => ({
        where: (where: unknown) => ({
          limit: async () => {
            dbState.selectCalls.push({ fields, table, where });
            return dbState.selectQueue.shift() ?? [];
          },
        }),
      }),
    })),
  } as unknown as AuthLifecycleTransaction;
}

describe('authLifecycle transaction primitives', () => {
  beforeEach(() => {
    dbState.returningQueue.length = 0;
    dbState.selectQueue.length = 0;
    dbState.updateCalls.length = 0;
    dbState.failureQueue.length = 0;
    dbState.selectCalls.length = 0;
    contextState.scope = 'actor';
    contextState.observations.length = 0;
  });

  it('exits an actor context before opening the effective system transaction', async () => {
    const withSystemTransaction = (authLifecycle as Record<string, unknown>)
      .withAuthLifecycleSystemTransaction;
    expect(withSystemTransaction).toEqual(expect.any(Function));

    const result = await (withSystemTransaction as (fn: (tx: unknown) => Promise<string>) => Promise<string>)(
      async (tx) => {
        expect(contextState.scope).toBe('system');
        expect(tx).toMatchObject({ scopeTag: 'system-transaction' });
        return 'committed';
      },
    );

    expect(result).toBe('committed');
    expect(contextState.observations).toEqual(['outside', 'system-from-none']);
  });

  it('increments requested epochs in one user update and returns the updated state', async () => {
    dbState.returningQueue.push([{
      id: 'user-1',
      authEpoch: 3,
      mfaEpoch: 5,
      emailEpoch: 7,
      passwordResetEpoch: 11,
    }]);

    const result = await advanceUserSecurityState(makeTx(), 'user-1', {
      auth: true,
      mfa: true,
      passwordReset: true,
    });

    expect(result).toEqual({
      id: 'user-1',
      authEpoch: 3,
      mfaEpoch: 5,
      emailEpoch: 7,
      passwordResetEpoch: 11,
    });
    expect(dbState.updateCalls).toHaveLength(1);
    expect(dbState.updateCalls[0]).toMatchObject({
      table: users,
      values: {
        authEpoch: { sql: '? + 1', values: ['users.authEpoch'] },
        mfaEpoch: { sql: '? + 1', values: ['users.mfaEpoch'] },
        passwordResetEpoch: { sql: '? + 1', values: ['users.passwordResetEpoch'] },
      },
      where: { eq: ['users.id', 'user-1'] },
    });
    expect(dbState.updateCalls[0]?.values).not.toHaveProperty('emailEpoch');
  });

  it('increments auth epoch by default', async () => {
    dbState.returningQueue.push([{
      id: 'user-1',
      authEpoch: 2,
      mfaEpoch: 1,
      emailEpoch: 1,
      passwordResetEpoch: 1,
    }]);

    await advanceUserSecurityState(makeTx(), 'user-1');

    expect(dbState.updateCalls[0]?.values).toEqual({
      authEpoch: { sql: '? + 1', values: ['users.authEpoch'] },
    });
  });

  it('throws when the expected user update affects no row', async () => {
    dbState.returningQueue.push([]);

    await expect(advanceUserSecurityState(makeTx(), 'missing-user')).rejects.toThrow(
      'Failed to advance security state for user missing-user',
    );
  });

  it('revokes every unrevoked family and returns the affected row count', async () => {
    dbState.returningQueue.push([{ familyId: 'family-1' }, { familyId: 'family-2' }]);
    const reason = `membership-removed-${'x'.repeat(80)}`;

    const count = await revokeAllUserSessionFamilies(
      makeTx(),
      'user-1',
      reason,
    );

    expect(count).toBe(2);
    expect(dbState.updateCalls[0]).toMatchObject({
      table: refreshTokenFamilies,
      values: {
        revokedAt: { sql: 'now()', values: [] },
        revokedReason: reason.slice(0, 64),
      },
      where: {
        and: [
          { eq: ['refreshTokenFamilies.userId', 'user-1'] },
          { isNull: 'refreshTokenFamilies.revokedAt' },
        ],
      },
    });
    expect(String(dbState.updateCalls[0]?.values.revokedReason)).toHaveLength(64);
  });

  it('is idempotent and preserves the first revocation reason and timestamp', async () => {
    dbState.returningQueue.push([{ familyId: 'family-1' }], []);
    const tx = makeTx();

    expect(await revokeAllUserSessionFamilies(tx, 'user-1', 'first-reason')).toBe(1);
    expect(await revokeAllUserSessionFamilies(tx, 'user-1', 'later-reason')).toBe(0);

    expect(dbState.updateCalls[1]?.where).toEqual({
      and: [
        { eq: ['refreshTokenFamilies.userId', 'user-1'] },
        { isNull: 'refreshTokenFamilies.revokedAt' },
      ],
    });
  });

  it('revokes one family only when the family belongs to the supplied user', async () => {
    dbState.returningQueue.push([]);

    const count = await revokeUserSessionFamily(
      makeTx(),
      'user-1',
      'family-owned-by-another-user',
      'logout',
    );

    expect(count).toBe(0);
    expect(dbState.updateCalls[0]?.where).toEqual({
      and: [
        { eq: ['refreshTokenFamilies.familyId', 'family-owned-by-another-user'] },
        { eq: ['refreshTokenFamilies.userId', 'user-1'] },
        { isNull: 'refreshTokenFamilies.revokedAt' },
      ],
    });
  });

  it('classifies an owned active family as newly revoked without a follow-up read', async () => {
    dbState.returningQueue.push([{ familyId: 'family-1' }]);

    const outcome = await revokeUserSessionFamilyForLogout(
      makeTx(),
      'user-1',
      'family-1',
      'logout',
    );

    expect(outcome).toEqual({ status: 'revoked' });
    expect(dbState.selectCalls).toEqual([]);
  });

  it('classifies a zero-row conditional update by re-reading an owned revoked family', async () => {
    const revokedAt = new Date('2026-07-12T00:00:00.000Z');
    dbState.returningQueue.push([]);
    dbState.selectQueue.push([{ revokedAt }]);

    const outcome = await revokeUserSessionFamilyForLogout(
      makeTx(),
      'user-1',
      'family-1',
      'logout',
    );

    expect(outcome).toEqual({ status: 'already_revoked' });
    expect(dbState.selectCalls[0]).toEqual({
      fields: { revokedAt: 'refreshTokenFamilies.revokedAt' },
      table: refreshTokenFamilies,
      where: {
        and: [
          { eq: ['refreshTokenFamilies.familyId', 'family-1'] },
          { eq: ['refreshTokenFamilies.userId', 'user-1'] },
        ],
      },
    });
  });

  it('classifies a zero-row conditional update with no owned row as not found', async () => {
    dbState.returningQueue.push([]);
    dbState.selectQueue.push([]);

    const outcome = await revokeUserSessionFamilyForLogout(
      makeTx(),
      'user-1',
      'family-owned-by-another-user',
      'logout',
    );

    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('throws instead of misclassifying an active row after a zero-row update', async () => {
    dbState.returningQueue.push([]);
    dbState.selectQueue.push([{ revokedAt: null }]);

    await expect(revokeUserSessionFamilyForLogout(
      makeTx(),
      'user-1',
      'family-1',
      'logout',
    )).rejects.toThrow('remained active');
  });

  it.each([
    ['epoch update', [new Error('user write failed'), null]],
    ['family update', [null, new Error('family write failed')]],
  ])('propagates a durable %s failure so the caller transaction can roll back', async (_label, failures) => {
    dbState.failureQueue.push(...failures);
    dbState.returningQueue.push([{
      id: 'user-1',
      authEpoch: 2,
      mfaEpoch: 1,
      emailEpoch: 1,
      passwordResetEpoch: 1,
    }]);
    const runTransaction = async () => {
      const updateCountBefore = dbState.updateCalls.length;
      const tx = makeTx();
      try {
        await advanceUserSecurityState(tx, 'user-1');
        await revokeAllUserSessionFamilies(tx, 'user-1', 'status-changed');
      } catch (error) {
        dbState.updateCalls.splice(updateCountBefore);
        throw error;
      }
    };

    await expect(runTransaction()).rejects.toThrow(/write failed/);
    expect(dbState.updateCalls).toEqual([]);
  });
});
