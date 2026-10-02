/**
 * W06 (#7604) Task 11: per-kind model discovery for gateway connections.
 * `syncConnectionModels` (discovery.ts) looks a gateway kind up here; W07 adds
 * `bedrock`. A kind absent from the registry is manual-entry only (W07: vertex,
 * foundry) and its sync is skipped.
 *
 * A discoverer only LISTS: it returns sanitised ids and names and never
 * touches the database. Persisting (disabled, unpriced, unverified rows) and
 * the lifecycle rules stay in discovery.ts.
 */
import type { GatewayConnectionKind } from '@breeze/shared';
import { discoverOpenAiCompatibleModels } from './gateway/openai/discovery';
import type { DiscoveredConnectionModel, GatewayConnectionConfig, GatewayCredential } from './gateway/types';

export type { DiscoveredConnectionModel } from './gateway/types';
export { discoveryGrantRecord } from './gateway/grants';

export type ConnectionModelDiscoverer = (input: {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
}) => Promise<DiscoveredConnectionModel[]>;

export const CONNECTION_MODEL_DISCOVERERS: Partial<Record<GatewayConnectionKind, ConnectionModelDiscoverer>> = {
  openai_compatible: ({ config, credential }) => discoverOpenAiCompatibleModels({ config, credential }),
};
