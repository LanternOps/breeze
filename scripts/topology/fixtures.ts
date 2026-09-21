/**
 * Named topology fleet datasets at the normative seed.
 *
 * The generator itself lives in `packages/shared/src/testing/topologyFleet.ts`
 * so the API integration gates, the web layout fixtures and this CLI-facing
 * module all build the same bytes from one implementation. Datasets are built
 * lazily: importing this module must not allocate the 10,000-node graph.
 */
import {
  TOPOLOGY_FIXTURE_SEED, buildTopologyFixture, topologyGraphFixture, topologyIngestFixture,
  type TopologyFixture, type TopologyFixtureName, type TopologyGraphFixture, type TopologyIngestFixture,
} from '../../packages/shared/src/testing/topologyFleet';

export {
  TOPOLOGY_FIXTURE_SEED, buildTopologyFixture, topologyGraphFixture, topologyIngestFixture,
};
export type { TopologyFixture, TopologyFixtureName, TopologyGraphFixture, TopologyIngestFixture };

export const TOPOLOGY_FIXTURE_NAMES: TopologyFixtureName[] = ['G10K', 'V1000', 'V500', 'V200', 'I10K'];

/** Read/layout stress graph: 10,000 nodes / 20,000 edges. */
export const G10K = (seed = TOPOLOGY_FIXTURE_SEED): TopologyGraphFixture => topologyGraphFixture('G10K', seed);
/** Visible projections rendered in the browser performance gates. */
export const V1000 = (seed = TOPOLOGY_FIXTURE_SEED): TopologyGraphFixture => topologyGraphFixture('V1000', seed);
export const V500 = (seed = TOPOLOGY_FIXTURE_SEED): TopologyGraphFixture => topologyGraphFixture('V500', seed);
export const V200 = (seed = TOPOLOGY_FIXTURE_SEED): TopologyGraphFixture => topologyGraphFixture('V200', seed);
/** Ingest fleet: 100 sites x 100 agents, one context/source each. */
export const I10K = (seed = TOPOLOGY_FIXTURE_SEED): TopologyIngestFixture => topologyIngestFixture('I10K', seed);
