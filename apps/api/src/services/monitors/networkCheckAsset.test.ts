import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { assertNetworkCheckAssetOwner } from './networkCheckAsset';

const orgId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
function executor(rows: unknown[]) {
  const where = vi.fn((_condition: import('drizzle-orm').SQL) => ({ limit: async () => rows }));
  const select = vi.fn(() => ({ from: () => ({ where }) }));
  return { select, where };
}

describe('network check asset ownership', () => {
  it('rejects a missing or foreign-org asset', async () => {
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId, partnerId: null }, executor([]) as never))
      .rejects.toThrow('asset_not_owned');
  });

  it('rejects a partner-owned asset binding without a read', async () => {
    const tx = executor([{ id: assetId }]);
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId: null, partnerId: orgId }, tx as never))
      .rejects.toThrow('asset_requires_org_owner');
    expect(tx.select).not.toHaveBeenCalled();
  });

  it('accepts a same-org asset using both asset and owner predicates', async () => {
    const tx = executor([{ id: assetId }]);
    await expect(assertNetworkCheckAssetOwner('network_check', { assetId }, { orgId, partnerId: null }, tx as never)).resolves.toBeUndefined();
    const query = new PgDialect().sqlToQuery(tx.where.mock.calls[0]![0]);
    expect(query.params).toEqual([assetId, orgId]);
    expect(query.sql).toContain('"discovered_assets"."org_id"');
  });

  it('skips unbound checks and other monitor kinds', async () => {
    const tx = executor([]);
    await assertNetworkCheckAssetOwner('network_check', {}, { orgId: null, partnerId: orgId }, tx as never);
    await assertNetworkCheckAssetOwner('cpu', { assetId }, { orgId, partnerId: null }, tx as never);
    expect(tx.select).not.toHaveBeenCalled();
  });
});
