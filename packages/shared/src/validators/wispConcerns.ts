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
  CONCERN_FEEDBACK_NOTE_MAX,
  CONCERN_OUTCOME_MAX,
  CONCERN_SEVERITIES,
  CONCERN_SNOOZE_MAX_DAYS,
  CONCERN_STATUSES,
  CONCERN_SUBJECT_KINDS,
  CONCERN_SUMMARY_MAX,
  SYSTEM_ONLY_CONCERN_SUBJECT_KINDS,
  WATCH_CADENCE_MAX_MINUTES,
  WATCH_CADENCE_MIN_MINUTES,
  WATCH_KINDS,
  WATCH_PARAMS_MAX_BYTES,
  WATCH_PARAMS_MAX_KEYS,
} from '../types/wispConcerns';
import { WISP_ASSESSMENT_REQUEST_KINDS, type WispAssessmentRequestKind, type WispSpecialistKind } from './wispSpecialists';

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

/** A subject a run may raise a concern on: every kind but the system-only ones. */
export const concernSubjectSchema = z.object({
  kind: z.enum(CONCERN_SUBJECT_KINDS).exclude([...SYSTEM_ONLY_CONCERN_SUBJECT_KINDS]),
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

/** Longest stored concern pattern key (#11426); a longer one is cut at its last `_` that fits, else at the limit. */
export const CONCERN_PATTERN_MAX = 64;

/**
 * #11426: the evidence key holding a concern's pattern. Server-written: the
 * assessment finalizer and the chat `raise_concern` both strip it from the
 * evidence they are handed; only `record_concern.pattern` sets it.
 */
export const CONCERN_PATTERN_EVIDENCE_KEY = 'pattern';

/**
 * #11426: a concern pattern key in its stored form — lowercase snake_case
 * (`Phantom Incident-Event` → `phantom_incident_event`), at most
 * CONCERN_PATTERN_MAX characters. null when fewer than 3 characters survive
 * (or the input is not a string): no key is better than a meaningless one.
 */
export function normalizeConcernPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (key.length > CONCERN_PATTERN_MAX) {
    const cut = key.slice(0, CONCERN_PATTERN_MAX + 1);
    const at = cut.lastIndexOf('_');
    key = (at > 0 ? cut.slice(0, at) : cut.slice(0, CONCERN_PATTERN_MAX)).replace(/_+$/, '');
  }
  return key.length >= 3 ? key : null;
}

/** `record_concern` — the assessment run's way to raise a concern. */
export const raiseConcernSchema = z.object({
  subject: concernSubjectSchema,
  summary: summarySchema,
  severity: concernSeveritySchema,
  evidence: evidenceSchema.optional(),
  // #11426: the same-org rollup folds ≥ 3 device concerns sharing this key into
  // one org-level concern. Stored normalised (normalizeConcernPattern), which
  // also cuts it to CONCERN_PATTERN_MAX; 100 is only the input bound.
  pattern: z.string().trim().min(1).max(100).optional().describe(
    'Short snake_case key for the KIND of problem, identical for every device that has it '
    + '(e.g. phantom_incident_event, browser_critical_cves, patch_job_timeout). No device names, ids or numbers.',
  ),
});
export type RaiseConcernInput = z.infer<typeof raiseConcernSchema>;

const updateConcernObjectSchema = z.object({
  concernId: z.uuid(),
  summary: summarySchema.optional(),
  severity: concernSeveritySchema.optional(),
  evidence: evidenceSchema.optional(),
  status: z.literal('resolved').optional().describe(
    "Send 'resolved' with an outcome to close the concern. Omit it to keep the concern open: "
    + 'a summary, severity or evidence edit alone never closes it.',
  ),
  outcome: outcomeSchema.optional().describe(
    'One sentence on how the concern ended (e.g. "The device restarted on its own; the reboot alert cleared"). '
    + 'Required with status resolved. An outcome always resolves the concern, even without status.',
  ),
});

/**
 * The raw `update_concern` shape for the SDK tool's input schema (a raw shape
 * cannot carry the refine/transform below; `updateConcernSchema.parse` stays
 * the authority).
 */
export const updateConcernToolShape = updateConcernObjectSchema.shape;

/**
 * #11427: an update that carries an `outcome` and no `status` is a resolve. An
 * outcome is by definition how the concern ended, and the model sent exactly
 * that shape (`{ concernId, summary, outcome }`) for a week, which used to edit
 * the summary and leave the concern open forever. Resolving without an outcome
 * is still refused: the outcome is what gets remembered.
 */
export const updateConcernSchema = updateConcernObjectSchema
  .refine((v) => v.status !== 'resolved' || v.outcome !== undefined, {
    message: 'outcome is required when status is resolved',
    path: ['outcome'],
  })
  .transform((v): z.output<typeof updateConcernObjectSchema> =>
    (v.outcome !== undefined && v.status === undefined ? { ...v, status: 'resolved' } : v));
export type UpdateConcernInput = z.output<typeof updateConcernSchema>;

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

/**
 * `request_specialist` (W07): validate-only during the assessment; the
 * coordinator dispatches each recorded request after the run
 * (`apps/api/src/services/wisp/specialistDispatch.ts`).
 */
export const requestSpecialistSchema = z.object({
  kind: z.enum(WISP_ASSESSMENT_REQUEST_KINDS as [WispAssessmentRequestKind, ...WispAssessmentRequestKind[]]),
  params: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(10).max(500),
});
export type RequestSpecialistInput = z.infer<typeof requestSpecialistSchema>;

/** Parses a `request_specialist` call; throws (ZodError) on an invalid one. */
export function validateRequestSpecialist(input: unknown): RequestSpecialistInput {
  return requestSpecialistSchema.parse(input);
}

/** What the post-run dispatch did with one recorded request (`requestId` = deriveRequestId(runId, ordinal)). */
export type SpecialistRequestResult = { requestId: string; kind: WispSpecialistKind } & (
  | { admitted: true; runId?: string; taskId?: string }
  | { needsApproval: true; intentId: string }
  | { refused: string; detail?: string }
);

/** The run's collected outcome-tool calls, applied by the post-run finalizer (W05b). */
export interface AssessmentOutcome {
  concernsRaised: RaiseConcernInput[];
  concernsUpdated: UpdateConcernInput[];
  nudges: NudgeInput[];
  proposedActions: ProposeActionInput[];
  specialistRequests: RequestSpecialistInput[];
  /** W07 — one entry per `specialistRequests` item, in call order, written by the post-run dispatch. */
  specialistResults?: SpecialistRequestResult[];
}

// ---------------------------------------------------------------------------
// Chat tools (W05a)
// ---------------------------------------------------------------------------

/** `raise_concern` (chat, T2 auto-approvable): a chat turn names its target org. */
// No `pattern` (#11426): a chat raise names one concern a person asked for; the
// rollup key is the assessment run's (concernTools also strips `evidence.pattern`),
// and the chat tool index stays unchanged.
export const raiseConcernChatSchema = raiseConcernSchema.omit({ pattern: true }).extend({
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

/** POST /:id/feedback (w00 A34): one tap "useful / not useful" on a nudged concern, with an optional one-line note. */
export const concernFeedbackBodySchema = z.object({
  grantId: z.uuid(),
  useful: z.boolean(),
  note: z.string().trim().max(CONCERN_FEEDBACK_NOTE_MAX).optional(),
});
export type ConcernFeedbackBody = z.infer<typeof concernFeedbackBodySchema>;
