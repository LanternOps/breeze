import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, packTopologyLayout } from './layoutAdapter';
import { layoutFixture, findOverlaps } from './layoutFixtures';
describe('real ELK topology layout', () => {
  it.each(['incremental', 'reflow'] as const)('is deterministic, collision-free and retains pins in %s mode', async (mode) => {
    const request = layoutFixture(mode), first = await computeTopologyLayout(request, new ELK()), second = await computeTopologyLayout(request, new ELK());
    expect(first.positions).toEqual(second.positions);
    expect(first.positions.find((p) => p.nodeId === 'pin')).toEqual(request.positions[0]);
    expect(findOverlaps(first, request)).toEqual([]);
  });
  it('retains all saved coordinates on incremental placement', async () => {
    const request = layoutFixture(); request.positions[0].pinned = false;
    const result = await computeTopologyLayout(request, new ELK());
    expect(result.positions.find((p) => p.nodeId === 'pin')).toEqual(request.positions[0]);
  });
  it('falls back deterministically without moving pins', () => {
    const request = layoutFixture('reflow'), result = packTopologyLayout(request, undefined, true);
    expect(result.warning).toBe('layout_fallback'); expect(findOverlaps(result, request)).toEqual([]);
    expect(result.positions.find((p) => p.nodeId === 'pin')).toEqual(request.positions[0]);
  });
});
