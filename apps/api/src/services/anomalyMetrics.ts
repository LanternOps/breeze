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
  onAuthenticatorL4Basis: (basis: string, outcome: AuthenticatorL4Outcome) => void;
};

/**
 * #1374 outcome vocabulary for a critical-tier (L4) assurance decision.
 *  - `allowed`    — the device's platform_bound_basis is trusted for L4.
 *  - `denied`     — untrusted basis AND enforcement is on: the approval is refused.
 *  - `would_deny` — untrusted basis but BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED
 *                   is off, so the approval went through. This is what makes the
 *                   blast radius of the flag measurable BEFORE it is flipped.
 */
export type AuthenticatorL4Outcome = 'allowed' | 'denied' | 'would_deny';

const noop = () => {};

let recorder: AnomalyMetricsRecorder = {
  onFailedLogin: noop,
  onAgentEnrollment: noop,
  onCommandDispatch: noop,
  onAuthenticatorL4Basis: noop,
};

export function setAnomalyMetricsRecorder(next: Partial<AnomalyMetricsRecorder> | null | undefined): void {
  recorder = {
    onFailedLogin: next?.onFailedLogin ?? noop,
    onAgentEnrollment: next?.onAgentEnrollment ?? noop,
    onCommandDispatch: next?.onCommandDispatch ?? noop,
    onAuthenticatorL4Basis: next?.onAuthenticatorL4Basis ?? noop,
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

/**
 * #1374 — every critical-tier (L4) assurance decision, labelled by the approver
 * device's `platform_bound_basis`. Emitted on ALL three exits (allowed, denied,
 * would_deny) so the gate's effect is observable whether or not
 * BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED is on.
 */
export function recordAuthenticatorL4Basis(basis: string, outcome: AuthenticatorL4Outcome): void {
  recorder.onAuthenticatorL4Basis(basis, outcome);
}
