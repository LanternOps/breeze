import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9719 — the bulk cancel paths (tenant offboarding, abuse suspension, device
 * uninstall drain) flipped device_commands to `cancelled` with a bare UPDATE, so
 * the records owning those commands never heard about it. `cancelDeviceCommands`
 * is the one place that does the UPDATE and then runs the per-type hooks.
 */

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {} as Record<string, unknown>,
  getCurrentDbAccessContext: () => undefined,
  runAfterDbContextExit: vi.fn(),
}));
vi.mock('../db/schema', () => ({
  deploymentResults: {},
  deviceFilesystemCleanupRuns: {},
  deviceCommands: { id: 'dc.id', type: 'dc.type', payload: 'dc.payload' },
}));
vi.mock('./sensitiveCommandPayload', () => ({ terminalPayloadErasureSet: () => ({ payload: null }) }));
vi.mock('./scriptExecutionTerminal', () => ({
  finalizeScriptExecutionTerminal: vi.fn(),
  batchIdFromPayload: () => null,
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: (...a: unknown[]) => captureExceptionMock(...(a as [])) }));

import { cancelDeviceCommands } from './commandCancelPropagation';
import { db } from '../db';

type Returned = Array<{ id: string; type: string; payload: Record<string, unknown> | null }>;

// `returned` is the PRE-update read (type + payload). The UPDATE's RETURNING
// reflects post-erasure values, so it carries no payload — as in Postgres.
function fakeExecutor(returned: Returned) {
  const sets: Array<Record<string, unknown>> = [];
  const handle = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => returned }) }) }),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        sets.push(vals);
        return {
          where: () => ({
            returning: async () => returned.map(({ id, type }) => ({ id, type })),
          }),
        };
      },
    }),
  };
  return { sets, handle: handle as never };
}

describe('cancelDeviceCommands (#9719)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates then runs the per-type hook for every cancelled row, in the caller executor', async () => {
    const { sets, handle } = fakeExecutor([
      { id: 'c1', type: 'script', payload: { executionId: 'e1' } },
      { id: 'c2', type: 'install_patches', payload: null },
    ]);
    const propagate = vi.fn(async () => undefined);
    const rows = await cancelDeviceCommands({
      where: {} as never,
      result: { reason: 'tenant_offboarding' },
      executor: handle,
      propagate,
    });

    expect(sets[0]).toMatchObject({
      status: 'cancelled',
      result: { reason: 'tenant_offboarding' },
      payload: null, // terminalPayloadErasureSet()
    });
    expect(rows.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(propagate).toHaveBeenCalledTimes(2);
    // The hook gets the PRE-erasure payload (it keys on executionId).
    expect(propagate).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'c1',
        type: 'script',
        payload: { executionId: 'e1' },
        executor: handle,
      }),
    );
    expect(propagate).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'c2', type: 'install_patches', executor: handle }));
  });

  it('runs no hooks when the UPDATE flipped nothing', async () => {
    const { handle } = fakeExecutor([]);
    const propagate = vi.fn();
    expect(await cancelDeviceCommands({ where: {} as never, result: {}, executor: handle, propagate })).toEqual([]);
    expect(propagate).not.toHaveBeenCalled();
  });

  it('on the ambient pool, a failing hook is logged with the command id and does not stop the rest', async () => {
    const returned: Returned = [
      { id: 'c1', type: 'script', payload: null },
      { id: 'c2', type: 'script', payload: null },
    ];
    (db as unknown as Record<string, unknown>).select = () => ({
      from: () => ({ where: () => ({ for: async () => returned }) }),
    });
    (db as unknown as Record<string, unknown>).update = () => ({
      set: () => ({ where: () => ({ returning: async () => returned.map(({ id, type }) => ({ id, type })) }) }),
    });
    const propagate = vi.fn(async (p: { commandId: string }) => {
      if (p.commandId === 'c1') throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cancelDeviceCommands({ where: {} as never, result: {}, propagate });

    expect(propagate).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('cancelDeviceCommands'),
      expect.objectContaining({ commandId: 'c1' }),
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('inside a caller transaction a hook failure propagates so the cancel rolls back', async () => {
    const { handle } = fakeExecutor([{ id: 'c1', type: 'script', payload: null }]);
    const propagate = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      cancelDeviceCommands({ where: {} as never, result: {}, executor: handle, propagate }),
    ).rejects.toThrow('boom');
  });
});
