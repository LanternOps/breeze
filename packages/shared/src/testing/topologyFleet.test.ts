import { describe, expect, it } from 'vitest';
import {
  TOPOLOGY_FIXTURE_SEED, buildTopologyFixture, topologyGraphFixture, topologyIngestFixture,
  type TopologyGraphFixture,
} from './topologyFleet';

const kindCounts = (fixture: TopologyGraphFixture) => fixture.edges.reduce<Record<string, number>>(
  (acc, edge) => ({ ...acc, [edge.kind]: (acc[edge.kind] ?? 0) + 1 }), {});

describe('deterministic topology fleet fixtures', () => {
  it('is byte-stable for a seed and different across seeds', () => {
    expect(JSON.stringify(topologyGraphFixture('V200', TOPOLOGY_FIXTURE_SEED)))
      .toBe(JSON.stringify(topologyGraphFixture('V200', TOPOLOGY_FIXTURE_SEED)));
    expect(JSON.stringify(topologyGraphFixture('V200', 'other-seed')))
      .not.toBe(JSON.stringify(topologyGraphFixture('V200', TOPOLOGY_FIXTURE_SEED)));
    expect(JSON.stringify(buildTopologyFixture('I10K', TOPOLOGY_FIXTURE_SEED).agents))
      .toBe(JSON.stringify(buildTopologyFixture('I10K', TOPOLOGY_FIXTURE_SEED).agents));
  });

  it('builds G10K at exactly the planned node, edge, evidence, stale, pin and label budgets', () => {
    const g = topologyGraphFixture('G10K', TOPOLOGY_FIXTURE_SEED);
    expect(g.nodes).toHaveLength(10_000);
    expect(g.edges).toHaveLength(20_000);
    expect(kindCounts(g)).toEqual({ network_member: 12_000, default_route: 4_000, attachment: 2_000, physical_link: 2_000 });
    expect(g.edges.every((edge) => edge.sourceCount === 4)).toBe(true);
    expect(g.nodes.filter((node) => node.stale)).toHaveLength(1_000);
    expect(g.nodes.filter((node) => node.pinned)).toHaveLength(100);
    expect(g.nodes.filter((node) => node.label.length === 80)).toHaveLength(2_000);
    expect(new Set(g.nodes.map((node) => node.id)).size).toBe(10_000);
    expect(new Set(g.edges.map((edge) => edge.id)).size).toBe(20_000);
  });

  it('builds the visible projections at their planned sizes', () => {
    for (const [name, nodes, edges] of [['V200', 200, 350], ['V500', 500, 1_000], ['V1000', 1_000, 2_000]] as const) {
      const fixture = topologyGraphFixture(name, TOPOLOGY_FIXTURE_SEED);
      expect([fixture.nodes.length, fixture.edges.length]).toEqual([nodes, edges]);
      expect(Object.values(kindCounts(fixture)).reduce((a, b) => a + b, 0)).toBe(edges);
      expect(fixture.edges.every((edge) => fixture.nodes.some((n) => n.id === edge.sourceNodeId)
        && fixture.nodes.some((n) => n.id === edge.targetNodeId))).toBe(true);
    }
  });

  it('contains parallel edges and a cycle so layout stress is not a forest', () => {
    const g = topologyGraphFixture('V500', TOPOLOGY_FIXTURE_SEED);
    const pairs = g.edges.map((edge) => `${edge.sourceNodeId}->${edge.targetNodeId}`);
    expect(pairs.length).toBeGreaterThan(new Set(pairs).size);
    expect(g.edges.some((edge) => g.edges.some((other) => other.sourceNodeId === edge.targetNodeId
      && other.targetNodeId === edge.sourceNodeId))).toBe(true);
  });

  it('describes I10K as 100 sites x 100 agents with a 1% structural change budget', () => {
    const i = topologyIngestFixture('I10K', TOPOLOGY_FIXTURE_SEED);
    expect(i.siteCount).toBe(100);
    expect(i.agentsPerSite).toBe(100);
    expect(i.agents).toHaveLength(10_000);
    expect(i.cadenceSeconds).toBe(300);
    expect(i.changedFraction).toBe(0.01);
    expect(i.agents.every((agent) => agent.jitterSeconds >= 0 && agent.jitterSeconds < 300)).toBe(true);
    expect(new Set(i.agents.map((agent) => agent.jitterSeconds)).size).toBeGreaterThan(1);
    expect(i.agents.filter((agent) => i.isChangedRound(agent.producerIndex, 7))).toHaveLength(100);
    expect(i.structuralRunsPerDay).toBe(28_800);
    expect(i.unchangedRunInserts).toBe(0);
    expect(i.unchangedObservationInserts).toBe(0);
  });

  it('scales an ingest fixture down without changing its invariants', () => {
    const small = topologyIngestFixture('I10K', TOPOLOGY_FIXTURE_SEED, { siteCount: 3, agentsPerSite: 4 });
    expect(small.agents).toHaveLength(12);
    expect(small.agents.map((agent) => agent.siteIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
    expect(small.cadenceSeconds).toBe(300);
    expect(small.agents.slice(0, 4)).toEqual(
      topologyIngestFixture('I10K', TOPOLOGY_FIXTURE_SEED, { siteCount: 1, agentsPerSite: 4 }).agents);
  });

  it('rejects an unknown fixture name instead of silently returning an empty dataset', () => {
    expect(() => buildTopologyFixture('V42' as 'V200', TOPOLOGY_FIXTURE_SEED)).toThrow(/unknown topology fixture/i);
    expect(() => topologyGraphFixture('I10K' as 'G10K', TOPOLOGY_FIXTURE_SEED)).toThrow(/not a graph fixture/i);
    expect(() => topologyIngestFixture('G10K' as 'I10K', TOPOLOGY_FIXTURE_SEED)).toThrow(/not an ingest fixture/i);
  });
});
