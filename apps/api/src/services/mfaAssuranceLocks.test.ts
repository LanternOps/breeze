import { describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...clauses: unknown[]) => clauses),
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
  isNull: vi.fn((column: unknown) => column),
}));

vi.mock('../db/schema', () => ({
  users: { id: 'users.id' },
  userPasskeys: {
    id: 'userPasskeys.id',
    userId: 'userPasskeys.userId',
    disabledAt: 'userPasskeys.disabledAt',
  },
}));

const events = vi.hoisted(() => [] as string[]);
vi.mock('./mfaPolicy', () => ({
  lockMfaPolicyPartner: vi.fn(async () => { events.push('partner-policy'); }),
}));

import { lockMfaAssuranceState } from './mfaAssuranceLocks';
import type { AuthLifecycleTransaction } from './authLifecycle';

describe('MFA assurance mutation lock contract', () => {
  it('locks partner policy, user, then factor rows in the mandatory shared order', async () => {
    events.length = 0;
    let selectCount = 0;
    const tx = {
      select: vi.fn(() => {
        selectCount += 1;
        const currentSelect = selectCount;
        return {
        from: vi.fn(() => {
          const query: Record<string, unknown> = {};
          query.where = vi.fn(() => query);
          query.for = vi.fn(() => {
            events.push(currentSelect === 1 ? 'user-row' : 'factor-rows');
            return query;
          });
          query.limit = vi.fn(async () => currentSelect === 1 ? [{ id: 'user-1' }] : [{ id: 'passkey-1' }]);
          return query;
        }),
      }; }),
    } as unknown as AuthLifecycleTransaction;

    await lockMfaAssuranceState(tx, { partnerId: 'partner-1', userId: 'user-1' });

    expect(events).toEqual(['partner-policy', 'user-row', 'factor-rows']);
  });
});
