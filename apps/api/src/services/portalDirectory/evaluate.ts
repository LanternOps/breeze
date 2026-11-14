// Pure evaluator for a complete directory snapshot (W8, D5/D6/D8c/D9). No I/O.
import type { DirectorySource } from './types';

export type DirectoryObservation =
  | { present: false }
  | { present: true; state: 'enabled' | 'unknown' }
  | { present: true; state: 'disabled'; reason: 'account_disabled' | 'suspended' | 'archived' };

export interface InScopeIdentity {
  identityId: string; portalUserId: string; provider: DirectorySource; subject: string;
  directoryChain: string | null; directorySeenAt: Date | null; directoryAbsentRuns: number;
  directoryAbsentSince: Date | null; directoryLastRunId: string | null; directoryRearmSince: Date | null;
}

export interface EvaluateInput {
  runId: string; chainKey: string; snapshotAt: Date; directoryUserCount: number;
  previous: { evaluatedCount: number | null; suspectCount: number | null };
  identities: InScopeIdentity[];
  observe(subject: string): DirectoryObservation;
}

export interface ObservationUpdate {
  identityId: string; directoryChain: string; directorySeenAt: Date | null;
  directoryAbsentRuns: number; directoryAbsentSince: Date | null;
  directoryLastRunId: string; directoryRearmSince: Date | null;
}

export interface PlannedAction {
  identityId: string; portalUserId: string;
  reason: 'account_disabled' | 'absent' | 'suspended' | 'archived';
}

export type EvaluateResult =
  | { outcome: 'suspect_shrink' }
  | {
      outcome: 'evaluated';
      updates: ObservationUpdate[];
      actions: PlannedAction[];
      /** rearmed identities: listed, never applied */
      reportedOnly: PlannedAction[];
    };

export const SHRINK_RATIO = 0.8;
export const CONFIRM_TOLERANCE = 0.05;
export const ABSENCE_SPACING_MS = 4 * 3600_000;

function isSuspectShrink(input: EvaluateInput): boolean {
  const { evaluatedCount, suspectCount } = input.previous;
  if (evaluatedCount == null) return false;
  if (input.directoryUserCount >= SHRINK_RATIO * evaluatedCount) return false;
  // Below the shrink line: only a second snapshot that agrees with the suspect one is trusted.
  if (suspectCount != null && Math.abs(input.directoryUserCount - suspectCount) <= CONFIRM_TOLERANCE * suspectCount) {
    return false;
  }
  return true;
}

export function evaluateDirectorySnapshot(input: EvaluateInput): EvaluateResult {
  if (isSuspectShrink(input)) return { outcome: 'suspect_shrink' };

  const updates: ObservationUpdate[] = [];
  const actions: PlannedAction[] = [];
  const reportedOnly: PlannedAction[] = [];
  const at = input.snapshotAt.getTime();

  for (const id of input.identities) {
    if (id.directoryLastRunId === input.runId) continue;

    // A chain change resets the observation. rearm_since survives: it is an MSP exemption.
    const reset = id.directoryChain !== input.chainKey;
    let seenAt = reset ? null : id.directorySeenAt;
    let absentRuns = reset ? 0 : id.directoryAbsentRuns;
    let absentSince = reset ? null : id.directoryAbsentSince;
    let rearmSince = id.directoryRearmSince;

    const obs = input.observe(id.subject);
    let planned: PlannedAction | null = null;

    if (obs.present) {
      if (seenAt == null) seenAt = input.snapshotAt;
      absentRuns = 0;
      absentSince = null;
      if (obs.state === 'enabled' && rearmSince != null && at > rearmSince.getTime()) {
        rearmSince = null;
      }
      if (obs.state === 'disabled') {
        planned = { identityId: id.identityId, portalUserId: id.portalUserId, reason: obs.reason };
      }
    } else if (seenAt != null) {
      absentRuns += 1;
      if (absentSince == null) absentSince = input.snapshotAt;
      if (absentRuns >= 2 && at - absentSince.getTime() >= ABSENCE_SPACING_MS) {
        planned = { identityId: id.identityId, portalUserId: id.portalUserId, reason: 'absent' };
      }
    }

    if (planned) (rearmSince != null ? reportedOnly : actions).push(planned);

    updates.push({
      identityId: id.identityId,
      directoryChain: input.chainKey,
      directorySeenAt: seenAt,
      directoryAbsentRuns: absentRuns,
      directoryAbsentSince: absentSince,
      directoryLastRunId: input.runId,
      directoryRearmSince: rearmSince,
    });
  }

  return { outcome: 'evaluated', updates, actions, reportedOnly };
}

export function holdReasonFor(p: {
  affectedAccounts: number; usableIdentities: number; firstInChain: boolean; enforce: boolean;
}): 'threshold' | 'first_enforcement' | null {
  if (!p.enforce) return null;
  const a = p.affectedAccounts;
  const u = p.usableIdentities;
  if ((a >= 3 && a * 10 > u) || a > 25 || (a >= 2 && a * 2 >= u)) return 'threshold';
  if (p.firstInChain && a >= 1) return 'first_enforcement';
  return null;
}
