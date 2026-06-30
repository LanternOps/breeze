import { describe, it, expect, vi } from 'vitest';
import { createSelfHostedIntegration } from './unifiConnectionService';

function mockDb(returning: any[]) {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(returning),
        }),
      }),
    }),
  } as any;
}

describe('createSelfHostedIntegration', () => {
  it('inserts a self_hosted integration with no api key', async () => {
    const db = mockDb([{ id: 'int-1', connectionType: 'self_hosted' }]);
    const out = await createSelfHostedIntegration(db, 'partner-1', { accountLabel: 'HQ VM', createdBy: 'user-1' });
    expect(out).toEqual({ id: 'int-1', connectionType: 'self_hosted' });
    const values = (db.insert as any).mock.results[0].value.values.mock.calls[0][0];
    expect(values.connectionType).toBe('self_hosted');
    expect(values.apiKeyEncrypted ?? null).toBeNull();
    expect(values.partnerId).toBe('partner-1');
  });
});
