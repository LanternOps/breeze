import { describe, expect, it, vi } from 'vitest';
import { insertQueuedCommandInTransaction } from './commandQueueInsert';
import { ParkedDeviceCommandRefusedError } from './unassignedPool/deliveryEligibility';

/** A transaction whose eligibility resolver answers `parked` and whose insert echoes the row. */
function fakeTx(orgType: string) {
  const execute = vi.fn().mockResolvedValue([{ parked: orgType === 'unassigned_pool' }]);
  const returning = vi.fn(async () => [{ id: 'cmd-1', status: 'pending' }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { tx: { execute, insert } as never, insert, values };
}

const base = { id: 'cmd-1', deviceId: 'device-1', payload: {}, createdBy: null } as const;

describe('insertQueuedCommandInTransaction', () => {
  it('refuses a non-removal command for a parked device and writes nothing', async () => {
    const { tx, insert } = fakeTx('unassigned_pool');
    await expect(
      insertQueuedCommandInTransaction(tx, { ...base, type: 'script' }),
    ).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
    expect(insert).not.toHaveBeenCalled();
  });

  it('persists lifecycle removal for a parked device', async () => {
    const { tx, values } = fakeTx('unassigned_pool');
    await expect(
      insertQueuedCommandInTransaction(tx, { ...base, type: 'self_uninstall' }),
    ).resolves.toMatchObject({ id: 'cmd-1' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ type: 'self_uninstall' }));
  });

  it('persists any command for a device in an ordinary org', async () => {
    const { tx, values } = fakeTx('customer');
    await insertQueuedCommandInTransaction(tx, { ...base, type: 'script' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ type: 'script', deviceId: 'device-1' }));
  });
});
