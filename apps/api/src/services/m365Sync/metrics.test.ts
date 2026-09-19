import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import {
  recordM365SyncFenced, recordM365SyncItems, recordM365SyncRun, recordM365SyncTickerSkipped,
  registerM365SyncMetrics, setM365SyncDueBacklog, setM365SyncMetricsRecorder,
  setM365SyncQueueDepth, setM365SyncTickerUtilisation, recordM365SyncExecutorSeconds,
  recordM365SyncLinkAmbiguous,
} from './metrics';

describe('m365 sync metrics (spec §7)', () => {
  beforeEach(() => setM365SyncMetricsRecorder(null));

  it('is a silent no-op before registration, so importing the module cannot throw at boot', () => {
    expect(() => {
      recordM365SyncRun('users', 'success');
      recordM365SyncItems('users', 'insert', 5);
      setM365SyncDueBacklog(3);
      recordM365SyncFenced();
      recordM365SyncLinkAmbiguous(2);
    }).not.toThrow();
  });

  it('registers exactly the nine contract series under their exact names', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name).sort();
    expect(names).toEqual([
      'm365_sync_due_backlog',
      'm365_sync_executor_seconds',
      'm365_sync_fenced_total',
      'm365_sync_items',
      'm365_sync_link_ambiguous_total',
      'm365_sync_queue_depth',
      'm365_sync_runs_total',
      'm365_sync_ticker_skipped_total',
      'm365_sync_ticker_utilisation',
    ]);
  });

  it('is idempotent: registering twice against the same registry does not throw', () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    expect(() => registerM365SyncMetrics(registry)).not.toThrow();
  });

  it('labels runs by domain and outcome, and items by domain and kind', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncRun('intune_devices', 'partial');
    recordM365SyncItems('intune_devices', 'stale', 7);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_runs_total{domain="intune_devices",outcome="partial"} 1');
    expect(scrape).toContain('m365_sync_items{domain="intune_devices",kind="stale"} 7');
  });

  it('publishes the gauges as SET values, not increments', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    setM365SyncQueueDepth(11);
    setM365SyncQueueDepth(4);
    setM365SyncTickerUtilisation(0.25);
    setM365SyncDueBacklog(120);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_queue_depth 4');
    expect(scrape).toContain('m365_sync_ticker_utilisation 0.25');
    expect(scrape).toContain('m365_sync_due_backlog 120');
  });

  it('observes executor latency into a histogram labelled by DOMAIN, so it joins m365_sync_runs_total', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncExecutorSeconds('users', 2.5);
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_executor_seconds_count{domain="users"} 1');
    // An action id would split the series away from every other m365_sync_*
    // metric, which are all labelled by domain.
    expect(scrape).not.toContain('domain="m365.sync.users"');
  });

  it('drops a non-finite or negative count rather than poisoning a counter', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncItems('users', 'insert', Number.NaN);
    recordM365SyncItems('users', 'insert', -3);
    recordM365SyncItems('users', 'insert', 2);
    expect(await registry.metrics()).toContain('m365_sync_items{domain="users",kind="insert"} 2');
  });

  it('counts ticker skips and fences', async () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    recordM365SyncTickerSkipped();
    recordM365SyncFenced();
    recordM365SyncFenced();
    const scrape = await registry.metrics();
    expect(scrape).toContain('m365_sync_ticker_skipped_total 1');
    expect(scrape).toContain('m365_sync_fenced_total 2');
  });

  /**
   * The nine sync series are UNPREFIXED on purpose, departing from the
   * neighbouring `breeze_m365_graph_read_actions_total`: the shared interface
   * contract and spec §7 both pin the bare names, and W04's plan (decision 9)
   * records that choice. The positive "is it registered" assertions live in
   * the cases above; this one is the guard against a later hand adding the
   * house prefix to some of them, which would leave the dashboards and alert
   * rules pointing at a series that no longer exists.
   */
  it('registers no breeze_-prefixed twin of any sync series', () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);

    for (const name of [
      'm365_sync_runs_total',
      'm365_sync_items',
      'm365_sync_executor_seconds',
      'm365_sync_due_backlog',
      'm365_sync_queue_depth',
      'm365_sync_ticker_utilisation',
      'm365_sync_ticker_skipped_total',
      'm365_sync_fenced_total',
      'm365_sync_link_ambiguous_total',
    ]) {
      expect(registry.getSingleMetric(name), `${name} is not registered`).toBeDefined();
      expect(
        registry.getSingleMetric(`breeze_${name}`),
        `${name} must stay unprefixed (contract + spec §7); found a breeze_ twin`,
      ).toBeUndefined();
    }
  });
});
