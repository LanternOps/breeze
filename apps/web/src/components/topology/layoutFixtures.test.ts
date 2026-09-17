import { describe, expect, it } from 'vitest';
import { layoutProjectionFixture } from './layoutFixtures';

describe('visible projection layout fixtures', () => {
  it('projects each planned size onto one deterministic layout request', () => {
    for (const [name, nodes, edges] of [['V200', 200, 350], ['V500', 500, 1_000], ['V1000', 1_000, 2_000]] as const) {
      const request = layoutProjectionFixture(name);
      expect([request.nodes.length, request.edges.length]).toEqual([nodes, edges]);
      const ids = new Set(request.nodes.map((node) => node.id));
      expect(request.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
      expect(request.positions.length).toBeGreaterThan(0);
      expect(request.positions.every((position) => position.pinned && ids.has(position.nodeId))).toBe(true);
      expect(JSON.stringify(request)).toBe(JSON.stringify(layoutProjectionFixture(name)));
    }
  });
});
