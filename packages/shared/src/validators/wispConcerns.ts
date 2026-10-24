/**
 * Wisp triage engine (W05, feature #9906) — Zod for the concern/watch route
 * bodies, the chat tools (`list_concerns`, `raise_concern`, `snooze_concern`,
 * `resolve_concern`, `create_watch`) and the assessment outcome tools
 * (`record_concern`, `update_concern`, `nudge`, `propose_action`,
 * `request_specialist` — wired by W05b).
 *
 * `raiseConcernSchema` is the run-side (`record_concern`) input; the chat tool
 * `raise_concern` uses `raiseConcernChatSchema` (w00 A25: subject kinds
 * narrowed, explicit `orgId`). The two tool names differ because
 * `createBreezeMcpServer` refuses an outcome tool whose name is a TOOL_TIERS key.
 */
import { z } from 'zod';
import {
  CHAT_RAISE_CONCERN_SUBJECT_KINDS,
  CONCERN_EVIDENCE_MAX_BYTES,
  CONCERN_EVIDENCE_MAX_KEYS,
  CONCERN_OUTCOME_MAX,
  CONCERN_SEVERITIES,
  CONCERN_SNOOZE_MAX_DAYS,
  CONCERN_STATUSES,
  CONCERN_SUBJECT_KINDS,
  CONCERN_SUMMARY_MAX,
  WATCH_CADENCE_MAX_MINUTES,
  WATCH_CADENCE_MIN_MINUTES,
  WATCH_KINDS,
  WATCH_PARAMS_MAX_BYTES,
  WATCH_PARAMS_MAX_KEYS,
} from '../types/wispConcerns';

const jsonBytes = (o: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(o)).length;
  } catch {
    return Number.POSITIVE_INFINITY; // not JSON-serialisable (cycle, BigInt): refuse
  }
};

const boundedObject = (maxKeys: number, maxBytes: number) =>
  z.record(z.string(), z.unknown())
    .refine((o) => Object.keys(o).length <= maxKeys, { message: `at most ${maxKeys} keys` })
    .refine((o) => jsonBytes(o) <= maxBytes, { message: `at most ${maxBytes} bytes of JSON` });

const evidenceSchema = boundedObject(CONCERN_EVIDENCE_MAX_KEYS, CONCERN_EVIDENCE_MAX_BYTES);
const watchParamsSchema = boundedObject(WATCH_PARAMS_MAX_KEYS, WATCH_PARAMS_MAX_BYTES);

export const concernSeveritySchema = z.enum(CONCERN_SEVERITIES);
export const concernStatusSchema = z.enum(CONCERN_STATUSES);
export const watchKindSchema = z.enum(WATCH_KINDS);

export const concernSubjectSchema = z.object({
  kind: z.enum(CONCERN_SUBJECT_KINDS),
  id: z.uuid(),
});

const summarySchema = z.string().trim().min(1).max(CONCERN_SUMMARY_MAX);
const outcomeSchema = z.string().trim().min(1).max(CONCERN_OUTCOME_MAX);
const cadenceSchema = z.number().int().min(WATCH_CADENCE_MIN_MINUTES).max(WATCH_CADENCE_MAX_MINUTES);

/** ISO datetime strictly in the future and at most CONCERN_SNOOZE_MAX_DAYS ahead (checked at parse time). */
const snoozeUntilSchema = z.iso.datetime({ offset: true }).refine((value) => {
  const until = Date.parse(value);
  const now = Date.now();
  return until > now && until <= now + CONCERN_SNOOZE_MAX_DAYS * 86_400_000;
}, { message: `until must be in the future and at most ${CONCERN_SNOOZE_MAX_DAYS} days ahead` });

// ---------------------------------------------------------------------------
// Outcome tools (assessment runs, W05b)
// ---------------------------------------------------------------------------

/** `record_concern` — the assessment run's way to raise a concern. */
export const raiseConcernSchema = z.object({
  subject: concernSubjectSchema,
  summary: summarySchema,
  severity: concernSeveritySchema,
  evidence: evidenceSchema.optional(),
});
export type RaiseConcernInput = z.infer<typeof raiseConcernSchema>;

export const updateConcernSchema = z.object({
  concernId: z.uuid(),
  summary: summarySchema.optional(),
  severity: concernSeveritySchema.optional(),
  evidence: evidenceSchema.optional(),
  status: z.literal('resolved').optional(),
  outcome: outcomeSchema.optional(),
}).refine((v) => v.status !== 'resolved' || v.outcome !== undefined, {
  message: 'outcome is required when status is resolved',
  path: ['outcome'],
});
export type UpdateConcernInput = z.infer<typeof updateConcernSchema>;

