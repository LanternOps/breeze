import { z } from 'zod';
import {
  AI_AGENT_IMPACT_WINDOWS,
  IMPACT_WEIGHT_KEYS,
  IMPACT_WEIGHT_MAX_SECONDS,
  type AiAgentImpactWindow,
  type ImpactWeightOverrides,
} from '../types/aiAgentImpact';

const impactWeightValue = z.number().int().min(0).max(IMPACT_WEIGHT_MAX_SECONDS);

/** Partial overrides. Strict: an unknown key is a client bug, not a silent no-op. */
export const impactWeightsSchema: z.ZodType<ImpactWeightOverrides> = z.object({
  alertJudged: impactWeightValue.optional(),
  noiseFlagged: impactWeightValue.optional(),
  ticketTriaged: impactWeightValue.optional(),
  draftSent: impactWeightValue.optional(),
  fixExecuted: impactWeightValue.optional(),
  narrativeDelivered: impactWeightValue.optional(),
} satisfies Record<(typeof IMPACT_WEIGHT_KEYS)[number], z.ZodOptional<typeof impactWeightValue>>).strict();

// AI_AGENT_IMPACT_WINDOWS is the source of truth for the accepted values —
// destructured (not `.map`) so each stays a Zod literal type, not `number`.
const [WINDOW_7, WINDOW_30, WINDOW_90] = AI_AGENT_IMPACT_WINDOWS;
const impactWindowSchema: z.ZodType<AiAgentImpactWindow> = z.preprocess(
  (value) => (value === undefined ? WINDOW_30 : Number(value)),
  z.union([z.literal(WINDOW_7), z.literal(WINDOW_30), z.literal(WINDOW_90)]),
);

/**
 * Query for GET /ai/agents/impact. `orgId` is optional because
 * fetchWithAuth auto-injects `?orgId=` whenever the web org switcher has
 * one org selected.
 */
export const impactQuerySchema: z.ZodType<{ window: AiAgentImpactWindow; orgId?: string }> = z.object({
  window: impactWindowSchema,
  orgId: z.string().uuid().optional(),
});

/** Query for POST /ai/agents/impact/rebuild — same optional orgId, no window. */
export const impactRebuildQuerySchema: z.ZodType<{ orgId?: string }> = z.object({
  orgId: z.string().uuid().optional(),
});
