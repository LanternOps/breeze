/**
 * #5205 W05 (#5210), spec §11.2 — the AI Operator task outbox's Prometheus
 * series.
 *
 * A LEAF module: `prom-client` plus `./metricsRegistry`, nothing else. Same
 * shape and rationale as `scriptCancellationMetrics.ts` — the only caller,
 * `jobs/aiOperatorTaskOutboxPublisher.ts`, runs in the WORKER role
 * (`BREEZE_ROLE=worker`), a process that never loads `routes/metrics.ts` and
 * whose import closure is asserted never to reach `routes/`
 * (`services/workerEntrypointClosure.contract.test.ts`). Registering here and
 * setting directly (rather than through `backupMetrics.ts`'s
 * settable-recorder indirection, which exists for leaves that cannot import
 * `prom-client` at all) is what makes the series appear in the role that
 * actually produces it — binding it from `routes/metrics.ts` instead would
 * reproduce #4143: the api process publishing a permanent zero while the
 * worker does the actual polling.
 */
import { Gauge } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

/** Unpublished `ai_operator_task_outbox` rows observed at the last publisher tick. */
const outboxUnpublishedGauge = new Gauge({
  name: 'ai_operator_outbox_unpublished',
  help: 'Unpublished ai_operator_task_outbox rows at the last publisher tick',
  registers: [metricsRegistry],
});

/**
 * Age, in seconds, of the oldest unpublished `ai_operator_task_outbox` row at
 * the last publisher tick. 0 when the backlog is empty. A sustained rise past
 * a few multiples of the 5s poll interval means the coordinator is not
 * waking on task-affecting transitions in a timely way (spec §11.2's alert
 * surface, thresholds set during the P3 pilot).
 */
const outboxOldestAgeSecondsGauge = new Gauge({
  name: 'ai_operator_outbox_oldest_age_seconds',
  help: 'Age in seconds of the oldest unpublished ai_operator_task_outbox row at the last publisher tick',
  registers: [metricsRegistry],
});

/** Set both outbox backlog gauges from one publisher-tick scan. */
export function recordAiOperatorOutboxBacklog(unpublishedCount: number, oldestAgeSeconds: number): void {
  outboxUnpublishedGauge.set(unpublishedCount);
  outboxOldestAgeSecondsGauge.set(oldestAgeSeconds);
}
