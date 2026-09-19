import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { M365SyncOutcome } from './types';

/**
 * Prometheus surface for the tenant-sync engine (spec §7). Same shape as
 * services/retentionMetrics.ts and services/actionIntents/metrics.ts: a
 * settable recorder so services/ and jobs/ emit without importing
 * routes/metrics (which would close an import cycle), plus one
 * `register*` the route calls at startup. Until that call every record* is a
 * silent no-op — importing this module must never be able to fail a boot.
 *
 * Names are UNPREFIXED on purpose (`m365_sync_runs_total`, not
 * `breeze_m365_sync_runs_total`), unlike the neighbouring
 * `breeze_m365_graph_read_actions_total`: the spec and the wave contract pin
 * these exact strings and the runbook/dashboards are written against them.
 */
export type M365SyncItemKind = 'insert' | 'update' | 'stale' | 'unchanged';

export interface M365SyncMetricsRecorder {
  onRun: (domain: M365SyncDomain, outcome: M365SyncOutcome) => void;
  onItems: (domain: M365SyncDomain, kind: M365SyncItemKind, count: number) => void;
  /** `domain` is an M365SyncDomain string; the histogram label is the domain, never the action id. */
  onExecutorSeconds: (domain: string, seconds: number) => void;
  onDueBacklog: (value: number) => void;
  onQueueDepth: (value: number) => void;
  onTickerUtilisation: (value: number) => void;
  onTickerSkipped: () => void;
  onFenced: () => void;
  onLinkAmbiguous: (count: number) => void;
}

const noop = () => {};
const emptyRecorder: M365SyncMetricsRecorder = {
  onRun: noop, onItems: noop, onExecutorSeconds: noop, onDueBacklog: noop,
  onQueueDepth: noop, onTickerUtilisation: noop, onTickerSkipped: noop,
  onFenced: noop, onLinkAmbiguous: noop,
};
let recorder: M365SyncMetricsRecorder = emptyRecorder;

export function setM365SyncMetricsRecorder(
  next: Partial<M365SyncMetricsRecorder> | null | undefined,
): void {
  recorder = { ...emptyRecorder, ...(next ?? {}) };
}

/** A count that arithmetic could have made NaN must not poison a monotonic counter. */
function safeCount(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function recordM365SyncRun(domain: M365SyncDomain, outcome: M365SyncOutcome): void {
  recorder.onRun(domain, outcome);
}
export function recordM365SyncItems(domain: M365SyncDomain, kind: M365SyncItemKind, count: number): void {
  const safe = safeCount(count);
  if (safe === null || safe === 0) return;
  recorder.onItems(domain, kind, safe);
}
export function recordM365SyncExecutorSeconds(domain: string, seconds: number): void {
  const safe = safeCount(seconds);
  if (safe === null) return;
  recorder.onExecutorSeconds(domain, safe);
}
export function setM365SyncDueBacklog(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onDueBacklog(safe);
}
export function setM365SyncQueueDepth(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onQueueDepth(safe);
}
export function setM365SyncTickerUtilisation(value: number): void {
  const safe = safeCount(value);
  if (safe !== null) recorder.onTickerUtilisation(safe);
}
export function recordM365SyncTickerSkipped(): void { recorder.onTickerSkipped(); }
export function recordM365SyncFenced(): void { recorder.onFenced(); }
export function recordM365SyncLinkAmbiguous(count: number): void {
  const safe = safeCount(count);
  if (safe === null || safe === 0) return;
  recorder.onLinkAmbiguous(safe);
}

const RUNS = 'm365_sync_runs_total';
const ITEMS = 'm365_sync_items';
const EXECUTOR_SECONDS = 'm365_sync_executor_seconds';
const DUE_BACKLOG = 'm365_sync_due_backlog';
const QUEUE_DEPTH = 'm365_sync_queue_depth';
const TICKER_UTILISATION = 'm365_sync_ticker_utilisation';
const TICKER_SKIPPED = 'm365_sync_ticker_skipped_total';
const FENCED = 'm365_sync_fenced_total';
const LINK_AMBIGUOUS = 'm365_sync_link_ambiguous_total';

export function registerM365SyncMetrics(registry: Registry): void {
  const runs = (registry.getSingleMetric(RUNS) as Counter<'domain' | 'outcome'> | undefined)
    ?? new Counter({ name: RUNS, help: 'Completed m365 sync-domain runs by domain and outcome', labelNames: ['domain', 'outcome'] as const, registers: [registry] });
  const items = (registry.getSingleMetric(ITEMS) as Counter<'domain' | 'kind'> | undefined)
    ?? new Counter({ name: ITEMS, help: 'Entity rows written by an m365 sync run, by domain and kind (insert|update|stale|unchanged)', labelNames: ['domain', 'kind'] as const, registers: [registry] });
  const executorSeconds = (registry.getSingleMetric(EXECUTOR_SECONDS) as Histogram<'domain'> | undefined)
    ?? new Histogram({ name: EXECUTOR_SECONDS, help: 'Round-trip seconds for one m365 sync executor call, labelled by domain', labelNames: ['domain'] as const, buckets: [0.5, 1, 2.5, 5, 10, 20, 40, 60, 90, 120], registers: [registry] });
  const dueBacklog = (registry.getSingleMetric(DUE_BACKLOG) as Gauge<string> | undefined)
    ?? new Gauge({ name: DUE_BACKLOG, help: 'm365_sync_state rows whose next_sync_at is in the past at the last tick', registers: [registry] });
  const queueDepth = (registry.getSingleMetric(QUEUE_DEPTH) as Gauge<string> | undefined)
    ?? new Gauge({ name: QUEUE_DEPTH, help: 'm365-sync queue depth (waiting+prioritized+delayed+active) at the last tick', registers: [registry] });
  const tickerUtilisation = (registry.getSingleMetric(TICKER_UTILISATION) as Gauge<string> | undefined)
    ?? new Gauge({ name: TICKER_UTILISATION, help: 'Fraction of the tick batch actually claimed at the last tick (spec §5.9 target <= 0.5)', registers: [registry] });
  const tickerSkipped = (registry.getSingleMetric(TICKER_SKIPPED) as Counter<string> | undefined)
    ?? new Counter({ name: TICKER_SKIPPED, help: 'Ticks that exited on backpressure without claiming', registers: [registry] });
  const fenced = (registry.getSingleMetric(FENCED) as Counter<string> | undefined)
    ?? new Counter({ name: FENCED, help: 'Sync results discarded at Phase C because generation/connection/tenant/consent changed', registers: [registry] });
  const linkAmbiguous = (registry.getSingleMetric(LINK_AMBIGUOUS) as Counter<string> | undefined)
    ?? new Counter({ name: LINK_AMBIGUOUS, help: 'Intune device rows skipped during link reconciliation because the match was not 1:1', registers: [registry] });

  setM365SyncMetricsRecorder({
    onRun: (domain, outcome) => runs.labels(domain, outcome).inc(),
    onItems: (domain, kind, count) => items.labels(domain, kind).inc(count),
    onExecutorSeconds: (domain, seconds) => executorSeconds.labels(domain).observe(seconds),
    onDueBacklog: (value) => dueBacklog.set(value),
    onQueueDepth: (value) => queueDepth.set(value),
    onTickerUtilisation: (value) => tickerUtilisation.set(value),
    onTickerSkipped: () => tickerSkipped.inc(),
    onFenced: () => fenced.inc(),
    onLinkAmbiguous: (count) => linkAmbiguous.inc(count),
  });
}
