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

it('an automatic layout updates the draft without marking it dirty; a user layout marks it dirty (#7880)', () => {
  const draft = new TopologyLayoutDraft();
  draft.load('3', [{ nodeId, x: 1, y: 2, pinned: false, rowRevision: '1', source: 'user' }]);
  draft.applyLayout([{ nodeId, x: 40, y: 50, pinned: false }], { cardMembers: new Set(), userAction: false });
  expect(draft.positions.get(nodeId)).toMatchObject({ x: 40, y: 50 }); expect(draft.dirty).toBe(false);
  draft.applyLayout([{ nodeId, x: 60, y: 70, pinned: false }], { cardMembers: new Set(), userAction: true });
  expect(draft.dirty).toBe(true);
  // An automatic pass never clears a user's unsaved change.
  draft.applyLayout([{ nodeId, x: 80, y: 90, pinned: false }], { cardMembers: new Set(), userAction: false });
  expect(draft.dirty).toBe(true);
});

it('a clean draft keeps its automatic layout across re-measures of the same layout revision, and adopts a new one (#7880 review)', () => {
  const draft = new TopologyLayoutDraft(), other = '33333333-3333-4333-8333-333333333333';
  draft.load('3', []);
  draft.applyLayout([{ nodeId, x: 40, y: 50, pinned: false }], { cardMembers: new Set(), userAction: false });
  // A device appears (same layout revision): already-placed tiles must not be re-laid out from scratch.
  draft.load('3', []);
  expect(draft.positions.get(nodeId)).toMatchObject({ x: 40, y: 50 });
  // Another editor saved: the shared layout wins over the automatic one.
  draft.load('4', [{ nodeId: other, x: 1, y: 2, pinned: true, rowRevision: '4', source: 'user' }]);
  expect(draft.revision).toBe('4'); expect([...draft.positions.keys()]).toEqual([other]);
});

it('keeps a card member\'s saved pin coordinates in the draft while the canvas draws it in the grid (revised Q3, #7880)', () => {
  const draft = new TopologyLayoutDraft(), loose = '33333333-3333-4333-8333-333333333333';
  draft.load('3', [{ nodeId, x: 5_000, y: 5_000, pinned: true, rowRevision: '1', source: 'legacy' }, { nodeId: loose, x: 9, y: 9, pinned: true, rowRevision: '1', source: 'user' }]);
  draft.applyLayout([{ nodeId, x: 120, y: 80, pinned: true }, { nodeId: loose, x: 9, y: 9, pinned: true }], { cardMembers: new Set([nodeId]), userAction: false });
  expect(draft.positions.get(nodeId)).toMatchObject({ x: 5_000, y: 5_000, pinned: true });
  expect(draft.positions.get(loose)).toMatchObject({ x: 9, y: 9, pinned: true });
  // Once the pin is cleared ("Use grouped layout"), the grid position is what gets saved.
  draft.positions.set(nodeId, { nodeId, x: 5_000, y: 5_000, pinned: false });
  draft.applyLayout([{ nodeId, x: 120, y: 80, pinned: false }], { cardMembers: new Set([nodeId]), userAction: true });
  expect(draft.positions.get(nodeId)).toEqual({ nodeId, x: 120, y: 80, pinned: false });
});
