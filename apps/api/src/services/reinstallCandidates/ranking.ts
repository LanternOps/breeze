/**
 * The pure half of the reinstall candidate search (#8318 §7.3): who qualifies
 * as a target, how candidates rank, which reason a match records, and when a
 * flag is written. No I/O, so every rule is unit-tested directly.
 */
import type { PossibleReplacementReason } from '@breeze/shared';
import { newestDbLivenessSignalAt } from '../deviceReattach/liveness';
import { isHiddenOrgType } from '../unassignedPool/visibility';

/** What matched, strongest first. */
export type ReinstallEvidence = 'system_uuid' | 'serial' | 'hostname';

const EVIDENCE_RANK: Record<ReinstallEvidence, number> = { system_uuid: 0, serial: 1, hostname: 2 };

/** uuid and serial + manufacturer are hardware evidence; a hostname is only a name. */
export function evidenceReason(evidence: ReinstallEvidence): PossibleReplacementReason {
  return evidence === 'hostname' ? 'hostname' : 'hardware';
}

/** tpm > hardware > hostname. A flag is never rewritten with a lower rank for the same target. */
export const REASON_RANK: Record<PossibleReplacementReason, number> = { hostname: 1, hardware: 2, tpm: 3 };

/** A stored reason this code does not know (a newer writer) ranks highest, so it is never overwritten. */
export function reasonRank(reason: string | null | undefined): number {
  if (!reason) return 0;
  return REASON_RANK[reason as PossibleReplacementReason] ?? Number.MAX_SAFE_INTEGER;
}

/** The source device as the qualification rules see it. */
export interface CandidateSource {
  id: string;
  createdAt: Date;
  /** devices.enrolled_at: the instant every target signal must be older than. */
  enrolledAt: Date;
  osType: string | null;
  linkGroupId: string | null;
}

/** A device that matched the source on some evidence. */
export interface CandidateRow {
  id: string;
  orgId: string;
  siteId: string;
  hostname: string;
  osType: string | null;
  orgType: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  watchdogLastSeen: Date | null;
  isEphemeral: boolean;
  linkGroupId: string | null;
  status: string;
  decommissionedAt: Date | null;
}

export type IneligibleReason =
  | 'self'
  | 'not_older'
  | 'alive'
  | 'ephemeral'
  | 'hidden_org'
  | 'retired_source'
  | 'same_link_group'
  | 'decommissioned_after_source';

/**
 * §7.3 "Who qualifies as a target". Returns null when the row qualifies, or
 * the first rule it fails.
 *
 *  - an OLDER record: created before the source;
 *  - silent: its newest DB liveness signal (heartbeat, watchdog) is older than
 *    the source's enrolled_at, or it never reported. The Redis signals and the
 *    10-minute quiet period are the confirm-time gate (§6.5), not a hint rule;
 *  - not ephemeral, not in a hidden org (parked or Quick Support);
 *  - never the source of a confirmed reattach (the ledger);
 *  - not in the source's link group (a multi-boot sibling shares the hardware);
 *  - decommissioned records qualify (the reattach route restores them, #914),
 *    unless they were decommissioned AFTER the source enrolled: retiring the
 *    old record after the new one appeared is the human (or the
 *    uninstall-intent reaper) answering the "possible replacement" question,
 *    and that answer clears the flag, so re-raising it would undo it.
 */
export function targetIneligibility(
  source: CandidateSource,
  target: CandidateRow,
  retiredReattachSource: boolean,
): IneligibleReason | null {
  if (target.id === source.id) return 'self';
  if (!(target.createdAt.getTime() < source.createdAt.getTime())) return 'not_older';
  const newest = newestDbLivenessSignalAt({ lastSeenAt: target.lastSeenAt, watchdogLastSeen: target.watchdogLastSeen });
  if (newest && newest.getTime() >= source.enrolledAt.getTime()) return 'alive';
  if (target.isEphemeral) return 'ephemeral';
  if (isHiddenOrgType(target.orgType)) return 'hidden_org';
  if (retiredReattachSource) return 'retired_source';
  if (source.linkGroupId && target.linkGroupId && source.linkGroupId === target.linkGroupId) return 'same_link_group';
  if (
    target.status === 'decommissioned'
    && target.decommissionedAt
    && target.decommissionedAt.getTime() >= source.enrolledAt.getTime()
  ) {
    return 'decommissioned_after_source';
  }
  return null;
}

