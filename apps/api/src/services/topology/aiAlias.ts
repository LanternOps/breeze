/**
 * Topology M4 Task 2 (#6000): per-investigation host aliases. A leaf module
 * (no graph/DB imports) so the evidence builder, the tool gate and the tool
 * projections share ONE key and ONE scope derivation (review C8).
 */
import { createHmac, randomUUID } from 'node:crypto';

import { getSecretDerivedKeyMaterials } from '../secretCrypto';

const ALIAS_DOMAIN = 'topology-ai-alias:v1';

/**
 * `host` aliases are keyed by the STABLE topology node id, never by the
 * collected label: two hosts sharing a name must stay two identities, and the
 * snapshot, every tool result and the display alias map must agree on which
 * node an alias stands for (review C7).
 */
export type TopologyAiAliasContext = { alias(kind: 'host' | 'address', stableId: string): string };

/**
 * THE alias scope of a topology investigation — the single derivation every
 * producer of host aliases goes through (evidence snapshot and tool results
 * alike, review C8). One topology session is one investigation; a call with
 * no session gets a request-local scope that nothing else can reproduce.
 */
export function topologyAiAliasScope(sessionId: string | null): string {
  return sessionId ? `session:${sessionId}` : `request:${randomUUID()}`;
}

/**
 * Per-investigation aliases: HMAC(derived server key ‖ alias scope). The same
 * value maps to the same alias within one scope and to an unrelated alias in
 * any other; the key never leaves this process. Callers pass a scope from
 * `topologyAiAliasScope`, never a hand-built string.
 */
export function createTopologyAiAliasContext(aliasScope: string): TopologyAiAliasContext {
  const base = getSecretDerivedKeyMaterials(ALIAS_DOMAIN).active.key;
  const key = createHmac('sha256', base).update(`investigation\0${aliasScope}`).digest();
  return {
    alias(kind, value) {
      return `${kind}-${createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex').slice(0, 8)}`;
    },
  };
}
