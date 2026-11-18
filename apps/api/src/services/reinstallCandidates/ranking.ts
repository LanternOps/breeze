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
 *    uninstall-intent reaper) answering the "possible replacement" question.
 *    Both clear every link to that record across the partner
 *    (clearLinks.ts), so re-raising it on the next report would undo the
 *    answer.
 *
 * index.ts applies the cheap rules (older, silent, not ephemeral, not in a
 * hidden org) in SQL as well, before its per-evidence LIMIT; this function
 * stays the authority and also judges a stored target.
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
  /** The stored target's org, when its row was read. */
  targetOrgId?: string | null;
}

export type FlagDecision =
  | { write: false; why: 'no_candidate' | 'identical' | 'not_better' | 'kept_live_hostname_link' | 'kept_same_org' }
  | { write: true; kind: 'new' | 'upgrade' | 'replace' | 'clear' };

export interface FlagDecisionInput {
  sourceOrgId: string;
  stored: StoredFlag;
  best: { targetDeviceId: string; orgId: string; reason: PossibleReplacementReason } | null;
  /**
   * Why the stored target no longer qualifies: null when it still does,
   * 'missing' when its row is gone. Ignored without a stored flag.
   */
  storedIneligibility: IneligibleReason | 'missing' | null;
}

/**
 * Whether and how to write the source's flag (§7.3 "What it writes"):
 *  - no flag yet and a candidate → `new`;
 *  - the candidate's reason outranks the stored one → `upgrade` (same target
 *    or another);
 *  - the stored target still qualifies → nothing more: never a downgrade,
 *    never an identical rewrite (a daily hardware report on a flagged device
 *    writes and notifies nothing);
 *  - the stored target no longer qualifies:
 *      - a `hostname` link whose target is merely alive is kept: the #2764
 *        collision path flags a hostname collision with a device that is
 *        still online on purpose (a lookalike is exactly what it surfaces);
 *      - a same-org stored flag is never replaced by a cross-org candidate of
 *        the same rank;
 *      - otherwise the best candidate replaces it (`replace`), or, with no
 *        candidate, the stale flag is cleared (`clear`).
 */
export function decideFlagWrite(input: FlagDecisionInput): FlagDecision {
  const { stored, best, sourceOrgId } = input;
  if (!stored.targetDeviceId) return best ? { write: true, kind: 'new' } : { write: false, why: 'no_candidate' };
  if (best && reasonRank(best.reason) > reasonRank(stored.reason)) return { write: true, kind: 'upgrade' };
  if (best && best.targetDeviceId === stored.targetDeviceId) {
    return { write: false, why: reasonRank(best.reason) === reasonRank(stored.reason) ? 'identical' : 'not_better' };
  }
  if (input.storedIneligibility === null) return { write: false, why: best ? 'not_better' : 'no_candidate' };
  if (stored.reason === 'hostname' && input.storedIneligibility === 'alive') {
    return { write: false, why: 'kept_live_hostname_link' };
  }
  if (!best) return { write: true, kind: 'clear' };
  if (
    reasonRank(best.reason) === reasonRank(stored.reason)
    && stored.targetOrgId === sourceOrgId
    && best.orgId !== sourceOrgId
  ) {
    return { write: false, why: 'kept_same_org' };
  }
  return { write: true, kind: 'replace' };
}

/**
 * How long after enrollment a hardware report may still search for reinstall
 * candidates. A reinstall is noticed when the new install enrolls; the first
 * hardware reports follow within minutes (startup) and then daily, which is
 * when a UUID an older enroll could not send arrives. Past this window the
 * device is an established install: a later report must not turn the whole
 * fleet's daily inventory into a retroactive candidate sweep (and alerts on
 * records nobody is reinstalling). Enroll-triggered detection is not gated.
 */
export const HARDWARE_REPORT_DETECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The hardware-report trigger's cheap pre-check (no DB): run the search only
 * for a source enrolled within the detection window, when the report carries
 * hardware evidence and the source does not already hold a hardware-or-better
 * flag, which no hardware report could improve.
 */
export function shouldDetectAfterHardwareReport(
  report: { systemUuid?: string | null; serialNumber?: string | null; manufacturer?: string | null },
  source: { possibleReplacementReason?: string | null; enrolledAt?: Date | null; createdAt?: Date | null },
  now: Date = new Date(),
): boolean {
  const enrolledAt = source.enrolledAt ?? source.createdAt ?? null;
  if (!enrolledAt || now.getTime() - enrolledAt.getTime() > HARDWARE_REPORT_DETECTION_WINDOW_MS) return false;
  const hasEvidence = Boolean(report.systemUuid) || Boolean(report.serialNumber?.trim() && report.manufacturer?.trim());
  if (!hasEvidence) return false;
  return reasonRank(source.possibleReplacementReason) < REASON_RANK.hardware;
}
