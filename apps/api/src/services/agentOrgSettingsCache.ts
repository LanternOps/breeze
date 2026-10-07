import { HotPathTtlCache } from './hotPathCache';
import type { AgentUpdateConfig } from '../routes/agents/helpers';
import type { TopologyFlags } from './topology/flags';

/**
 * #8053 — per-org values the agent heartbeat resolves on every beat from the
 * org's and its partner's `settings` JSONB. Before this cache each one cost a
 * transaction per agent per beat; with it, one per org per TTL per process.
 *
 * Both are keyed by org id ALONE, which is the full scope of the value: each
 * is derived from exactly that org's row and its own partner's row. Nothing
 * here is secret.
 *
 * Staleness: a settings change reaches an org's agents up to one TTL later
 * than before on other API instances (and an agent only learns of it at its
 * next 60 s beat in any case). The org/partner settings routes in
 * routes/orgs.ts invalidate this process at once. Other writers of
 * `organizations.settings` / `partners.settings` (imports, onboarding, the
 * topology bootstrap) rely on the TTL.
 *
 * The loaders live with their resolvers (`getOrgAgentUpdateConfigCached` in
 * routes/agents/helpers.ts, `loadAgentTopologyFlags` in
 * services/topology/flags.ts); this module only owns the cache instances so a
 * writer can invalidate them without importing the heartbeat's module graph.
 */
export const AGENT_ORG_SETTINGS_CACHE_TTL_MS = 60_000;

// Comfortably above any realistic org count per process; past it the oldest
// org is evicted and simply reloads on its next beat.
const MAX_ORGS = 20_000;

export const orgAgentUpdateConfigCache = new HotPathTtlCache<string, AgentUpdateConfig>({
  name: 'org-agent-update-config',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

export const orgTopologyFlagsCache = new HotPathTtlCache<string, TopologyFlags>({
  name: 'org-topology-flags',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

/**
 * Drop the cached per-org agent settings on this process, now and again once
 * the caller's transaction settles (writers call this before their COMMIT).
 * Without an org id every org is dropped — the right call after a PARTNER
 * settings change, which feeds every org under that partner.
 */
export function invalidateAgentOrgSettingsCaches(orgId?: string): void {
  orgAgentUpdateConfigCache.invalidateAroundCommit(orgId);
  orgTopologyFlagsCache.invalidateAroundCommit(orgId);
}
