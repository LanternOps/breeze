import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./deviceDeletion', () => ({ deleteDeviceCascade: vi.fn(async () => undefined) }));
vi.mock('./deviceLinkGroups', () => ({ dissolveLinkGroupIfBelowMinimum: vi.fn(async () => true) }));
vi.mock('./deviceUninstallDrain', async (orig) => {
  const actual = await orig<typeof import('./deviceUninstallDrain')>();
  return {
    ...actual,
    releaseDeviceRemoveReason: vi.fn(async () => ({
      cancelled: 1,
      retainedOtherOwner: 0,
      alreadyDispatched: 0,
    })),
  };
});

import {
  restoreRemovedDevice,
  purgeRemovedDevice,
  DeviceLifecycleError,
  DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS,
} from './deviceLifecycle';
import { deleteDeviceCascade } from './deviceDeletion';
import { dissolveLinkGroupIfBelowMinimum } from './deviceLinkGroups';
import { releaseDeviceRemoveReason } from './deviceUninstallDrain';

const DEV = '11111111-1111-4111-8111-111111111111';

interface Script {
  lockRow?: Record<string, unknown> | null;
  pendingUninstall?: boolean;
  updatedRow?: Record<string, unknown>;
}

/**
 * Minimal tx double: records the ORDER of statements and serves scripted rows.
 *
 * Statement classification is on the compiled sql`` text (JSON-serialised
 * chunks), not on call index, so inserting a statement can't silently shift
 * which scripted row a later statement receives.
 */
function makeTx(script: Script) {
  const calls: string[] = [];
  const statements: string[] = [];
  const setPayloads: Array<Record<string, unknown>> = [];
  const tx = {
    execute: vi.fn(async (q: unknown) => {
      const text = JSON.stringify(q);
      statements.push(text);
      if (text.includes('pg_settings')) {
        calls.push('tighten-lock-timeout');
        return [{ prior_ms: '0' }];
      }
      if (text.includes('FOR UPDATE')) {
        calls.push('lock');
        return script.lockRow ? [script.lockRow] : [];
      }
      if (text.includes('self_uninstall')) {
        calls.push('pending-check');
        return script.pendingUninstall ? [{ id: 'cmd' }] : [];
      }
      if (text.includes('set_config')) {
        calls.push('restore-lock-timeout');
        return [];
      }
      calls.push('execute');
      return [];
    }),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        setPayloads.push(values);
        return {
          where: () => ({
            returning: async () => {
              calls.push('update');
              return [script.updatedRow ?? { id: DEV, status: 'offline' }];
            },
          }),
        };
      },
    })),
    select: vi.fn(),
  };
  return { tx: tx as never, calls, statements, setPayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(releaseDeviceRemoveReason).mockResolvedValue({
    cancelled: 1,
    retainedOtherOwner: 0,
    alreadyDispatched: 0,
  });
  vi.mocked(dissolveLinkGroupIfBelowMinimum).mockResolvedValue(true);
  vi.mocked(deleteDeviceCascade).mockResolvedValue(undefined);
});

