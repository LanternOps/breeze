import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), assert: vi.fn(), access: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: mocks.transaction }, withDbTransaction: vi.fn(), assertInTransaction: mocks.assert }));
vi.mock('./access', () => ({ requireTopologySiteAccess: mocks.access }));
vi.mock('./legacyImport', () => ({ drainTopologyOutbox: vi.fn() }));
import { saveTopologyLayout } from './layouts';
import type { TopologyRequestContext } from './access';
const ctx = { scope: { orgId: '11111111-1111-4111-8111-111111111111', siteId: '22222222-2222-4222-8222-222222222222' } } as TopologyRequestContext;
describe('layout service boundary', () => {
  it('rejects a bigint overflow before opening a transaction', async () => {
    await expect(saveTopologyLayout(ctx, 'overview', { expectedRevision: '9223372036854775808', positions: [] })).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('rejects presentation IDs and duplicate node IDs before writes', async () => {
    for (const nodeIds of [['presentation:overview:scope:gateway'], ['33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333']]) {
      await expect(saveTopologyLayout(ctx, 'overview', { expectedRevision: '0', positions: nodeIds.map(nodeId => ({ nodeId, x: 1, y: 2, pinned: false })) })).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
