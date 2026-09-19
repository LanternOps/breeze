/**
 * Approval flow-type discriminant for the mobile approval surface (#1154,
 * extended #5612 W03 for AI script proposals).
 *
 * Pure module — no React Native / Expo imports — so it is unit-testable in the
 * Vitest node environment, mirroring authOutcome.ts / decisionTarget.ts.
 *
 * A `uac_intercept` approval is a PAM elevation: an end user hit a Windows UAC
 * prompt and the agent surfaced it for human approval. It carries executable
 * metadata (path / signer / hash / parent / reason) in actionArguments and gets
 * its own headline + a structured detail renderer instead of the generic JSON
 * dump.
 *
 * A `script_proposal` approval is a `run_script` call whose arguments name an
 * AI-authored proposal (`proposalId`) rather than a library script id — see
 * `extractProposalId`. It gets the structured `ScriptProposalDetails` card
 * (goal, reviewer findings, STRICT-pattern acknowledgement, script body)
 * instead of the generic JSON dump. A library `run_script` call (no
 * `proposalId`) stays on the `standard` renderer.
 *
 * Everything else is `standard` and keeps the existing behaviour.
 */

export type ApprovalFlowType = 'uac_intercept' | 'script_proposal' | 'standard';

/** Tool name the PAM control plane stamps on a UAC-intercept elevation approval. */
export const UAC_INTERCEPT_TOOL = 'uac_intercept';

/** Tool name for a script run — only a `script_proposal` flow when its
 *  arguments name a proposal (see {@link extractProposalId}). */
export const RUN_SCRIPT_TOOL = 'run_script';

export interface FlowTypeInput {
  /**
   * Server-issued flow_type. Preferred when present so the discriminant is a
   * forward-compatible contract rather than a coincidence of the tool name.
   */
  flowType?: string | null;
  /** Fallback discriminant: the approval's tool name. */
  actionToolName: string;
  /**
   * W03: a `run_script` approval is only a PROPOSAL approval when the
   * arguments name one (`proposalId`). A library run (`scriptId`) keeps the
   * standard renderer. Optional so existing callers/tests that only care
   * about `uac_intercept` need not supply it.
   */
  actionArguments?: Record<string, unknown> | null;
}

/** Reads a string `proposalId` out of a `run_script` approval's arguments.
 *  Anything else (missing, non-string, empty) is "no proposal here". */
export function extractProposalId(args: Record<string, unknown> | null | undefined): string | null {
  const value = args?.proposalId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveApprovalFlowType(input: FlowTypeInput): ApprovalFlowType {
  const explicit = input.flowType?.trim();
  if (explicit) {
    if (explicit === UAC_INTERCEPT_TOOL) return 'uac_intercept';
    if (explicit === RUN_SCRIPT_TOOL && extractProposalId(input.actionArguments)) return 'script_proposal';
    return 'standard';
  }
  if (input.actionToolName === UAC_INTERCEPT_TOOL) return 'uac_intercept';
  if (input.actionToolName === RUN_SCRIPT_TOOL && extractProposalId(input.actionArguments)) return 'script_proposal';
  return 'standard';
}
