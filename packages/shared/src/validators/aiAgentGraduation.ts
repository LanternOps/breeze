import { z } from 'zod';
import { AI_AGENT_KINDS } from '../types/aiAgents';

/**
 * Body for the `manage_ai_agents:authorize_supervised_key` Tier-3 four-eyes
 * action intent — the only path that appends a colon key to an org row's
 * `ai_agents.actAssets.supervisedActionKeys` (P2-5, #4192).
 *
 * `opKey` is restricted to the colon form (`tool:action`) deliberately —
 * act-op keys (dot form, e.g. `manage_services.restart`) are outcome
 * evidence, never promotable.
 */
export const promoteSupervisedKeyRequestSchema = z.object({
  orgId: z.string().uuid(),
  kind: z.enum(AI_AGENT_KINDS),
  opKey: z.string().min(3).max(120).regex(/^[a-z0-9_]+:[a-z0-9_]+$/),
}).strict();
export type PromoteSupervisedKeyRequest = z.infer<typeof promoteSupervisedKeyRequestSchema>;
