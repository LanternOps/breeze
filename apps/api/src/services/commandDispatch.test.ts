import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    status: 'deviceCommands.status',
    type: 'deviceCommands.type',
    targetRole: 'deviceCommands.targetRole',
    createdAt: 'deviceCommands.createdAt',
    executedAt: 'deviceCommands.executedAt',
  },
}));

// Spy on inArray (pass-through to the real implementation) so the #2774
// drain-mode type filter is assertable without mocking all of drizzle.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, inArray: vi.fn((...args: Parameters<typeof actual.inArray>) => actual.inArray(...args)) };
});

import { inArray } from 'drizzle-orm';

import { db } from '../db';
import {
  claimPendingCommandForDelivery,
  claimPendingCommandsForDevice,
  releaseClaimedCommandDelivery,
} from './commandDispatch';

describe('command dispatch helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('claims a pending command for delivery only when the conditional update succeeds', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }]),
        }),
      }),
    } as any);

    const result = await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

    expect(result).toEqual({
      id: 'cmd-1',
      executedAt: new Date('2026-03-31T00:00:00Z'),
    });
  });

  it('returns only commands that were successfully claimed from pending state', async () => {
    const returning = vi.fn()
      .mockResolvedValueOnce([{ id: 'cmd-1', deviceId: 'dev-1', status: 'sent', createdAt: new Date('2026-03-31T00:00:00Z') }])
      .mockResolvedValueOnce([]);

    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([
                  { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') },
                  { id: 'cmd-2', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:01Z') },
                ]),
              }),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning,
          }),
        }),
      }),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice('dev-1', 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe('cmd-1');
    // No drain allowlist → no type filter applied.
    expect(vi.mocked(inArray)).not.toHaveBeenCalledWith('deviceCommands.type', expect.anything());
  });

  // #2774 — during an offboarding drain the claim narrows to self_uninstall.
  it('applies the type allowlist to the claim query when provided', async () => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice('dev-1', 10, 'agent', ['self_uninstall']);

    expect(claimed).toEqual([]);
    expect(vi.mocked(inArray)).toHaveBeenCalledWith('deviceCommands.type', ['self_uninstall']);
  });

  it('releases a claimed command back to pending state', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where,
      }),
    } as any);

    await releaseClaimedCommandDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

    expect(where).toHaveBeenCalledTimes(1);
  });
});
