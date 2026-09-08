import { z } from 'zod';
import { AI_OPERATOR_TASK_STATES } from '../types/aiOperator';

/**
 * AI Operator task context carried into `createActionIntent` (#5205 W04,
 * sub-issue #5209).
 *
 * INTERNAL ONLY — this is TRUSTED input. It is the identity under which an
 * operation reserves its `ai_operator_operations` row and from which the
 * intent's `idempotency_key` is derived, so accepting it from an HTTP body
 * would let a caller (a) mint an intent that a task it does not own is then
 * obliged to reconcile, and (b) choose the single ON CONFLICT arbiter's key
 * material directly. Every HTTP intent surface must therefore build its
 * `CreateActionIntentInput` WITHOUT this field; the coordinator (W06) is the
 * only producer.
 *
 * The schema exists so that the one internal seam that does construct it
 * validates shape and bounds at the boundary rather than trusting a
 * hand-built object literal. The `max()` bounds mirror the CHECK constraints
 * on `ai_operator_operations.task_step_key` (128) and `.operation_key` (200)
 * declared in 2026-10-14-100000-ai-operator-thin-slice.sql, so an over-long
 * key is a typed rejection at the seam instead of a 23514 mid-transaction.
 */
export const actionIntentTaskContextSchema = z.object({
  taskId: z.string().uuid(),
  taskStepKey: z.string().min(1).max(128),
  operationKey: z.string().min(1).max(200),
  /**
   * The reasoning attempt this proposal came from. Recorded on the operation
   * row for lineage; it is deliberately NOT part of the operation identity —
   * a continuation run re-proposing the SAME operation must converge on the
   * existing row, which is precisely what makes attempt 2 attach instead of
   * duplicating (spec §6.5).
   */
  attemptOrdinal: z.number().int().min(0),
}).strict();

export type ActionIntentTaskContext = z.infer<typeof actionIntentTaskContextSchema>;

// ---- W07 (#5254): read-side list query ----

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
