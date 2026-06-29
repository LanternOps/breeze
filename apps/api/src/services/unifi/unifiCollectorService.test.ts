import { describe, it, expect, vi } from 'vitest';
import * as svc from './unifiCollectorService';

vi.mock('../secretCrypto', () => ({
  encryptSecret: vi.fn(() => 'ENC'),
  decryptForColumn: vi.fn(() => 'PLAINTEXT-KEY'),
}));

function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => overrides.selectRows ?? [] }) })),
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiCollectorService', () => {
  it('markCollectorPoll throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markCollectorPoll(db, 'c1', 'error', false, 'boom'))
      .rejects.toThrow(/no unifi_collectors row/i);
  });

  it('listCollectorsForDevice decrypts the key into AgentCollectorConfig', async () => {
    const db = makeDb({ selectRows: [{
      id: 'c1',
      unifiHostId: 'h1',
      controllerUrl: 'https://10.0.0.1',
      localApiKeyEncrypted: 'ENC',
      pollIntervalSeconds: 60,
    }] });
    const out = await svc.listCollectorsForDevice(db, 'dev-1');
    expect(out).toEqual([{
      collectorId: 'c1',
      unifiHostId: 'h1',
      controllerUrl: 'https://10.0.0.1',
      apiKey: 'PLAINTEXT-KEY',
      pollIntervalSeconds: 60,
    }]);
  });

  it('deleteCollector returns false when no row deleted', async () => {
    const db = makeDb({ deleteRows: [] });
    await expect(svc.deleteCollector(db, 'int-1', 'h1')).resolves.toBe(false);
  });

  it('getCollectorOwnerDeviceId returns the owning device id, or null when unknown', async () => {
    const dbWith = (rows: any[]) => ({
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => rows }) }) })),
    } as unknown as svc.DbExecutor);
    await expect(svc.getCollectorOwnerDeviceId(dbWith([{ collectorDeviceId: 'dev-7' }]), 'c1')).resolves.toBe('dev-7');
    await expect(svc.getCollectorOwnerDeviceId(dbWith([]), 'c1')).resolves.toBeNull();
  });
});
