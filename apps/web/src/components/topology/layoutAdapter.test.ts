import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, packTopologyLayout, toElkGraph } from './layoutAdapter';
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

describe('port-aware physical layout', () => {
  it('attaches edges to interface ports and keeps parallel cables distinct without moving saved positions', async () => {
    const request = layoutFixture('incremental');
    request.edges = [...request.edges,
      { id: 'cable-1', source: 'pin', target: 'new', sourcePort: 'if-1', targetPort: 'if-2' },
      { id: 'cable-2', source: 'pin', target: 'new', sourcePort: 'if-3', targetPort: 'if-4' }];
    const graph = toElkGraph(request);
    const cables = (graph.edges ?? []).filter((edge) => edge.id.startsWith('cable'));
    expect(cables.map((edge) => [edge.sources[0], edge.targets[0]])).toEqual([['pin:if-1', 'new:if-2'], ['pin:if-3', 'new:if-4']]);
    const pin = (graph.children ?? []).find((child) => child.id === 'pin');
    expect(pin?.ports?.map((port) => port.id)).toEqual(['pin:if-1', 'pin:if-3']);
    const result = await computeTopologyLayout(request, new ELK());
    expect(result.positions.find((p) => p.nodeId === 'pin')).toEqual(request.positions[0]);
    expect(findOverlaps(result, request)).toEqual([]);
  });
});