describe('restoreRemovedDevice', () => {
  it('locks the devices row BEFORE releasing the uninstall reason (lock order)', async () => {
    const { tx, calls } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });
    vi.mocked(releaseDeviceRemoveReason).mockImplementation(async () => {
      calls.push('release');
      return { cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 };
    });
    await restoreRemovedDevice(tx, DEV);
    // Guard every operand against -1 before comparing indices: a missing
    // statement indexes to -1, which compares "less than" everything and would
    // let the ordering assertions pass vacuously.
    for (const step of ['lock', 'release', 'update']) {
      expect(calls.indexOf(step), `${step} was never recorded`).toBeGreaterThanOrEqual(0);
    }
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('release'));
    expect(calls.indexOf('release')).toBeLessThan(calls.indexOf('update'));
  });

  it('bounds the wait for the devices row lock instead of blocking forever', async () => {
    const { tx, calls, statements } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });
    await restoreRemovedDevice(tx, DEV);
    // Both statements must actually have been issued. Without this, dropping
    // tightenLockTimeout entirely would make indexOf return -1, which is
    // "less than" the lock's index — the ordering assertion below would pass
    // against code that never bounds the wait at all.
    expect(calls.indexOf('tighten-lock-timeout')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('lock')).toBeGreaterThanOrEqual(0);
    // The bound has to be applied BEFORE the lock is attempted, or a delete
    // racing a long-running site move / moveOrg pins a pooled connection for
    // as long as the other writer holds the row (same reasoning as
    // deviceDeletion.ts's own tightenLockTimeout).
    expect(calls.indexOf('tighten-lock-timeout')).toBeLessThan(calls.indexOf('lock'));
    expect(statements.some((s) => s.includes(String(DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS)))).toBe(true);
  });

  it('throws NOT_FOUND when the lock returns no row', async () => {
    const { tx } = makeTx({ lockRow: null });
    await expect(restoreRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('throws NOT_REMOVED when the locked row is no longer decommissioned', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'online' } });
    await expect(restoreRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'NOT_REMOVED',
      status: 409,
    });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
  });

  // #2787 item 4 — Restore is the ONLY way a device leaves 'decommissioned',
  // so it is the only place `decommissioned_at` can be cleared. Leaving the
  // stamp behind on a restored device would make the retention job eligible to
  // permanently delete a device the operator deliberately brought back.
  it('clears decommissioned_at in the same write that flips the status back', async () => {
    const { tx, setPayloads } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });

    await restoreRemovedDevice(tx, DEV);

    expect(setPayloads).toHaveLength(1);
    expect(setPayloads[0]).toEqual({
      status: 'offline',
      decommissionedAt: null,
      updatedAt: expect.any(Date),
    });
  });

  it('reports uninstallAlreadyDispatched from the release result', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 0,
      retainedOtherOwner: 0,
      alreadyDispatched: 1,
    });
    const r = await restoreRemovedDevice(tx, DEV);
    expect(r.uninstallAlreadyDispatched).toBe(true);
    expect(r.device).toMatchObject({ id: DEV, status: 'offline' });
  });
});

describe('purgeRemovedDevice', () => {
  it('re-checks status under the lock and refuses a device that was restored concurrently', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'offline', link_group_id: null } });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'NOT_REMOVED' });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the lock returns no row', async () => {
    const { tx } = makeTx({ lockRow: null });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('refuses while a device_remove uninstall is still pending', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      pendingUninstall: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'UNINSTALL_PENDING',
      status: 409,
    });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('checks for the pending uninstall only AFTER the devices row is locked', async () => {
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      pendingUninstall: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });
    expect(calls.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('pending-check')).toBeGreaterThanOrEqual(0);
    // Lock order is non-negotiable: devices FIRST, device_commands second.
    // The inverse order against a concurrent Remove (which locks devices then
    // writes device_commands) is a textbook AB-BA deadlock (40P01).
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('pending-check'));
  });

  it('cascades and dissolves the link group when eligible', async () => {
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: 'lg-1' },
    });
    const r = await purgeRemovedDevice(tx, DEV);
    expect(deleteDeviceCascade).toHaveBeenCalledWith(tx, DEV);
    expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledWith(tx, 'lg-1');
    expect(r.linkGroupDissolved).toBe(true);
    expect(calls.filter((c) => c !== 'tighten-lock-timeout')[0]).toBe('lock');
  });

  it('does not touch link groups when the purged device was unlinked', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
    });
    const r = await purgeRemovedDevice(tx, DEV);
    expect(dissolveLinkGroupIfBelowMinimum).not.toHaveBeenCalled();
    expect(r.linkGroupDissolved).toBe(false);
  });
});

describe('DeviceLifecycleError', () => {
  it('maps NOT_FOUND to 404 and every other code to 409', () => {
    expect(new DeviceLifecycleError('NOT_FOUND', 'x').status).toBe(404);
    expect(new DeviceLifecycleError('NOT_REMOVED', 'x').status).toBe(409);
    expect(new DeviceLifecycleError('UNINSTALL_PENDING', 'x').status).toBe(409);
  });
});
