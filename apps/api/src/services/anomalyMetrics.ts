// Thin indirection so request-path / service code can emit anomaly-detection
// signals (launch-readiness CRITICAL #5) without importing `routes/metrics`,
// which pulls in the whole metrics + backup-verification graph and would close
// an import cycle (metrics → backup/verificationService → commandQueue →
// metrics). `routes/metrics` registers the real recorder at startup via
// `setAnomalyMetricsRecorder`; until then these are no-ops.

type AnomalyMetricsRecorder = {
  onFailedLogin: (reason: string, tenantId?: string | null) => void;
  onAgentEnrollment: (result: 'success' | 'denied' | 'error', partnerId?: string | null) => void;
  onCommandDispatch: (type: string, actor: 'user' | 'system', orgId?: string | null) => void;
};

const noop = () => {};

let recorder: AnomalyMetricsRecorder = {
  onFailedLogin: noop,
  onAgentEnrollment: noop,
  onCommandDispatch: noop,
};

export function setAnomalyMetricsRecorder(next: Partial<AnomalyMetricsRecorder> | null | undefined): void {
  recorder = {
    onFailedLogin: next?.onFailedLogin ?? noop,
    onAgentEnrollment: next?.onAgentEnrollment ?? noop,
    onCommandDispatch: next?.onCommandDispatch ?? noop,
  };
}

export function recordFailedLogin(reason: string, tenantId?: string | null): void {
  recorder.onFailedLogin(reason, tenantId);
}

export function recordAgentEnrollment(
  result: 'success' | 'denied' | 'error',
  partnerId?: string | null
): void {
  recorder.onAgentEnrollment(result, partnerId);
}

export function recordCommandDispatch(
  type: string,
  actor: 'user' | 'system',
  orgId?: string | null
): void {
  recorder.onCommandDispatch(type, actor, orgId);
}
