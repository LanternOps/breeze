import { z } from 'zod';

import { AI_AGENT_IMPACT_WINDOWS, type AiAgentImpactWindow } from '../types/aiAgentImpact';

// Destructured (not `.map`) so each stays a Zod literal type, not `number` --
// same shape as `impactQuerySchema`, whose surface the measured endpoint matches.
const [WINDOW_7, WINDOW_30, WINDOW_90] = AI_AGENT_IMPACT_WINDOWS;

const measuredWindowSchema: z.ZodType<AiAgentImpactWindow> = z.preprocess(
  (value) => (value === undefined ? WINDOW_30 : Number(value)),
  z.union([z.literal(WINDOW_7), z.literal(WINDOW_30), z.literal(WINDOW_90)]),
);

/**
 * Query for `GET /ai/agents/impact/measured`.
 *
 * `.strict()` on purpose: `through` is always the last **complete** UTC day,
 * computed server-side by `lastCompleteUtcDay()`. A client that supplies one is
 * rejected rather than silently ignored, so nobody can widen the window past the
 * 90-day cap or read a partial day by sending an extra key.
 *
 * `orgId` is optional because `fetchWithAuth` auto-injects `?orgId=` whenever the
 * web org switcher has one org selected.
 */
export const impactMeasuredQuerySchema: z.ZodType<{
  window: AiAgentImpactWindow;
  orgId?: string;
}> = z
  .object({
    window: measuredWindowSchema,
    orgId: z.string().uuid().optional(),
  })
  .strict();
