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
  peripheralPolicyDeviceStates: {
    deviceId: 'peripheralPolicyDeviceStates.deviceId',
    deliveryStatus: 'peripheralPolicyDeviceStates.deliveryStatus',
  },
}));

// Spy on inArray (pass-through to the real implementation) so the #2774
// drain-mode type filter is assertable without mocking all of drizzle.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn((...args: Parameters<typeof actual.inArray>) => actual.inArray(...args)),
    notInArray: vi.fn((...args: Parameters<typeof actual.notInArray>) => actual.notInArray(...args)),
  };
});

import { inArray, notInArray } from 'drizzle-orm';

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

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

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

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', ['self_uninstall'], { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toEqual([]);
    expect(vi.mocked(inArray)).toHaveBeenCalledWith('deviceCommands.type', ['self_uninstall']);
  });

  it('does not mutate unrelated protocol work during a self-uninstall-only claim', async () => {
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

    const claimed = await claimPendingCommandsForDevice(
      'dev-1',
      10,
      'agent',
      ['self_uninstall'],
    );

    expect(claimed).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('cancels queued peripheral v2 work when the claiming heartbeat omits capability 2', async () => {
    const cancelWhere = vi.fn().mockResolvedValue(undefined);
    const rejectWhere = vi.fn().mockResolvedValue(undefined);
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
      update: vi.fn()
        .mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: cancelWhere }) })
        .mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: rejectWhere }) }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1',
      10,
      'agent',
      undefined,
      { peripheralPolicyProtocolVersion: 0 },
    );

    expect(claimed).toEqual([]);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(cancelWhere).toHaveBeenCalledTimes(1);
    expect(rejectWhere).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['peripheral_policy_sync_v2', 'agent_rollback_v1', 'pam_apply_v2', 'pam_cleanup_v2'],
    );
  });

  it('withholds rollback when this heartbeat does not report protocol v1', async () => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
      }),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', undefined, {
      peripheralPolicyProtocolVersion: 2,
      rollbackProtocolVersion: 0,
      pamLifetimeProtocolVersion: 2,
    });

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['agent_rollback_v1'],
    );
  });

  it('withholds PAM lifetime commands when this heartbeat does not report protocol v2', async () => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
      }),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', undefined, {
      peripheralPolicyProtocolVersion: 2,
      rollbackProtocolVersion: 1,
      pamLifetimeProtocolVersion: 0,
    });

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['pam_apply_v2', 'pam_cleanup_v2'],
    );
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
