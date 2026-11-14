import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, updateMock, selectMock, transactionMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
    transaction: transactionMock,
  },
}));

import * as localVaultUpdate from './localVaultUpdate';
import { updateVaultWithinCurrentSite } from './localVaultUpdate';
import { UnsupportedLocalStoreTargetError } from './localStoreTargets';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const VAULT_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';

function writeChain(rows: unknown[]) {
  const chain: Record<string, any> = {};
  for (const method of ['values', 'set', 'where', 'returning']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  return chain;
}

// The service functions are looked up by name so this file fails as a test
// (not as a type error) while they do not exist.
type ServiceFn = (...args: any[]) => Promise<unknown>;
function service(name: string): ServiceFn {
  const fn = (localVaultUpdate as unknown as Record<string, ServiceFn | undefined>)[name];
  if (typeof fn !== 'function') throw new Error(`localVaultUpdate.${name} is not exported`);
  return fn;
}

const UNSUPPORTED_WRITES: Array<[string, Record<string, unknown>]> = [
  ['SMB share type', { vaultType: 'smb' }],
  ['UNC path', { vaultPath: '\\\\nas\\vault' }],
  ['extended UNC path', { vaultPath: '\\\\?\\UNC\\nas\\vault' }],
  ['forward-slash UNC path', { vaultType: 'usb', vaultPath: '//nas/vault' }],
];

describe('local vault writes refuse network share targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockImplementation(() => writeChain([{ id: VAULT_ID }]));
    updateMock.mockImplementation(() => writeChain([{ id: VAULT_ID }]));
    transactionMock.mockImplementation(async () => { throw new Error('transaction must not start'); });
  });

  it.each(UNSUPPORTED_WRITES)('create refuses a %s before writing', async (_label, target) => {
    await expect(service('createLocalVault')({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      vaultPath: 'D:\\Vault',
      vaultType: 'local',
      retentionCount: 3,
      ...target,
    })).rejects.toBeInstanceOf(UnsupportedLocalStoreTargetError);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it.each(UNSUPPORTED_WRITES)('site-scoped update refuses a %s before writing', async (_label, target) => {
    await expect(updateVaultWithinCurrentSite(ORG_ID, VAULT_ID, { updatedAt: new Date(), ...target }, undefined))
      .rejects.toBeInstanceOf(UnsupportedLocalStoreTargetError);
    await expect(updateVaultWithinCurrentSite(ORG_ID, VAULT_ID, { updatedAt: new Date(), ...target }, [SITE_ID]))
      .rejects.toBeInstanceOf(UnsupportedLocalStoreTargetError);
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it.each(UNSUPPORTED_WRITES)('device-bound update refuses a %s before writing', async (_label, target) => {
    await expect(service('updateVaultOnDevice')(ORG_ID, VAULT_ID, DEVICE_ID, { updatedAt: new Date(), ...target }))
      .rejects.toBeInstanceOf(UnsupportedLocalStoreTargetError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('creates an attached-disk vault', async () => {
    const row = await service('createLocalVault')({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      vaultPath: 'E:\\Vault',
      vaultType: 'usb',
      retentionCount: 3,
    });
    expect(row).toEqual({ id: VAULT_ID });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  // A saved vault on a share can still be deactivated or have its retention
  // changed; only writes that set an unsupported type or path are refused.
  it('still deactivates a saved vault without naming its target', async () => {
    const row = await updateVaultWithinCurrentSite(ORG_ID, VAULT_ID, { isActive: false, updatedAt: new Date() }, undefined);
    expect(row).toEqual({ id: VAULT_ID });
    expect(updateMock).toHaveBeenCalledTimes(1);

    updateMock.mockClear();
    const bound = await service('updateVaultOnDevice')(ORG_ID, VAULT_ID, DEVICE_ID, { retentionCount: 4, updatedAt: new Date() });
    expect(bound).toEqual({ id: VAULT_ID });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
