/**
 * The chat / agent model choice (AI model registry W05, #7603). A choice is
 * always an OFFERING id — never a free-form model id (spec §12 "Cost abuse").
 * Leaf module: zod only.
 */
import { z } from 'zod';
import { offeringOptionsSchema } from './aiModelOptions';

export const aiModelChoiceSchema = z.object({
  offeringId: z.string().uuid(),
  /** Absent keys follow the assignment, then the offering default (spec §7). */
  options: offeringOptionsSchema.partial().optional(),
}).strict();
export type AiModelChoice = z.infer<typeof aiModelChoiceSchema>;

export const chatModelChoicesQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
}).strict().refine((q) => !(q.sessionId && q.orgId), {
  message: 'Pass a session or an organization, not both.',
});

export const agentModelChoicesQuerySchema = z.object({
  /** Absent = a partner-wide agent (partner scope only). */
  orgId: z.string().uuid().optional(),
}).strict();

export const continueAiSessionSchema = z.object({
  model: aiModelChoiceSchema,
}).strict();
export type ContinueAiSessionInput = z.infer<typeof continueAiSessionSchema>;

/**
 * What ran the last turn, as persisted on ai_sessions.last_turn_model (Task 9).
 * Mirrors the AiTurnModel type in ../types/aiModelChoices.ts; a stored value
 * that fails to parse is treated as absent.
 */
export const aiTurnModelSchema = z.object({
  requestedModel: z.string(),
  requestedDisplayName: z.string(),
  servedModel: z.string(),
  servedDisplayName: z.string(),
  fallbackUsed: z.boolean(),
  appliedOptions: offeringOptionsSchema,
  fastDowngraded: z.boolean(),
}).strict();
