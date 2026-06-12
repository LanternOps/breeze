/**
 * Per-flow-type copy + detail extraction for the mobile approval surface (#1154).
 *
 * Pure module — no React Native / Expo imports — so it is unit-testable in the
 * Vitest node environment. The UI (ActionHeadline, ApprovalButtons,
 * UacInterceptDetails) reads from here so all flow-type-specific wording lives
 * in one place.
 */

import { resolveApprovalFlowType, type FlowTypeInput } from './approvalFlow';

export interface ApprovalCopy {
  /** Large headline shown by ActionHeadline. */
  headline: string;
  /** Quick-tap approve button label. */
  approveLabel: string;
  /** Hold-to-confirm label (self-approval / recursive). */
  holdLabel: string;
}

/** Defensive, normalised view of a uac_intercept approval's actionArguments. */
export interface UacInterceptDetails {
  exePath: string | null;
  signer: string | null;
  hash: string | null;
  parentProcess: string | null;
  reason: string | null;
  intentSummary: string | null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstStr(...values: unknown[]): string | null {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}

/**
 * Read the uac fields, tolerating both the elevation schema's camelCase names
 * (targetExecutablePath / targetExecutableSigner / …) and a few likely server
 * aliases, so the renderer stays resilient to the exact payload shape the PAM
 * control plane settles on.
 */
export function extractUacDetails(args: Record<string, unknown> | null | undefined): UacInterceptDetails {
  const a = args ?? {};
  return {
    exePath: firstStr(a.targetExecutablePath, a.exePath, a.executablePath),
    signer: firstStr(a.targetExecutableSigner, a.signer, a.targetPublisher, a.publisher),
    hash: firstStr(a.targetExecutableHash, a.hash),
    parentProcess: firstStr(a.parentProcess, a.parentImage),
    reason: firstStr(a.requesterReason, a.reason),
    intentSummary: firstStr(a.intentSummary),
  };
}

/** Basename of a Windows (`\\`) or POSIX (`/`) path. */
export function executableName(exePath: string | null): string | null {
  if (!exePath) return null;
  const parts = exePath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

export interface ApprovalCopyInput extends FlowTypeInput {
  actionLabel: string;
  actionArguments: Record<string, unknown>;
}

export function getApprovalCopy(approval: ApprovalCopyInput): ApprovalCopy {
  if (resolveApprovalFlowType(approval) === 'uac_intercept') {
    const name = executableName(extractUacDetails(approval.actionArguments).exePath);
    return {
      headline: name ? `Allow ${name} to run as admin` : 'Allow admin elevation',
      approveLabel: 'Allow',
      holdLabel: 'Hold to allow',
    };
  }
  return {
    headline: approval.actionLabel,
    approveLabel: 'Approve',
    holdLabel: 'Hold to approve',
  };
}
