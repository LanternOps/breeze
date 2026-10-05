/**
 * Server-enforced minimum risk tier per built-in action (AI Suggested Fixes W2).
 * Kept apart from builtinActions.ts so the research persistence path can clamp
 * without importing the command queue.
 */
import type { ResearchBuiltinAction, ResearchRiskTier } from '@breeze/shared';

const RANK: Record<ResearchRiskTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Server-enforced minimum risk per action. `high` routes through elevation approval. */
export const BUILTIN_RISK_FLOOR: Readonly<Record<ResearchBuiltinAction, ResearchRiskTier>> = Object.freeze({
  reboot: 'high',
  kill_process: 'medium',
  restart_service: 'medium',
  disk_cleanup: 'low',
});

export function clampBuiltinRisk(action: ResearchBuiltinAction, requested: ResearchRiskTier): ResearchRiskTier {
  const floor = BUILTIN_RISK_FLOOR[action];
  return RANK[requested] >= RANK[floor] ? requested : floor;
}
