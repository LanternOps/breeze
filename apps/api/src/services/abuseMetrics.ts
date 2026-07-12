// Thin indirection so the abuse-detection sweep job can emit Prometheus
// signals without importing `routes/metrics` directly (mirrors the
// `anomalyMetrics.ts` pattern used for the same reason — see that file's
// header comment for the import-cycle rationale). `routes/metrics` registers
// the real recorder at startup via `setAbuseMetricsRecorder`; until then
// these are no-ops.

type AbuseMetricsRecorder = {
  onSignalFired: (severity: string) => void;
  onSweepRun: (result: 'success' | 'error') => void;
  onAlertDelivery: (channel: string, result: 'success' | 'failure') => void;
};

const noop = () => {};
let recorder: AbuseMetricsRecorder = { onSignalFired: noop, onSweepRun: noop, onAlertDelivery: noop };

export function setAbuseMetricsRecorder(next: Partial<AbuseMetricsRecorder> | null | undefined): void {
  recorder = {
    onSignalFired: next?.onSignalFired ?? noop,
    onSweepRun: next?.onSweepRun ?? noop,
    onAlertDelivery: next?.onAlertDelivery ?? noop,
  };
}

export function recordAbuseSignalFired(severity: string): void {
  recorder.onSignalFired(severity);
}

export function recordAbuseSweepRun(result: 'success' | 'error'): void {
  recorder.onSweepRun(result);
}

export function recordOpsAlertDelivery(channel: string, result: 'success' | 'failure'): void {
  recorder.onAlertDelivery(channel, result);
}
