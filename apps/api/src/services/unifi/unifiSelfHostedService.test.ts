import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));

import { createSelfHostedIntegration } from './unifiConnectionService';

function mockDb(returning: any[]) {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(returning),
        }),
      }),
    }),
    // Key rows of the connection are dropped in the same transaction (#11808).
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  };
  return { db: { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } as any, tx };
}

describe('createSelfHostedIntegration', () => {
  it('inserts a self_hosted integration with no api key', async () => {
    const { db, tx } = mockDb([{ id: 'int-1', connectionType: 'self_hosted' }]);
    const out = await createSelfHostedIntegration(db, 'partner-1', { accountLabel: 'HQ VM', createdBy: 'user-1' });
    expect(out).toEqual({ id: 'int-1', connectionType: 'self_hosted' });
    const values = (tx.insert as any).mock.results[0].value.values.mock.calls[0][0];
    expect(values.connectionType).toBe('self_hosted');
    expect(values.apiKeyEncrypted ?? null).toBeNull();
    expect(values.partnerId).toBe('partner-1');
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });
});
