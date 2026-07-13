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
    createdAt: 'deviceCommands.createdAt',
    executedAt: 'deviceCommands.executedAt',
  },
}));

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
  });

  // Regression for #2399: the agent WS path delivers the claimed batch in a
  // single frame that must stay under the agent's 16MB read limit (exceeding
  // it kills the connection), so the claim loop honors a cumulative payload
  // budget — over-budget commands stay pending for a later delivery cycle.
  it('stops claiming once the payload budget is exhausted, leaving the rest pending', async () => {
    const bigPayload = { content: 'x'.repeat(1000) };
    const pending = [
      { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', payload: bigPayload, createdAt: new Date('2026-03-31T00:00:00Z') },
      { id: 'cmd-2', deviceId: 'dev-1', status: 'pending', payload: bigPayload, createdAt: new Date('2026-03-31T00:00:01Z') },
      { id: 'cmd-3', deviceId: 'dev-1', status: 'pending', payload: bigPayload, createdAt: new Date('2026-03-31T00:00:02Z') },
    ];
    const returning = vi.fn().mockImplementation(async () => [pending[returning.mock.calls.length - 1]]);

    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue(pending),
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

    // Each payload serializes to a bit over 1000 bytes; a 2500-byte budget
    // fits two commands but not three.
    const claimed = await claimPendingCommandsForDevice('dev-1', 10, 'agent', {
      maxTotalPayloadBytes: 2500,
    });

    expect(claimed.map((c: any) => c.id)).toEqual(['cmd-1', 'cmd-2']);
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it('always claims the first command even when it alone exceeds the payload budget', async () => {
    const huge = { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', payload: { content: 'x'.repeat(5000) }, createdAt: new Date('2026-03-31T00:00:00Z') };
    const returning = vi.fn().mockResolvedValue([huge]);

    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([huge]),
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

    const claimed = await claimPendingCommandsForDevice('dev-1', 10, 'agent', {
      maxTotalPayloadBytes: 100,
    });

    expect(claimed.map((c: any) => c.id)).toEqual(['cmd-1']);
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
