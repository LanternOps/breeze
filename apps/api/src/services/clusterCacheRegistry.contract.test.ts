import { describe, expect, it, vi } from 'vitest';

/**
 * W05 (#8144): the eight agent hot-path caches are cluster-invalidated, under
 * distinct names. Partner Entitlements W1 (#9907) adds a ninth, hand-registered
 * by services/entitlements.ts (its own TTL cache, not a HotPathTtlCache).
 * #8636 adds eight hand-rolled caches bound through registerClusterInvalidator
 * (the classification lives in __tests__/processLocalCaches.contract.test.ts).
 * A cache that loses `cluster: true`, or two caches that share
 * a name (the later one silently replaces the earlier in the registry), would
 * otherwise only show up as stale config on other API instances.
 */
describe('cluster cache registry contents', () => {
  it('registers exactly the seventeen cluster caches, with no name collision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import('./agentOrgSettingsCache');
    await import('./manifestSigning');
    await import('./unifi/unifiCollectorService');
    await import('./entitlements');
    await import('../oauth/partnerScopePolicy');
    await import('./ipAllowlist');
    await import('./remoteAccessPolicy');
    await import('./llmProviderCatalog');
    await import('./thirdPartyEnrichment');
    await import('./wisp/standingStateTurn');
    await import('./aiModels/gatewayConnectionState');
    await import('./aiKillState');
    const { clusterCacheTargets } = await import('./clusterCacheRegistry');

    expect([...clusterCacheTargets()].map((t) => t.name).sort()).toEqual([
      'ai-gateway-connection-state',
      'ai-kill-state',
      'device-remote-access-policy',
      'llm-provider-catalog',
      'manifest-key-delegations',
      'manifest-trust-keyset',
      'org-agent-update-config',
      'org-helper-legacy-settings',
      'org-pam-fallback',
      'org-policy-probe',
      'org-topology-flags',
      'partner-entitlements',
      'partner-ip-allowlist',
      'partner-oauth-scope-policy',
      'third-party-package-catalog',
      'unifi-agent-collector-absence',
      'wisp-standing-state-facts',
    ]);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('registered twice'))).toEqual([]);
    warn.mockRestore();
  }, 60_000);
});
