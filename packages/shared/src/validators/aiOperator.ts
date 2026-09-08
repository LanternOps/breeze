import { z } from 'zod';
import { AI_OPERATOR_TASK_STATES } from '../types/aiOperator';

/**
 * Query validator for `GET /ai/operator/tasks` (#5205 W07). Mirrors the
 * shape of the org-wide `GET /ai/agents/runs` query
 * (`apps/api/src/routes/aiAgents.ts`) — keyset `cursor`, clamped `limit`,
 * plus this route's own filters (`deviceId`, `state`).
 */
export const operatorTaskListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  deviceId: z.string().guid().optional(),
  state: z.enum(AI_OPERATOR_TASK_STATES).optional(),
});
export type OperatorTaskListQuery = z.infer<typeof operatorTaskListQuerySchema>;
