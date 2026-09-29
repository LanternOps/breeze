import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, packTopologyLayout, toElkGraph } from './layoutAdapter';
import { layoutFixture, layoutProjectionFixture, findOverlaps } from './layoutFixtures';
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

describe('ELK Layered cost at the §9 visible projections (#7285)', () => {
  it('breaks cycles breadth-first from the role-sorted model order and does not sort crossings by model order', () => {
    const options = toElkGraph(layoutProjectionFixture('V200')).layoutOptions!;
    expect(options['elk.layered.cycleBreaking.strategy']).toBe('BFS_NODE_ORDER');
    expect(options['elk.layered.considerModelOrder.strategy']).toBeUndefined();
    expect(options['elk.randomSeed']).toBe('7');
  });

  it('keeps full crossing-minimisation effort for small graphs and reduces it only for large projections', () => {
    const thoroughness = (graph: ReturnType<typeof toElkGraph>) => graph.layoutOptions!['elk.layered.thoroughness'];
    expect(thoroughness(toElkGraph(layoutFixture()))).toBe('7');
    expect(thoroughness(toElkGraph(layoutProjectionFixture('V200')))).toBe('7');
    expect(thoroughness(toElkGraph(layoutProjectionFixture('V500')))).toBe('3');
    expect(thoroughness(toElkGraph(layoutProjectionFixture('V1000')))).toBe('1');
  });

  // The pre-fix options took ~7 s (V500) and ~40 s (V1000) of CPU for ELK alone,
  // which is what pushed every browser open past the controller's 3 s timeout.
  // The bound here is deliberately loose (shared CI runners are slow); it guards
  // against that order-of-magnitude regression, not the §9 browser budget.
  it.each(['V500', 'V1000'] as const)('lays out %s with real ELK, without fallback or overlap, in bounded time', async (name) => {
    const request = layoutProjectionFixture(name);
    const started = performance.now();
    const result = await computeTopologyLayout(request, new ELK());
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result.warning).toBeUndefined();
    expect(result.positions).toHaveLength(request.nodes.length);
    for (const pin of request.positions) expect(result.positions.find((p) => p.nodeId === pin.nodeId)).toEqual(pin);
    expect(findOverlaps(result, request)).toEqual([]);
  }, 60_000);

  it('lays out grouped (compound) nodes with the breadth-first cycle breaker', async () => {
    const request = layoutFixture('reflow');
    request.nodes = [...request.nodes, { id: 'm1', width: 220, height: 88, role: 'endpoint', groupId: 'lan' }, { id: 'm2', width: 220, height: 88, role: 'endpoint', groupId: 'lan' }];
    request.edges = [...request.edges, { id: 'd', source: 'long-label', target: 'm1' }, { id: 'e', source: 'm1', target: 'm2' }, { id: 'f', source: 'm2', target: 'long-label' }];
    const first = await computeTopologyLayout(request, new ELK()), second = await computeTopologyLayout(request, new ELK());
    expect(first.warning).toBeUndefined();
    expect(first.positions).toEqual(second.positions);
    expect(findOverlaps(first, request)).toEqual([]);
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
