import type { AiDenialReason } from './aiCostTracker';

/**
 * Machine-readable codes a client may switch on when the credit / plan gate
 * refuses an AI request. Deliberately narrower than {@link AiDenialReason}:
 * only denials the user can act on from the UI are coded (buy credits, change
 * plan); spend caps and the tenant's own "AI off" setting keep the plain
 * message. Lives in its own module so route tests that mock aiCostTracker
 * wholesale still get the real mapping.
 */
export type AiDenialClientCode = 'credits_exhausted' | 'plan_not_eligible';

export function aiDenialClientCode(reason: AiDenialReason): AiDenialClientCode | undefined {
  if (reason === 'credits_exhausted') return 'credits_exhausted';
  if (reason === 'plan_gate') return 'plan_not_eligible';
  return undefined;
}

/** The JSON error body for a gate denial: `{ error }` plus `code` when coded. */
export function aiDenialBody(denial: { message: string; reason: AiDenialReason }): { error: string; code?: AiDenialClientCode } {
  const code = aiDenialClientCode(denial.reason);
  return code ? { error: denial.message, code } : { error: denial.message };
}
