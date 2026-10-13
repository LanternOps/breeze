import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import {
  recordCacheLookup,
  recordInvalidationPublished,
  recordInvalidationReceived,
  recordInvalidationLag,
  setSubscriberUp,
  recordResync,
  registerCacheSizeSource,
} from './clusterCacheMetrics';

describe('clusterCacheMetrics (#8144)', () => {
  it('registers every series on the shared registry', async () => {
    recordCacheLookup('org-topology-flags', 'hit');
    recordInvalidationPublished('org-topology-flags', 'published');
    recordInvalidationReceived('org-topology-flags', 'applied');
    recordInvalidationLag('org-topology-flags', 0.02);
    setSubscriberUp(true);
    recordResync();
    registerCacheSizeSource('org-topology-flags', () => 7);
    const text = await metricsRegistry.metrics();
    for (const name of [
      'breeze_hot_path_cache_lookups_total',
      'breeze_hot_path_cache_entries',
      'breeze_cluster_cache_invalidations_published_total',
      'breeze_cluster_cache_invalidations_received_total',
      'breeze_cluster_cache_invalidation_lag_seconds',
      'breeze_cluster_cache_subscriber_up',
      'breeze_cluster_cache_resyncs_total',
    ]) expect(text).toContain(name);
    expect(text).toContain('breeze_hot_path_cache_entries{cache="org-topology-flags"} 7');
    expect(text).toContain('breeze_cluster_cache_subscriber_up 1');
  });

  it('clamps a negative lag (clock skew) to zero instead of throwing', async () => {
    recordInvalidationLag('clamp-test', -3);
    const text = await metricsRegistry.getSingleMetricAsString('breeze_cluster_cache_invalidation_lag_seconds');
    expect(text).toContain('breeze_cluster_cache_invalidation_lag_seconds_sum{cache="clamp-test"} 0');
  });
});
