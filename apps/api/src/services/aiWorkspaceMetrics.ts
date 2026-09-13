/**
 * AI execution-plane workspace metrics (spec §10).
 *
 * A LEAF module by construction — it imports `metricsRegistry` and nothing
 * else — so the worker role can serve /metrics without pulling the
 * route/db/service graph in behind it. `workerEntrypointClosure.contract.
 * test.ts` enforces that invariant mechanically; see
 * aiOperatorCoordinatorMetrics.ts for the same pattern and the same reason.
 *
 * Names are used verbatim from spec §10, unprefixed, matching the
 * `ai_operator_*` family already on this registry.
 */
import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

const createSeconds = new Histogram({
  name: 'ai_workspace_create_seconds',
  help: 'Wall time to create an AI workspace sandbox, by backend and region',
  labelNames: ['backend', 'region'] as const,
  // A cold Firecracker boot is seconds, not milliseconds; the interesting
  // question is "did it cross 30s and blow the run's wall clock".
  buckets: [1, 2, 5, 10, 20, 30, 60, 120],
  registers: [metricsRegistry],
});

const destroyFailed = new Counter({
  name: 'ai_workspace_destroy_failed_total',
  help: 'Workspace sandboxes the reaper could not destroy (each one is a paged destroy_failed row and a billing sandbox we are still paying for)',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

const computeSeconds = new Counter({
  name: 'ai_workspace_compute_seconds_total',
  help: 'Cumulative sandbox wall-clock seconds, by backend and region',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

export function observeWorkspaceCreateSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  createSeconds.observe(labels, seconds);
}

export function incWorkspaceDestroyFailed(labels: { backend: string; region: string }): void {
  destroyFailed.inc(labels);
}

export function addWorkspaceComputeSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  computeSeconds.inc(labels, seconds);
}