export interface RankedCandidate {
  target: CandidateRow;
  evidence: ReinstallEvidence;
  reason: PossibleReplacementReason;
}

/**
 * Rank qualifying candidates: evidence level first (uuid > serial > hostname),
 * then the source's OS first, then the most recently seen; the id breaks ties
 * so the result is deterministic. A target matched on several kinds of
 * evidence is ranked by its strongest. Pure.
 */
export function rankCandidates(
  source: Pick<CandidateSource, 'osType'>,
  matches: ReadonlyArray<{ target: CandidateRow; evidence: ReinstallEvidence }>,
): RankedCandidate[] {
  const best = new Map<string, { target: CandidateRow; evidence: ReinstallEvidence }>();
  for (const match of matches) {
    const current = best.get(match.target.id);
    if (!current || EVIDENCE_RANK[match.evidence] < EVIDENCE_RANK[current.evidence]) best.set(match.target.id, match);
  }
  const sameOs = (row: CandidateRow) => (source.osType && row.osType === source.osType ? 0 : 1);
  const seen = (row: CandidateRow) => row.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...best.values()]
    .sort((a, b) =>
      EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence]
      || sameOs(a.target) - sameOs(b.target)
      || seen(b.target) - seen(a.target)
      || a.target.id.localeCompare(b.target.id))
    .map((match) => ({ ...match, reason: evidenceReason(match.evidence) }));
}

export interface StoredFlag {
  targetDeviceId: string | null;
  reason: string | null;
}

export type FlagDecision =
  | { write: false; why: 'no_candidate' | 'identical' | 'not_better' }
  | { write: true; kind: 'new' | 'upgrade' | 'replace' };

/**
 * Whether to write the best candidate onto the source (§7.3 "What it writes"):
 *  - no flag yet → write (`new`);
 *  - the candidate's reason outranks the stored one → write (`upgrade`), for
 *    the same target or a different one;
 *  - a different target, and the stored one no longer qualifies → write
 *    (`replace`): the stored flag is stale;
 *  - otherwise nothing: never a downgrade, never an identical rewrite (a daily
 *    hardware report on a flagged device writes and notifies nothing).
 */
export function decideFlagWrite(
  stored: StoredFlag,
  best: { targetDeviceId: string; reason: PossibleReplacementReason } | null,
  storedTargetQualifies: boolean,
): FlagDecision {
  if (!best) return { write: false, why: 'no_candidate' };
  if (!stored.targetDeviceId) return { write: true, kind: 'new' };
  if (reasonRank(best.reason) > reasonRank(stored.reason)) return { write: true, kind: 'upgrade' };
  if (stored.targetDeviceId === best.targetDeviceId) {
    return { write: false, why: reasonRank(best.reason) === reasonRank(stored.reason) ? 'identical' : 'not_better' };
  }
  if (!storedTargetQualifies) return { write: true, kind: 'replace' };
  return { write: false, why: 'not_better' };
}

/**
 * The hardware-report trigger's cheap pre-check (no DB): run the search only
 * when the report carries hardware evidence and the source does not already
 * hold a hardware-or-better flag, which no hardware report could improve.
 */
export function shouldDetectAfterHardwareReport(
  report: { systemUuid?: string | null; serialNumber?: string | null; manufacturer?: string | null },
  source: { possibleReplacementReason?: string | null },
): boolean {
  const hasEvidence = Boolean(report.systemUuid) || Boolean(report.serialNumber?.trim() && report.manufacturer?.trim());
  if (!hasEvidence) return false;
  return reasonRank(source.possibleReplacementReason) < REASON_RANK.hardware;
}
