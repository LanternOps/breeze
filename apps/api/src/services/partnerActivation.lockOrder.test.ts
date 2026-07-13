import { beforeEach, describe, expect, it, vi } from 'vitest';
import { devices, partners } from '../db/schema';

const state = vi.hoisted(() => ({
  events: [] as string[],
  status: 'pending',
}));

vi.mock('./partnerLifecycleLock', () => ({
  lockPartnerLifecycleRows: vi.fn(async () => {
    state.events.push('lock:lifecycle');
    return {
      orgIds: [],
      userIds: [],
      userRows: [],
      partner: {
        id: 'partner-1',
        status: state.status,
        emailVerifiedAt: new Date(),
        paymentMethodAttachedAt: new Date(),
      },
    };
  }),
  invalidateLockedPartnerUsersInTransaction: vi.fn(async () => {
    state.events.push('invalidate:users');
    return [];
  }),
}));

import {
  activatePendingPartnerAndInvalidateSessions,
  restoreSuspendedPartnerInTransaction,
  suspendPartnerForAbuseInTransaction,
} from './partnerActivation';

function makeTx() {
  return {
    update: vi.fn((table: unknown) => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn(() => {
          if (table === partners) state.events.push('write:partner');
          const result = Promise.resolve(undefined) as Promise<void> & {
            returning: () => Promise<Array<{ id: string }>>;
          };
          result.returning = async () => table === partners ? [{ id: 'partner-1' }] : [];
          return result;
        }),
      }),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn((table: unknown) => {
        if (table !== devices) throw new Error('unexpected select');
        return {
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      }),
    }),
    insert: vi.fn(),
    delete: vi.fn(),
  } as any;
}

describe('partner lifecycle caller lock order', () => {
  beforeEach(() => {
    state.events.length = 0;
    state.status = 'pending';
  });

  it('activation acquires the shared lifecycle locks before the partner write', async () => {
    await activatePendingPartnerAndInvalidateSessions(makeTx(), 'partner-1');
    expect(state.events.slice(0, 2)).toEqual(['lock:lifecycle', 'write:partner']);
  });

  it('restore acquires the shared lifecycle locks before the partner write', async () => {
    state.status = 'suspended';
    await restoreSuspendedPartnerInTransaction(makeTx(), 'partner-1');
    expect(state.events.slice(0, 2)).toEqual(['lock:lifecycle', 'write:partner']);
  });

  it('abuse suspension acquires the shared lifecycle locks before the partner write', async () => {
    await suspendPartnerForAbuseInTransaction(
      makeTx(),
      'partner-1',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(state.events.slice(0, 2)).toEqual(['lock:lifecycle', 'write:partner']);
  });
});
