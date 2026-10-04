/**
 * AI Suggested Fixes W3 — the proven fixes an AI agent run sees before it
 * investigates. Called from runLoop.loadRunContext, which is already ONE
 * system context: this module opens no context of its own (the ML flag read
 * takes its partner-axis escape only outside system scope), so it never holds
 * a second pooled connection. lookupFixes filters by the run org + its
 * partner and re-checks each script's current owner (W1 Task 16), so the
 * system-scope read cannot surface another tenant's private fix.
 *
 * The projection is deliberately narrow: script name / built-in action, kind,
 * scope label, counts and the last-verified date. No other org's hostnames,
 * alert text, parameters, and never the org-authored reviewed-steps title.
 *
 * NEVER throws: memory is an optimisation, a run must not fail without it.
 */
import type { AiAgentRunProfile, FixKind } from '@breeze/shared';
import { shouldProduceMlOutput } from '../mlFeatureFlags';
import { lookupFixes } from './lookup';
import { signatureForSource, type FixSourceRef } from './signatureLoader';

export interface RunProvenFix {
  scriptName: string | null;
  builtinAction: string | null;
  fixKind: FixKind;
  scope: 'all_clients' | 'this_client';
  verified: number;
  attempts: number;
  lastVerifiedAt: string | null;
}

export interface RunProvenFixes {
  broad: boolean;
  proven: RunProvenFix[];
  similarCount: number;
}

export const RUN_PROVEN_FIX_LIMIT = 3;

/**
 * The run profiles that consult fix memory at context load: the alert verdict
 * and the full alert run. Every other profile — sweep, narrative, patch,
 * design, ticket triage, analysis, and remediation_research (which loads
 * memory through its own research context, W2) — is unchanged. An allowlist,
 * so a future profile starts without memory until it opts in.
 */
const FIX_MEMORY_RUN_PROFILES: ReadonlySet<AiAgentRunProfile> = new Set<AiAgentRunProfile>(['verdict', 'full']);

export function profileConsultsFixMemory(profile: AiAgentRunProfile): boolean {
  return FIX_MEMORY_RUN_PROFILES.has(profile);
}

export async function loadProvenFixesForRun(input: {
  orgId: string;
  partnerId: string;
  alertId: string | null;
  correlationGroupId: string | null;
}): Promise<RunProvenFixes | null> {
  try {
    const ref: FixSourceRef | null = input.correlationGroupId
      ? { kind: 'correlation', correlationGroupId: input.correlationGroupId }
      : input.alertId ? { kind: 'alert', alertId: input.alertId } : null;
    if (!ref) return null;
    if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) return null;
    const resolved = await signatureForSource(ref);
    if (!resolved) return null;
    const result = await lookupFixes({
      orgId: input.orgId, partnerId: input.partnerId, signature: resolved.signature, limit: RUN_PROVEN_FIX_LIMIT,
    });
    if (result.proven.length === 0 && result.similar.length === 0) return null;
    return {
      broad: resolved.signature.broad,
      proven: result.proven.map((fix) => ({
        scriptName: fix.scriptName,
        builtinAction: fix.builtinAction,
        fixKind: fix.fixKind,
        scope: fix.scope,
        verified: fix.verified,
        attempts: fix.attempts,
        lastVerifiedAt: fix.lastVerifiedAt,
      })),
      similarCount: result.similar.length,
    };
  } catch (error) {
    console.error('[fixMemory] proven-fix lookup for an agent run failed; continuing without memory', {
      orgId: input.orgId, alertId: input.alertId, correlationGroupId: input.correlationGroupId, error,
    });
    return null;
  }
}
