import { describe, expect, it, vi } from 'vitest';

/**
 * W05 (#8144): the eight agent hot-path caches are cluster-invalidated, under
 * distinct names. A cache that loses `cluster: true`, or two caches that share
 * a name (the later one silently replaces the earlier in the registry), would
 * otherwise only show up as stale config on other API instances.
 */
describe('cluster cache registry contents', () => {
  it('registers exactly the eight hot-path caches, with no name collision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import('./agentOrgSettingsCache');
    await import('./manifestSigning');
    await import('./unifi/unifiCollectorService');
    const { clusterCacheTargets } = await import('./clusterCacheRegistry');

    expect([...clusterCacheTargets()].map((t) => t.name).sort()).toEqual([
      'manifest-key-delegations',
      'manifest-trust-keyset',
      'org-agent-update-config',
      'org-helper-legacy-settings',
      'org-pam-fallback',
      'org-policy-probe',
      'org-topology-flags',
      'unifi-agent-collector-absence',
    ]);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('registered twice'))).toEqual([]);
    warn.mockRestore();
  }, 60_000);
});
