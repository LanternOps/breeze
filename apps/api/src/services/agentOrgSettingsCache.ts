import { HotPathTtlCache } from './hotPathCache';
import type { AgentUpdateConfig } from '../routes/agents/helpers';
import type { TopologyFlags } from './topology/flags';
import type { PolicyProbeConfigUpdate } from '../routes/agents/schemas';
import type { PamSettings } from '../routes/agents/pamSettings';

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
 * topology bootstrap) rely on the TTL. An org merge re-points automation_policies,
 * so the target org's policy probe can be up to one TTL stale after a merge.
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
  orgHelperSettingsCache.invalidateAroundCommit(orgId);
}

/**
 * #8053 W1a-1 — three per-org reads the heartbeat's shared policy context made
 * on every beat. Filled through `DeferredCacheFills` from inside that SYSTEM
 * context (so a miss costs what the read cost before, and no extra
 * transaction), served for AGENT_ORG_SETTINGS_CACHE_TTL_MS. Keyed by org id,
 * the full scope of each value (the probe also depends on the org's partner,
 * which is a property of the org). Nothing here is secret.
 *
 * Staleness on OTHER API instances is up to one TTL (60 s) — process-local
 * invalidation only until W1b. On the writing instance:
 *   - policy probe (automation_policies rules, org-owned + the partner's
 *     partner-wide): POST /policies/:id/deactivate invalidates — the only
 *     invalidating write today, because no route creates automation_policies
 *     or updates their rules. Any future create/rules-update route must call
 *     invalidateOrgPolicyProbeCache. Partner-wide -> every org.
 *   - helper legacy flag (organizations.settings.helper.enabled):
 *     PATCH /agents/org/:orgId/settings/helper, plus the org/partner settings
 *     routes via invalidateAgentOrgSettingsCaches. It already sits behind the
 *     120 s per-device Redis helper cache.
 *   - PAM org fallback (pam_org_config.uac_interception_enabled): NO route
 *     writes it today. TTL only. A future writer must call
 *     `orgPamFallbackCache.invalidateAroundCommit(orgId)`.
 */
export const orgPolicyProbeCache = new HotPathTtlCache<string, PolicyProbeConfigUpdate | null>({
  name: 'org-policy-probe',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

export const orgHelperSettingsCache = new HotPathTtlCache<string, { enabled: boolean }>({
  name: 'org-helper-legacy-settings',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

export const orgPamFallbackCache = new HotPathTtlCache<string, PamSettings>({
  name: 'org-pam-fallback',
  ttlMs: AGENT_ORG_SETTINGS_CACHE_TTL_MS,
  maxEntries: MAX_ORGS,
});

/** Without an org id (a partner-wide policy changed) every org is dropped. */
export function invalidateOrgPolicyProbeCache(orgId?: string): void {
  orgPolicyProbeCache.invalidateAroundCommit(orgId);
}

export function invalidateOrgHelperSettingsCache(orgId: string): void {
  orgHelperSettingsCache.invalidateAroundCommit(orgId);
}
