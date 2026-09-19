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
  help: 'Workspace sandboxes the reaper could not destroy — each is a destroy_failed row and a sandbox we are still paying for. The reaper also captureException()s each one, which is what currently pages; an alert rule on this counter is still to be added.',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

const computeSeconds = new Counter({
  name: 'ai_workspace_compute_seconds_total',
  help: 'Cumulative sandbox wall-clock seconds, by backend and region',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

/**
 * Steps executed, by how they ended (W05). `nonzero` is an ordinary result —
 * the model's script found nothing, or exited 1 on purpose; `timeout` and
 * `error` are the two that mean the box, not the script, is the problem.
 */
const stepsTotal = new Counter({
  name: 'ai_workspace_steps_total',
  help: 'Workspace steps executed, by exit classification',
  labelNames: ['exit'] as const,
  registers: [metricsRegistry],
});

/**
 * Cap refusals (W05, spec §8). Every cap failure is a typed tool error the
 * model can read AND a counter — a cap that fires constantly is a cap set
 * wrong, and without this series the only evidence is buried in run
 * transcripts.
 */
const capHitsTotal = new Counter({
  name: 'ai_workspace_cap_hits_total',
  help: 'Workspace cap refusals, by cap',
  labelNames: ['cap'] as const,
  registers: [metricsRegistry],
});

/**
 * Artifact bytes written, by kind (W05) — the growth signal for the blob bill
 * and the retention sweeper's workload.
 */
const artifactBytesTotal = new Counter({
  name: 'ai_artifacts_bytes_total',
  help: 'Artifact bytes written, by artifact kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

/**
 * Not in spec §10, added by W05 because §5.5's delivery path is otherwise
 * unobservable: `no_session` climbing means results are routinely finishing
 * after the technician's session was evicted, which is the signal that would
 * justify the chat-on-worker follow-on (§13). `session_mismatch` is a bug,
 * not a capacity signal — any non-zero rate there is worth paging on.
 */
const chatDeliveriesTotal = new Counter({
  name: 'ai_workspace_chat_deliveries_total',
  help: 'Analysis run events routed to a chat session, by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export type WorkspaceCap =
  | 'staged_bytes' | 'staged_files' | 'artifact_bytes' | 'artifact_file_bytes'
  | 'collect_files' | 'stdout_bytes' | 'step_timeout' | 'steps_per_run'
  | 'compute_seconds' | 'compute_cents' | 'input_devices' | 'export_rows';

export type ChatRunDeliveryOutcome =
  | 'progress' | 'completed' | 'failed' | 'no_session' | 'run_missing'
  /**
   * The watch's org/session did not match the live session found under that
   * session id — a cross-tenant delivery was refused.
   */
  | 'session_mismatch'
  /**
   * A published event whose payload did not match the shape this consumer
   * expects — contract drift between the producer and the bridge. Like
   * `session_mismatch`, any non-zero rate is a bug, not a capacity signal.
   */
  | 'malformed_payload';

/**
 * Drop a measurement that would poison a counter or histogram for the life of
 * the process. A NaN or an Infinity cannot be un-observed without a restart,
 * and the arithmetic feeding these (a provider's usage response, a byte count
 * off a stream) has real failure modes.
 */
function finite(value: number, allowZero = true): boolean {
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}

export function observeWorkspaceCreateSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  if (!finite(seconds)) return;
  createSeconds.observe(labels, seconds);
}

export function incWorkspaceDestroyFailed(labels: { backend: string; region: string }): void {
  destroyFailed.inc(labels);
}

export function addWorkspaceComputeSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  if (!finite(seconds, false)) return;
  computeSeconds.inc(labels, seconds);
}

export function incWorkspaceStep(exit: 'ok' | 'nonzero' | 'timeout' | 'error'): void {
  stepsTotal.inc({ exit }, 1);
}

export function incWorkspaceCapHit(cap: WorkspaceCap): void {
  capHitsTotal.inc({ cap }, 1);
}

export function incArtifactBytes(kind: string, bytes: number): void {
  if (!finite(bytes, false)) return;
  artifactBytesTotal.inc({ kind }, bytes);
}

export function incChatRunDelivery(outcome: ChatRunDeliveryOutcome): void {
  chatDeliveriesTotal.inc({ outcome }, 1);
}
