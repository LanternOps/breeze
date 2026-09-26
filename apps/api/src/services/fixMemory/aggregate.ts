/**
 * Pure aggregate math for fix memory (AI Suggested Fixes W1).
 *
 * fix_memory is DERIVED: every write replays the counted attempts of one
 * identity from fix_outcomes (store.ts), so this file is the single definition
 * of "counted", "proven", "demoted" and "who owns a fix".
 */
import {
  FIX_PROOF_RULES,
  type FixCountedResult, type FixKind, type FixMemoryStatus, type FixOutcomeState, type FixVote,
} from '@breeze/shared';

export interface CountedAttempt { result: FixCountedResult; vote: FixVote | null; terminalAt: Date }

export interface AggregateSnapshot {
  attempts: number;
  verifiedCount: number;
  failedCount: number;
  recurredCount: number;
  upVotes: number;
  downVotes: number;
  rollingSuccessRate: number;
  consecutiveFailures: number;
  consecutiveVerified: number;
  /** Newest first, capped at FIX_PROOF_RULES.rollingWindow. */
  recentOutcomes: FixCountedResult[];
  status: 'active' | 'demoted';
  lastVerifiedAt: Date | null;
}

/**
 * The counted result of one attempt. A 👎 turns any terminal non-cancelled
 * attempt into a failure (spec: "A 👎 counts as a failure"); a 👍 never
 * upgrades anything. inconclusive/cancelled never count on their own.
 */
export function effectiveResult(state: FixOutcomeState, vote: FixVote | null): FixCountedResult | null {
  switch (state) {
    case 'verified': return vote === 'down' ? 'failed' : 'verified';
    case 'failed': return 'failed';
    case 'recurred': return 'recurred';
    case 'inconclusive': return vote === 'down' ? 'failed' : null;
    default: return null; // cancelled, pending, awaiting_recovery, holding
  }
}

export function replayAggregate(attempts: readonly CountedAttempt[]): AggregateSnapshot {
  const ordered = [...attempts].sort((a, b) => a.terminalAt.getTime() - b.terminalAt.getTime());
  let status: 'active' | 'demoted' = 'active';
  let consecutiveFailures = 0;
  let consecutiveVerified = 0;
  let verifiedCount = 0;
  let failedCount = 0;
  let recurredCount = 0;
  let upVotes = 0;
  let downVotes = 0;
  let lastVerifiedAt: Date | null = null;
  const recent: FixCountedResult[] = [];

  for (const attempt of ordered) {
    if (attempt.vote === 'up') upVotes += 1;
    if (attempt.vote === 'down') downVotes += 1;
    recent.unshift(attempt.result);
    if (recent.length > FIX_PROOF_RULES.rollingWindow) recent.pop();

    if (attempt.result === 'verified') {
      verifiedCount += 1;
      lastVerifiedAt = attempt.terminalAt;
      consecutiveFailures = 0;
      consecutiveVerified += 1;
      if (status === 'demoted' && consecutiveVerified >= FIX_PROOF_RULES.liftDemotionAfterConsecutiveVerified) status = 'active';
    } else if (attempt.result === 'failed') {
      failedCount += 1;
      consecutiveVerified = 0;
      consecutiveFailures += 1;
      if (consecutiveFailures >= FIX_PROOF_RULES.demoteAfterConsecutiveFailures) status = 'demoted';
    } else {
      recurredCount += 1;
      consecutiveVerified = 0;
      consecutiveFailures = 0;
      status = 'demoted';
    }
  }

  const windowVerified = recent.filter((r) => r === 'verified').length;
  return {
    attempts: ordered.length,
    verifiedCount, failedCount, recurredCount, upVotes, downVotes,
    rollingSuccessRate: recent.length === 0 ? 0 : windowVerified / recent.length,
    consecutiveFailures, consecutiveVerified,
    recentOutcomes: recent,
    status,
    lastVerifiedAt,
  };
}

export function isProven(s: {
  status: FixMemoryStatus; stale: boolean; verifiedCount: number; rollingSuccessRate: number; recentOutcomes: readonly string[];
}): boolean {
  if (s.status !== 'active' || s.stale) return false;
  if (s.verifiedCount < FIX_PROOF_RULES.minVerified) return false;
  if (s.rollingSuccessRate < FIX_PROOF_RULES.minSuccessRate) return false;
  return !s.recentOutcomes.slice(0, FIX_PROOF_RULES.noRecurrenceInLast).includes('recurred');
}

export type FixOwner = { orgId: string; partnerId: null } | { orgId: null; partnerId: string };

export interface FixOwnerFacts {
  fixKind: FixKind;
  script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  playbook: { isBuiltIn: boolean; orgId: string | null } | null;
  instructionsRef: string | null;
}

/**
 * Owner rule (spec "Owner rule"), evaluated against the fix's CURRENT
 * ownership — so an org→partner re-scope folds history into the partner row on
 * the next rebuild. null = this attempt contributes to no aggregate.
 */
export function resolveFixOwner(facts: FixOwnerFacts, attempt: { orgId: string; partnerId: string }): FixOwner | null {
  const partnerOwned: FixOwner = { orgId: null, partnerId: attempt.partnerId };
  const orgOwned: FixOwner = { orgId: attempt.orgId, partnerId: null };
  switch (facts.fixKind) {
    case 'system_script':
    case 'partner_script':
    case 'org_script': {
      const s = facts.script;
      if (!s) return null;
      if (s.isSystem) return partnerOwned;
      if (s.orgId === null && s.partnerId === attempt.partnerId) return partnerOwned;
      if (s.orgId === attempt.orgId) return orgOwned;
      return null;
    }
    case 'playbook': {
      const p = facts.playbook;
      if (!p) return null;
      if (p.isBuiltIn) return partnerOwned;
      return p.orgId === attempt.orgId ? orgOwned : null;
    }
    case 'builtin_action':
      return partnerOwned;
    case 'manual_steps':
      // Only REVIEWED generic steps are shareable; AI-written prose never is.
      return facts.instructionsRef ? partnerOwned : null;
  }
}

export function fixKindForScript(script: { isSystem: boolean; orgId: string | null; partnerId: string | null }): 'system_script' | 'partner_script' | 'org_script' {
  if (script.isSystem) return 'system_script';
  if (script.orgId === null && script.partnerId !== null) return 'partner_script';
  return 'org_script';
}

export function fixIdentityFor(input: {
  fixKind: FixKind;
  scriptVersionId?: string | null;
  builtinAction?: string | null;
  playbookId?: string | null;
  instructionsRef?: string | null;
}): string | null {
  switch (input.fixKind) {
    case 'system_script':
    case 'partner_script':
    case 'org_script':
      return input.scriptVersionId ? `script_version:${input.scriptVersionId}` : null;
    case 'builtin_action':
      return input.builtinAction ? `builtin:${input.builtinAction}` : null;
    case 'playbook':
      return input.playbookId ? `playbook:${input.playbookId}` : null;
    case 'manual_steps':
      return input.instructionsRef ? `instructions:${input.instructionsRef}` : null;
  }
}
