import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../stores/auth';
import { saveTopologyLayout, TopologyLayoutDraft } from './layoutPersistence';
const siteId = '11111111-1111-4111-8111-111111111111', nodeId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => vi.clearAllMocks());
it('local arrangement makes no mutation and conflict preserves the draft', async () => {
  const draft = new TopologyLayoutDraft(); const point = { nodeId, x: 320, y: 180, pinned: true };
  draft.preview([point]); expect(fetchWithAuth).not.toHaveBeenCalled();
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'Layout changed', code: 'revision_conflict', currentRevision: '8' }), { status: 409 }));
  await expect(saveTopologyLayout({ siteId }, 'overview', '7', [point])).rejects.toMatchObject({ status: 409 });
  expect(draft.positions.get(nodeId)).toEqual(point); expect(draft.dirty).toBe(true);
});
it('merges only accepted server positions and retains other saved nodes', () => {
  const draft = new TopologyLayoutDraft(), other = '33333333-3333-4333-8333-333333333333';
  draft.load('1', [{ nodeId: other, x: 10, y: 20, pinned: true, rowRevision: '1', source: 'user' }]);
  draft.accept({ siteId, view: 'overview', layoutRevision: '2', positions: [{ nodeId, x: 1, y: 2, pinned: false, rowRevision: '2', source: 'user' }] });
  expect(draft.positions.size).toBe(2); expect(draft.positions.get(other)?.pinned).toBe(true);
});
it.each([Infinity, NaN, 1000001])('rejects invalid coordinate %s before dispatch', async (x) => {
  await expect(saveTopologyLayout({ siteId }, 'overview', '0', [{ nodeId, x, y: 0, pinned: false }])).rejects.toThrow();
  expect(fetchWithAuth).not.toHaveBeenCalled();
});
