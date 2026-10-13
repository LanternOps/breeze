/**
 * Prometheus series for the hot-path caches and their cluster invalidation
 * bus (W05, #8144).
 *
 * LEAF: `prom-client` and `metricsRegistry` are the only imports. Series are
 * registered at module scope on the shared registry, so `routes/metrics.ts`
 * renders them without being edited, and `worker.ts`'s import closure stays
 * free of `routes/` (`workerEntrypointClosure.contract.test.ts`).
 *
 * Label values come only from registered cache names, `unknown`, or the fixed
 * enums below — never from a message body.
 */
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export type LookupResult = 'hit' | 'miss' | 'bypass';
export type PublishOutcome = 'published' | 'unavailable' | 'failed';
export type ReceiveResult = 'applied' | 'self' | 'unknown_cache' | 'malformed';

// `getSingleMetric ?? new` keeps a vi.resetModules() re-import from throwing
// "metric already registered" (same guard as middleware/agentAuthNegativeCache.ts).
function existing<T>(name: string): T | undefined {
  return metricsRegistry.getSingleMetric(name) as T | undefined;
}

const lookups: Counter<'cache' | 'result'> =
  existing<Counter<'cache' | 'result'>>('breeze_hot_path_cache_lookups_total')
  ?? new Counter({
    name: 'breeze_hot_path_cache_lookups_total',
    help: 'Hot-path cache lookups by result (hit, miss, bypass inside a DB context)',
    labelNames: ['cache', 'result'],
    registers: [metricsRegistry],
  });

const sizeSources = new Map<string, () => number>();
if (!existing('breeze_hot_path_cache_entries')) {
  new Gauge({
    name: 'breeze_hot_path_cache_entries',
    help: 'Entries currently held per hot-path cache',
    labelNames: ['cache'],
    registers: [metricsRegistry],
    collect() {
      this.reset();
      for (const [cache, size] of sizeSources) this.set({ cache }, size());
    },
  });
}

const published: Counter<'cache' | 'outcome'> =
  existing<Counter<'cache' | 'outcome'>>('breeze_cluster_cache_invalidations_published_total')
  ?? new Counter({
    name: 'breeze_cluster_cache_invalidations_published_total',
    help: 'Cluster cache invalidations published, by outcome',
    labelNames: ['cache', 'outcome'],
    registers: [metricsRegistry],
  });

const received: Counter<'cache' | 'result'> =
  existing<Counter<'cache' | 'result'>>('breeze_cluster_cache_invalidations_received_total')
  ?? new Counter({
    name: 'breeze_cluster_cache_invalidations_received_total',
    help: 'Cluster cache invalidation messages handled, by result',
    labelNames: ['cache', 'result'],
    registers: [metricsRegistry],
  });

const lag: Histogram<'cache'> =
  existing<Histogram<'cache'>>('breeze_cluster_cache_invalidation_lag_seconds')
  ?? new Histogram({
    name: 'breeze_cluster_cache_invalidation_lag_seconds',
    help: 'Publish-to-apply lag of cluster cache invalidations',
    labelNames: ['cache'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metricsRegistry],
  });

const subscriberUp: Gauge =
  existing<Gauge>('breeze_cluster_cache_subscriber_up')
  ?? new Gauge({
    name: 'breeze_cluster_cache_subscriber_up',
    help: '1 while this process is subscribed to cluster cache invalidations',
    registers: [metricsRegistry],
  });

const resyncs: Counter =
  existing<Counter>('breeze_cluster_cache_resyncs_total')
  ?? new Counter({
    name: 'breeze_cluster_cache_resyncs_total',
    help: 'Full local cache clears after a subscriber reconnect',
    registers: [metricsRegistry],
  });

export function recordCacheLookup(cache: string, result: LookupResult): void {
  lookups.inc({ cache, result });
}
export function recordInvalidationPublished(cache: string, outcome: PublishOutcome): void {
  published.inc({ cache, outcome });
}
export function recordInvalidationReceived(cache: string, result: ReceiveResult): void {
  received.inc({ cache, result });
}
/** Cross-host clock skew can make the lag negative; it is clamped to 0. */
export function recordInvalidationLag(cache: string, seconds: number): void {
  lag.observe({ cache }, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
}
export function setSubscriberUp(up: boolean): void {
  subscriberUp.set(up ? 1 : 0);
}
export function recordResync(): void {
  resyncs.inc();
}
/** Read at scrape time. A later registration under the same name replaces the earlier one. */
export function registerCacheSizeSource(cache: string, size: () => number): void {
  sizeSources.set(cache, size);
}
