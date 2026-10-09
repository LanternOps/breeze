import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.value }) }) }),
  },
}));

import { restoreTargetRefusal } from './restoreTargetReadiness';
import { RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE } from './backupRestoreGate';

beforeEach(() => {
  rows.value = [];
});

describe('restoreTargetRefusal', () => {
  it('refuses an offline device with the same message the enqueue path uses', async () => {
    rows.value = [{ status: 'offline', backupIntegrityProtocolVersion: 2 }];
    expect(await restoreTargetRefusal('d1', 'backup_restore')).toEqual({
      code: 'device_offline',
      message: 'Device is offline, cannot execute command',
    });
  });

  it('refuses a helper that does not check attestations', async () => {
    rows.value = [{ status: 'online', backupIntegrityProtocolVersion: 1 }];
    expect(await restoreTargetRefusal('d1', 'mssql_restore')).toEqual({
      code: 'backup_helper_update_required',
      message: RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE,
    });
  });

  it('refuses a device it cannot see', async () => {
    expect(await restoreTargetRefusal('d1', 'backup_restore')).toMatchObject({ code: 'device_not_found' });
  });

  it('accepts an online device that checks attestations, or has not reported yet (delivery waits)', async () => {
    rows.value = [{ status: 'online', backupIntegrityProtocolVersion: 2 }];
    expect(await restoreTargetRefusal('d1', 'backup_restore')).toBeNull();
    rows.value = [{ status: 'online', backupIntegrityProtocolVersion: null }];
    expect(await restoreTargetRefusal('d1', 'backup_restore')).toBeNull();
  });
});
