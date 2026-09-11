import type { ScriptLanguage } from '@breeze/shared';
import type { ScriptProposalRow } from '../../db/schema';

/**
 * The pinned material for a proposal-backed run (spec §4.5).
 *
 * Deliberately EXCLUDES every lifecycle field — status, intent_id, expiry,
 * decision. Release re-checks those separately and fails with
 * `proposal_not_runnable`; folding them into the digest would make an ordinary,
 * expected state change look like content tampering (`content_changed`) and
 * destroy the distinction the operator needs.
 */
export interface ProposalDispatchSnapshot {
  proposalId: string;
  contentDigest: string;
  language: ScriptLanguage;
  runAs: 'system' | 'user';
  timeoutSeconds: number;
  deviceIds: string[];
  scannerVersion: string;
}

export function proposalDispatchSnapshot(
  proposal: ScriptProposalRow,
  deviceIds: string[],
): ProposalDispatchSnapshot {
  return {
    proposalId: proposal.id,
    contentDigest: proposal.contentDigest,
    language: proposal.language as ScriptLanguage,
    runAs: proposal.runAs,
    timeoutSeconds: proposal.timeoutSeconds,
    // Sorted: the same set of devices in a different argument order is the same
    // effect and must produce the same digest.
    deviceIds: [...deviceIds].sort(),
    scannerVersion: proposal.scannerVersion,
  };
}
