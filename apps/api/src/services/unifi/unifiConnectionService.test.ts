import { describe, it, expect, vi } from 'vitest';
import * as svc from './unifiConnectionService';

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
});
