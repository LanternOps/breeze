import { describe, expect, it } from 'vitest';
import type { RenderEdge } from './renderProjection';
import { routeEdgesToCards } from './edgeRouting';

const edge = (id: string, source: string, target: string, style: RenderEdge['style'] = 'logical', label: string | null = null): RenderEdge =>
  ({ id, source, target, style, label, layoutSource: source, layoutTarget: target });
const parents = new Map([['m1', 'card'], ['m2', 'card'], ['m3', 'card'], ['x1', 'card2']]);
const names = new Map([['m1', 'DR-LAPTOP-02'], ['m2', 'FRONT-01']]);
const route = (edges: RenderEdge[]) => routeEdgesToCards(edges, { parentOf: (id) => parents.get(id), labelOf: (id) => names.get(id) ?? id, bundleLabel: (n) => `${n} links` });

describe('routeEdgesToCards', () => {
  it('ends an edge to a card member at the card, naming the member at that end', () => {
    const [drawn] = route([edge('e1', 'm1', 'gw')]);
    expect(drawn).toMatchObject({ id: 'e1', source: 'card', target: 'gw', relationshipIds: ['e1'], sourceEnd: 'DR-LAPTOP-02', targetEnd: null, label: null });
  });

  it('leaves edges between top-level nodes and cards untouched', () => {
    const [drawn] = route([edge('rv', 'card', 'gw', 'route')]);
    expect(drawn).toMatchObject({ id: 'rv', source: 'card', target: 'gw', style: 'route', sourceEnd: null, targetEnd: null, relationshipIds: ['rv'] });
  });

  it('drops edges whose ends share one card (containment already says it)', () => {
    expect(route([edge('in', 'm1', 'm2')])).toEqual([]);
  });

  it('bundles several member edges between the same card and node into one labelled edge', () => {
    const drawn = route([edge('e2', 'gw', 'm2'), edge('e1', 'm1', 'gw'), edge('e3', 'm3', 'gw', 'physical')]);
    const bundle = drawn.find((d) => d.relationshipIds.length > 1)!;
    expect(bundle).toMatchObject({ source: 'card', target: 'gw', relationshipIds: ['e1', 'e2'], label: '2 links', sourceEnd: null, targetEnd: null });
    expect(bundle.id).toBe('bundle:e1');
    // A different style is a different kind of evidence and stays its own edge.
    expect(drawn.find((d) => d.style === 'physical')).toMatchObject({ id: 'e3', source: 'card', relationshipIds: ['e3'] });
  });

  it('routes card-to-card member edges between the two cards', () => {
    const [drawn] = route([edge('e9', 'm1', 'x1', 'inferred')]);
    expect(drawn).toMatchObject({ source: 'card', target: 'card2', sourceEnd: 'DR-LAPTOP-02', targetEnd: 'x1' });
  });

  it('keeps an existing aggregate label', () => {
    const [drawn] = route([edge('sh', 'card', 'card2', 'shared', '1 shared')]);
    expect(drawn!.label).toBe('1 shared');
  });
});
