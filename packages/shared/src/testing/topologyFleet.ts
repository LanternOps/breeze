/**
 * Deterministic fleet fixtures for topology load, layout and retention gates.
 *
 * Every value here comes from the seeded PRNG below: no `Math.random`, no
 * `Date.now`, no network, no environment. The same `(name, seed)` pair produces
 * byte-identical data on every machine, so a measured run can be replayed.
 *
 * `G10K` is the read/layout stress graph; `V200`/`V500`/`V1000` are the visible
 * projections rendered in the browser; `I10K` describes the ingest fleet (sites,
 * agents, cadence and the structural-change budget) rather than graph rows.
 *
 * Note: the visible projections are generated with the same generator and the
 * same proportions as `G10K` at their own sizes; they are not literal subgraphs
 * of the `G10K` instance (a subgraph cannot hit an exact edge budget).
 */

export const TOPOLOGY_FIXTURE_SEED = 'topology-v1';

export type TopologyGraphFixtureName = 'G10K' | 'V1000' | 'V500' | 'V200';
export type TopologyIngestFixtureName = 'I10K';
export type TopologyFixtureName = TopologyGraphFixtureName | TopologyIngestFixtureName;

export type TopologyFixtureNodeKind = 'endpoint' | 'network' | 'gateway';
export type TopologyFixtureEdgeKind = 'network_member' | 'default_route' | 'attachment' | 'physical_link';

export type TopologyFixtureNode = {
  id: string; index: number; label: string; kind: TopologyFixtureNodeKind;
  /** Evidence older than the freshness window; 10% of every graph fixture. */
  stale: boolean;
  /** Operator-pinned position the layout engine must not move. */
  pinned: boolean;
};
export type TopologyFixtureEdge = {
  id: string; index: number; kind: TopologyFixtureEdgeKind;
  sourceNodeId: string; targetNodeId: string;
  /** Independent supporting sources per relationship. */
  sourceCount: number;
};
export type TopologyGraphFixture = {
  kind: 'graph'; name: TopologyGraphFixtureName; seed: string;
  nodes: TopologyFixtureNode[]; edges: TopologyFixtureEdge[];
};

export type TopologyFixtureAgent = {
  producerIndex: number; siteIndex: number; agentIndex: number;
  contextKey: string; jitterSeconds: number;
};
export type TopologyIngestFixture = {
  kind: 'ingest'; name: TopologyIngestFixtureName; seed: string;
  siteCount: number; agentsPerSite: number; cadenceSeconds: number; changedFraction: number;
  agents: TopologyFixtureAgent[];
  /** Deterministic 1% structural-change selection for a cadence round. */
  isChangedRound(producerIndex: number, round: number): boolean;
  /** sources x rounds/day x changedFraction — the only history this load writes. */
  structuralRunsPerDay: number;
  /** Contractual: a full revalidation with identical content appends nothing. */
  unchangedRunInserts: 0;
  unchangedObservationInserts: 0;
};

export type TopologyFixture = TopologyGraphFixture | TopologyIngestFixture;

const GRAPH_SPECS: Record<TopologyGraphFixtureName, { nodes: number; edges: number; pinned: number }> = {
  G10K: { nodes: 10_000, edges: 20_000, pinned: 100 },
  V1000: { nodes: 1_000, edges: 2_000, pinned: 10 },
  V500: { nodes: 500, edges: 1_000, pinned: 5 },
  V200: { nodes: 200, edges: 350, pinned: 2 },
};
/** 60/20/10/10 hits every planned edge budget exactly, including V200's 350. */
const EDGE_MIX: [TopologyFixtureEdgeKind, number][] = [
  ['default_route', 0.2], ['attachment', 0.1], ['physical_link', 0.1],
];
const STALE_FRACTION = 0.1;
const LONG_LABEL_FRACTION = 0.2;
const LONG_LABEL_LENGTH = 80;
const SOURCES_PER_RELATIONSHIP = 4;
const NODE_KINDS: TopologyFixtureNodeKind[] = ['endpoint', 'network', 'gateway'];

