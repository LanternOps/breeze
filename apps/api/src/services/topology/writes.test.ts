import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), access: vi.fn() }));
vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn(), withDbTransaction: mocks.transaction }));
vi.mock('./access', () => ({ requireTopologySiteAccess: mocks.access }));
vi.mock('./legacyImport', () => ({ drainTopologyOutbox: vi.fn() }));
import { withTopologyWrite } from './writes';
import type { TopologyRequestContext } from './access';

const ctx = { scope: { orgId: '11111111-1111-4111-8111-111111111111', siteId: '22222222-2222-4222-8222-222222222222' } } as TopologyRequestContext;
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue(ctx); });
describe('topology transaction conflict boundary', () => {
  it.each(['55P03', '40P01', '40001'])('returns retryable conflict only after the %s transaction rejects', async code => {
    mocks.transaction.mockRejectedValue({ cause: { code } });
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toMatchObject({ code: 'topology_inventory_busy', status: 409 });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
  it('preserves unrelated SQL errors and authorization denials', async () => {
    const sqlError = { cause: { code: '23503' } };
    mocks.transaction.mockRejectedValue(sqlError);
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toBe(sqlError);
    mocks.transaction.mockClear();
    const denial = new Error('denied'); mocks.access.mockRejectedValue(denial);
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toBe(denial);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