export const nudgeSchema = z.object({
  concernId: z.uuid(),
  nextStep: z.string().trim().min(1).max(300),
  approvalIntentId: z.uuid().optional(),
});
export type NudgeInput = z.infer<typeof nudgeSchema>;

export const proposeActionSchema = z.object({
  toolName: z.string().trim().min(1).max(100),
  input: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(500),
  concernId: z.uuid().optional(),
});
export type ProposeActionInput = z.infer<typeof proposeActionSchema>;

/** W07 fills the body behind it; until then the tool refuses. */
export const requestSpecialistSchema = z.object({
  kind: z.string().trim().min(1).max(100),
  params: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(10).max(500),
});
export type RequestSpecialistInput = z.infer<typeof requestSpecialistSchema>;

/** The run's collected outcome-tool calls, applied by the post-run finalizer (W05b). */
export interface AssessmentOutcome {
  concernsRaised: RaiseConcernInput[];
  concernsUpdated: UpdateConcernInput[];
  nudges: NudgeInput[];
  proposedActions: ProposeActionInput[];
  specialistRequests: RequestSpecialistInput[];
}

// ---------------------------------------------------------------------------
// Chat tools (W05a)
// ---------------------------------------------------------------------------

/** `raise_concern` (chat, T2 auto-approvable): a chat turn names its target org. */
export const raiseConcernChatSchema = raiseConcernSchema.extend({
  orgId: z.uuid(),
  subject: z.object({ kind: z.enum(CHAT_RAISE_CONCERN_SUBJECT_KINDS), id: z.uuid() }),
});
export type RaiseConcernChatInput = z.infer<typeof raiseConcernChatSchema>;

export const listConcernsToolSchema = z.object({
  status: z.array(concernStatusSchema).min(1).max(CONCERN_STATUSES.length).optional(),
  orgId: z.uuid().optional(),
});
export type ListConcernsToolInput = z.infer<typeof listConcernsToolSchema>;

export const snoozeConcernToolSchema = z.object({
  concernId: z.uuid(),
  until: snoozeUntilSchema,
});
export type SnoozeConcernToolInput = z.infer<typeof snoozeConcernToolSchema>;

export const resolveConcernToolSchema = z.object({
  concernId: z.uuid(),
  outcome: outcomeSchema,
});
export type ResolveConcernToolInput = z.infer<typeof resolveConcernToolSchema>;

/** `create_watch` (chat) and the body of `POST /wisp/watches` minus `grantId`. */
export const createWatchInputSchema = z.object({
  orgId: z.uuid().nullable(),
  kind: watchKindSchema,
  params: watchParamsSchema.default({}),
  cadenceMinutes: cadenceSchema,
});
export type CreateWatchInput = z.infer<typeof createWatchInputSchema>;

// ---------------------------------------------------------------------------
// Route bodies / queries (`/api/v1/wisp/concerns`, `/api/v1/wisp/watches`)
// `grantId` names the caller's recipient row (W06 web + mobile send it).
// ---------------------------------------------------------------------------

/** `status` is a comma list (`open,snoozed`); default = live concerns. */
export const listConcernsQuerySchema = z.object({
  grantId: z.uuid(),
  status: z.string().optional().transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    const parsed = z.array(concernStatusSchema).safeParse(parts);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: `status must be a comma list of ${CONCERN_STATUSES.join(', ')}` });
      return z.NEVER;
    }
    return parsed.data;
  }),
  orgId: z.uuid().optional(),
});
export type ListConcernsQuery = z.infer<typeof listConcernsQuerySchema>;

export const concernGrantQuerySchema = z.object({ grantId: z.uuid() });

export const createWatchBodySchema = createWatchInputSchema.extend({ grantId: z.uuid() });
export type CreateWatchBody = z.infer<typeof createWatchBodySchema>;

export const snoozeBodySchema = z.object({ grantId: z.uuid(), until: snoozeUntilSchema });
export type SnoozeBody = z.infer<typeof snoozeBodySchema>;

export const dismissBodySchema = z.object({ grantId: z.uuid() });
export type DismissBody = z.infer<typeof dismissBodySchema>;

export const resolveBodySchema = z.object({ grantId: z.uuid(), outcome: outcomeSchema });
export type ResolveBody = z.infer<typeof resolveBodySchema>;