/** FNV-1a over the seed feeding mulberry32; pure, isomorphic, no node:crypto. */
function seedValue(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
function createRandom(seed: string): () => number {
  let state = seedValue(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomInt = (random: () => number, bound: number) => Math.floor(random() * bound) % bound;
function randomUuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => randomInt(random, 16).toString(16));
  hex[12] = '4';
  hex[16] = (8 + randomInt(random, 4)).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
/** Deterministic selection of exactly `count` of `total` indexes. */
function pickIndexes(random: () => number, total: number, count: number): Set<number> {
  const picked = new Set<number>();
  let cursor = randomInt(random, Math.max(total, 1));
  while (picked.size < Math.min(count, total)) {
    cursor = (cursor + 1 + randomInt(random, Math.max(total - 1, 1))) % total;
    picked.add(cursor);
  }
  return picked;
}

function buildGraph(name: TopologyGraphFixtureName, seed: string): TopologyGraphFixture {
  const spec = GRAPH_SPECS[name];
  const random = createRandom(`${seed}:${name}`);
  const stale = pickIndexes(random, spec.nodes, Math.round(spec.nodes * STALE_FRACTION));
  const longLabel = pickIndexes(random, spec.nodes, Math.round(spec.nodes * LONG_LABEL_FRACTION));
  const pinned = pickIndexes(random, spec.nodes, spec.pinned);
  const nodes: TopologyFixtureNode[] = Array.from({ length: spec.nodes }, (_unused, index) => {
    const short = `node-${index}`;
    return {
      id: randomUuid(random), index,
      label: longLabel.has(index) ? short.padEnd(LONG_LABEL_LENGTH, '-').slice(0, LONG_LABEL_LENGTH) : short,
      kind: NODE_KINDS[index % NODE_KINDS.length]!,
      stale: stale.has(index), pinned: pinned.has(index),
    };
  });

  const kinds: TopologyFixtureEdgeKind[] = [];
  for (const [kind, share] of EDGE_MIX) for (let i = 0; i < Math.round(spec.edges * share); i += 1) kinds.push(kind);
  const members = spec.edges - kinds.length;
  kinds.unshift(...Array.from({ length: members }, () => 'network_member' as const));

  const edges: TopologyFixtureEdge[] = kinds.map((kind, index) => {
    // Indexes 0-2 are forced so every fixture carries a two-cycle (0<->1) and a
    // parallel edge (a second 0->1); the rest fan out from a rotating source so
    // no node is isolated and longer cycles appear naturally.
    const source = index === 1 ? 1 : index <= 2 ? 0 : index % spec.nodes;
    const target = index === 1 ? 0 : index <= 2 ? 1
      : (source + 1 + randomInt(random, Math.max(spec.nodes - 1, 1))) % spec.nodes;
    return {
      id: randomUuid(random), index, kind,
      sourceNodeId: nodes[source]!.id, targetNodeId: nodes[target]!.id,
      sourceCount: SOURCES_PER_RELATIONSHIP,
    };
  });
  return { kind: 'graph', name, seed, nodes, edges };
}

const INGEST_SPECS: Record<TopologyIngestFixtureName, { siteCount: number; agentsPerSite: number }> = {
  I10K: { siteCount: 100, agentsPerSite: 100 },
};
const CADENCE_SECONDS = 300;
const CHANGED_FRACTION = 0.01;
/** One in `CHANGED_PERIOD` producers reports a structural change per round. */
const CHANGED_PERIOD = Math.round(1 / CHANGED_FRACTION);

function buildIngest(name: TopologyIngestFixtureName, seed: string,
  scale?: { siteCount?: number; agentsPerSite?: number }): TopologyIngestFixture {
  const spec = INGEST_SPECS[name];
  const siteCount = scale?.siteCount ?? spec.siteCount;
  const agentsPerSite = scale?.agentsPerSite ?? spec.agentsPerSite;
  const random = createRandom(`${seed}:${name}`);
  const agents: TopologyFixtureAgent[] = [];
  for (let siteIndex = 0; siteIndex < siteCount; siteIndex += 1) {
    for (let agentIndex = 0; agentIndex < agentsPerSite; agentIndex += 1) {
      agents.push({
        producerIndex: agents.length, siteIndex, agentIndex,
        contextKey: 'default', jitterSeconds: randomInt(random, CADENCE_SECONDS),
      });
    }
  }
  const sources = spec.siteCount * spec.agentsPerSite;
  return {
    kind: 'ingest', name, seed, siteCount, agentsPerSite,
    cadenceSeconds: CADENCE_SECONDS, changedFraction: CHANGED_FRACTION, agents,
    isChangedRound: (producerIndex, round) => (producerIndex + round) % CHANGED_PERIOD === 0,
    structuralRunsPerDay: sources * (86_400 / CADENCE_SECONDS) * CHANGED_FRACTION,
    unchangedRunInserts: 0, unchangedObservationInserts: 0,
  };
}

export function topologyGraphFixture(name: TopologyGraphFixtureName, seed = TOPOLOGY_FIXTURE_SEED): TopologyGraphFixture {
  if (!(name in GRAPH_SPECS)) {
    if (name in INGEST_SPECS) throw new Error(`Topology fixture ${name} is not a graph fixture`);
    throw new Error(`Unknown topology fixture ${name}`);
  }
  return buildGraph(name, seed);
}
export function topologyIngestFixture(name: TopologyIngestFixtureName, seed = TOPOLOGY_FIXTURE_SEED,
  scale?: { siteCount?: number; agentsPerSite?: number }): TopologyIngestFixture {
  if (!(name in INGEST_SPECS)) {
    if (name in GRAPH_SPECS) throw new Error(`Topology fixture ${name} is not an ingest fixture`);
    throw new Error(`Unknown topology fixture ${name}`);
  }
  return buildIngest(name, seed, scale);
}
export function buildTopologyFixture(name: TopologyIngestFixtureName, seed?: string): TopologyIngestFixture;
export function buildTopologyFixture(name: TopologyGraphFixtureName, seed?: string): TopologyGraphFixture;
export function buildTopologyFixture(name: TopologyFixtureName, seed?: string): TopologyFixture;
export function buildTopologyFixture(name: TopologyFixtureName, seed = TOPOLOGY_FIXTURE_SEED): TopologyFixture {
  if (name in GRAPH_SPECS) return buildGraph(name as TopologyGraphFixtureName, seed);
  if (name in INGEST_SPECS) return buildIngest(name as TopologyIngestFixtureName, seed);
  throw new Error(`Unknown topology fixture ${name}`);
}
