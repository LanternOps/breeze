import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as svc from './unifiConnectionService';

vi.mock('../secretCrypto', () => ({
  encryptSecret: vi.fn(() => 'enc-key'),
  decryptForColumn: vi.fn(() => null),
}));

// Minimal chainable db mock: each method returns an object exposing the next
function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => overrides.selectRows ?? [] }) }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiConnectionService', () => {
  it('markStatus throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'error', 'boom'))
      .rejects.toThrow(/no unifi_integrations row/i);
  });

  it('markStatus succeeds when a row is returned', async () => {
    const db = makeDb({ updateRows: [{ id: 'conn-1' }] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'connected')).resolves.toBeUndefined();
  });

  it('getDecryptedApiKey returns null when no connection', async () => {
    const db = makeDb({ selectRows: [] });
    await expect(svc.getDecryptedApiKey(db, 'partner-x')).resolves.toBeNull();
  });

  it('markSynced throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markSynced(db, 'conn-1', 'partner-1', 'success'))
      .rejects.toThrow(/no unifi_integrations row/i);
  });

  it('deleteConnection returns false on 0 rows (idempotent) and true when a row is deleted', async () => {
    await expect(svc.deleteConnection(makeDb({ deleteRows: [] }), 'partner-1')).resolves.toBe(false);
    await expect(svc.deleteConnection(makeDb({ deleteRows: [{ id: 'conn-1' }] }), 'partner-1')).resolves.toBe(true);
  });
});

describe('upsertConnection (cloud path)', () => {
  function spyDb(returning: any[]) {
    const onConflictDoUpdate = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returning),
    });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    return { db: { insert } as unknown as svc.DbExecutor, onConflictDoUpdate };
  }

  it('onConflictDoUpdate set block includes connectionType: cloud', async () => {
    const row = {
      id: 'int-1', partnerId: 'partner-1', connectionType: 'cloud',
      baseUrl: 'https://api.ui.com', accountLabel: null,
      isActive: true, status: 'connected',
      lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
    };
    const { db, onConflictDoUpdate } = spyDb([row]);
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'k' });
    const arg = onConflictDoUpdate.mock.calls[0]![0] as { set: Record<string, unknown> };
    expect(arg.set.connectionType).toBe('cloud');
  });
});
