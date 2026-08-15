/**
 * Thin recorder seam for runtime-extension observability.
 *
 * The gateway dispatch and the job processor call {@link recordExtensionRequest}
 * / {@link recordExtensionJob} without importing the heavy prom-client registry
 * in `routes/metrics.ts` — that module binds the real recorder here via
 * {@link setExtensionMetricsRecorder} inside its `bindMetricsRecorders()`. This
 * mirrors the anomaly/abuse/backup recorder pattern and keeps the extension
 * runtime free of an import cycle back into the metrics route.
 *
 * Until a recorder is bound (e.g. in a unit test that never imports the metrics
 * route) every call is a no-op, so the gateway/job paths carry zero behavioral
 * change beyond the (bounded) label emission.
 */

export type ExtensionJobOutcome = 'success' | 'failure';

export interface ExtensionMetricsRecorder {
  /**
   * A dispatched extension request completed. `status` drives the error counter;
   * `route` MUST already be a bounded/normalized value (never a raw URL).
   */
  onRequest(extension: string, route: string, status: number, durationSeconds: number): void;
  /** An extension job run finished (or threw). */
  onJob(
    extension: string,
    job: string,
    outcome: ExtensionJobOutcome,
    durationSeconds: number,
  ): void;
}

let recorder: ExtensionMetricsRecorder | null = null;

/** Bind (or clear, with null) the process-wide extension metrics recorder. */
export function setExtensionMetricsRecorder(next: ExtensionMetricsRecorder | null): void {
  recorder = next;
}

export function recordExtensionRequest(
  extension: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  recorder?.onRequest(extension, route, status, durationSeconds);
}

export function recordExtensionJob(
  extension: string,
  job: string,
  outcome: ExtensionJobOutcome,
  durationSeconds: number,
): void {
  recorder?.onJob(extension, job, outcome, durationSeconds);
}
