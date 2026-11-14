import { describe, expect, it, vi } from 'vitest';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';

// The production dependencies of the terminal-logout service, run against a
// recording transaction: only the transition lock and token helpers are stubbed.
const USER = '11111111-1111-4111-8111-111111111111';
const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const state = vi.hoisted(() => ({ writes: [] as Array<{ table: unknown; values: Record<string, unknown> }> }));

function recordingTx() {
  const lockedRows = (table: unknown) => (table === users
    ? [{ id: USER, status: 'active', authEpoch: 4, mfaEpoch: 9 }]
    : table === refreshTokenFamilies
      ? [{ familyId: FAMILY, userId: USER, revokedAt: null, absoluteExpiresAt: new Date('2099-01-01'), currentRefreshJtiDigest: null }]
      : []);
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({ for: async () => lockedRows(table) }),
        }),
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        state.writes.push({ table, values });
        return {
          where: () => {
            const result: any = Promise.resolve(undefined);
            result.returning = async () => [{ authEpoch: 5, mfaEpoch: 9, emailEpoch: 1, passwordResetEpoch: 1, credentialEpoch: 1 }];
            return result;
          },
        };
      },
    })),
  };
}

vi.mock('./authBrowserTransition', () => ({
  withTerminalLogoutTransition: vi.fn(async (_binding: unknown, callback: (mutation: unknown) => Promise<unknown>) =>
    callback({
      tx: recordingTx(),
      transition: {
        id: 'transition-1', generation: 1, state: 'active',
        currentUserId: USER, currentFamilyId: FAMILY, databaseNow: new Date('2030-01-01'),
      },
      retireWithSuccessor: async () => ({ kind: 'browser', value: 'successor' }),
      markLogoutPending: async () => ({ transitionId: 'transition-1', logoutId: 'logout-1', generation: 2 }),
    })),
  completeTerminalLogout: vi.fn(),
  isTerminalLogoutPending: vi.fn(),
}));
vi.mock('./refreshTokenFamily', () => ({
  classifyRefreshTokenAuthority: vi.fn(async () => ({ kind: 'invalid' })),
}));
vi.mock('./jwt', () => ({ verifyToken: vi.fn(async () => null) }));
vi.mock('./tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn(async () => undefined),
  revokeRefreshTokenJti: vi.fn(async () => undefined),
}));

import { performOrdinaryTerminalLogout } from './terminalLogout';

describe('terminal logout (production dependencies)', () => {
  it('signs the user out everywhere and cancels a pending email-address change', async () => {
    state.writes.length = 0;

    await performOrdinaryTerminalLogout({
      binding: { kind: 'browser', value: 'binding' } as any,
      access: { userId: USER, authEpoch: 4, mfaEpoch: 9, familyId: FAMILY },
      refreshToken: null,
    });

    const userWrites = state.writes.filter((w) => w.table === users).map((w) => w.values);
    expect(userWrites.some((values) => 'authEpoch' in values)).toBe(true);
    expect(userWrites).toContainEqual(expect.objectContaining({ pendingEmail: null, pendingEmailRequestedAt: null }));
    expect(state.writes.some((w) => w.table === refreshTokenFamilies && 'revokedReason' in w.values)).toBe(true);
  });
});
