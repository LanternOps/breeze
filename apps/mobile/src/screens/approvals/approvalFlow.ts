/**
 * Approval flow-type discriminant for the mobile approval surface (#1154).
 *
 * Pure module — no React Native / Expo imports — so it is unit-testable in the
 * Vitest node environment, mirroring authOutcome.ts / decisionTarget.ts.
 *
 * A `uac_intercept` approval is a PAM elevation: an end user hit a Windows UAC
 * prompt and the agent surfaced it for human approval. It carries executable
 * metadata (path / signer / hash / parent / reason) in actionArguments and gets
 * its own headline + a structured detail renderer instead of the generic JSON
 * dump. Everything else is `standard` and keeps the existing behaviour.
 */

export type ApprovalFlowType = 'uac_intercept' | 'standard';

/** Tool name the PAM control plane stamps on a UAC-intercept elevation approval. */
export const UAC_INTERCEPT_TOOL = 'uac_intercept';

export interface FlowTypeInput {
  /**
   * Server-issued flow_type. Preferred when present so the discriminant is a
   * forward-compatible contract rather than a coincidence of the tool name.
   */
  flowType?: string | null;
  /** Fallback discriminant: the approval's tool name. */
  actionToolName: string;
}

export function resolveApprovalFlowType(input: FlowTypeInput): ApprovalFlowType {
  const explicit = input.flowType?.trim();
  if (explicit) {
    return explicit === UAC_INTERCEPT_TOOL ? 'uac_intercept' : 'standard';
  }
  return input.actionToolName === UAC_INTERCEPT_TOOL ? 'uac_intercept' : 'standard';
}
