import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  deviceRecoveryKeys: {
    id: 'deviceRecoveryKeys.id',
    deviceId: 'deviceRecoveryKeys.deviceId',
    orgId: 'deviceRecoveryKeys.orgId',
    keyType: 'deviceRecoveryKeys.keyType',
    volumeMount: 'deviceRecoveryKeys.volumeMount',
    protectorId: 'deviceRecoveryKeys.protectorId',
    encryptedKey: 'deviceRecoveryKeys.encryptedKey',
    keyFingerprint: 'deviceRecoveryKeys.keyFingerprint',
    status: 'deviceRecoveryKeys.status',
    supersededAt: 'deviceRecoveryKeys.supersededAt',
    updatedAt: 'deviceRecoveryKeys.updatedAt',
  },
}));

vi.mock('./encryptedColumnRegistry', () => ({
  encryptColumnValueForWrite: vi.fn((_t: string, _c: string, v: string) => `enc:${v}`),
}));

import { db } from '../db';
import { escrowRecoveryKeys, fingerprintRecoveryKey } from './recoveryKeyEscrow';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function mockActiveRows(rows: unknown[]) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  });
}

function mockInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values });
  return values;
}

function mockUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set });
  return { set, where };
}

const KEY = '111111-222222-333333-444444-555555-666666-777777-888888';

describe('fingerprintRecoveryKey', () => {
  it('is a stable 64-char sha256 hex', () => {
    const fp = fingerprintRecoveryKey(KEY);
    expect(fp).toHaveLength(64);
    expect(fp).toBe(fingerprintRecoveryKey(KEY));
    expect(fp).not.toBe(fingerprintRecoveryKey(`${KEY}x`));
  });
});

describe('escrowRecoveryKeys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a brand-new key encrypted, never plaintext', async () => {
    mockActiveRows([]);
    const values = mockInsert();
    mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', protectorId: 'p-1', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 1, superseded: 0, unchanged: 0 });
    const row = values.mock.calls[0][0];
    expect(row.encryptedKey).toBe(`enc:${KEY}`);
    expect(row.keyFingerprint).toBe(fingerprintRecoveryKey(KEY));
    expect(JSON.stringify(row)).not.toContain(`"${KEY}"`);
  });

  it('no-ops when the active row has the same fingerprint', async () => {
    mockActiveRows([{
      id: 'row-1', keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      keyFingerprint: fingerprintRecoveryKey(KEY), status: 'active',
    }]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 0, superseded: 0, unchanged: 1 });
    expect(values).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('supersedes and re-inserts when the fingerprint changed', async () => {
    mockActiveRows([{
      id: 'row-1', keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      keyFingerprint: 'old-fingerprint', status: 'active',
    }]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 1, superseded: 1, unchanged: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('snapshot supersedes active bitlocker rows absent from the snapshot', async () => {
    mockActiveRows([{
      id: 'row-gone', keyType: 'bitlocker_recovery_password', volumeMount: 'D:',
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', []);
    expect(stats).toEqual({ inserted: 0, superseded: 1, unchanged: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
  });

  it('snapshot does NOT supersede filevault rows absent from the snapshot', async () => {
    mockActiveRows([{
      id: 'row-fv', keyType: 'filevault_personal_recovery_key', volumeMount: null,
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', []);
    expect(stats).toEqual({ inserted: 0, superseded: 0, unchanged: 0 });
    expect(set).not.toHaveBeenCalled();
  });

  it('rotation source never snapshot-supersedes absent rows', async () => {
    mockActiveRows([{
      id: 'row-other', keyType: 'bitlocker_recovery_password', volumeMount: 'D:',
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'rotation', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);
    expect(stats.inserted).toBe(1);
    expect(stats.superseded).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });
});
