import { z } from 'zod';
import { TICKET_TRIAGE_PRIORITIES, type TicketTriageProposal } from '../types/ticketTriage';

/**
 * Every control/format codepoint — C0, DEL, C1, and the bidi overrides that
 * can visually reorder a rendered line. Mirrors `sanitizeSweepText`'s
 * treatment in `apps/api/src/services/aiAgents/runnerPrompt.ts`, and for a
 * similar reason: this text lands in a private note, a draft reply/
 * resolution-note a technician may send/accept verbatim, or (device
 * identifiers) an exact-match lookup — none of those may carry an embedded
 * control or bidi-override codepoint.
 *
 * `\p{C}` rather than a literal control-character class on purpose: the
 * escape is not itself a control character, so it neither trips
 * `no-control-regex` nor needs an eslint-disable for it.
 */
const CONTROL_OR_FORMAT = /\p{C}/gu;

/** Strips every control/format codepoint, then trims. Applied to every
 *  string field on the proposal — see `sanitizedText`'s docstring for why
 *  the length bound is checked BEFORE this runs. */
function sanitize(value: string): string {
  return value.replace(CONTROL_OR_FORMAT, '').trim();
}

/**
 * One model-authored string field. The RAW length ceiling is checked first
 * (`.max`) so a control-character-padded value cannot dodge it; then the
 * value is sanitized and the MINIMUM is re-checked against the sanitized
 * result, so a string that is only control/format characters (or only
 * whitespace) cannot pass as non-empty.
 */
const sanitizedText = (min: number, max: number, label: string) => z.string()
  .max(max, { message: `${label} must be at most ${max} characters` })
  .transform(sanitize)
  .refine((v) => v.length >= min, { message: `${label} must be at least ${min} characters` });

/** `{ value, confidence }` where `value` is a plain enum/string — used for
 *  `fields.priority`. `fields.categoryId` has its own uuid-checked variant
 *  below since its `value` is not one of a fixed set. */
const priorityFieldProposal = z.object({
  value: z.enum(TICKET_TRIAGE_PRIORITIES),
  confidence: z.number().min(0, { message: 'priority confidence must be at least 0' })
    .max(1, { message: 'priority confidence must be at most 1' }),
}).strict();

const categoryIdFieldProposal = z.object({
  value: z.string().uuid({ message: 'categoryId.value must be a uuid' }),
  confidence: z.number().min(0, { message: 'categoryId confidence must be at least 0' })
    .max(1, { message: 'categoryId confidence must be at most 1' }),
}).strict();

/**
 * Validates the `submit_ticket_proposal` outcome-tool payload
 * (`TicketTriageProposal`, `types/ticketTriage.ts`) before `finishRun` turns
 * it into Tier-2 `manage_tickets` intents and `ticket_drafts` rows.
 * `.strict()` at every nesting level so a model that invents a key (e.g.
 * `assignedTeam`, which is DEFERRED — see the spec §4.4 amendment) is
 * rejected outright rather than having the extra key silently dropped.
 */
export const ticketTriageProposalSchema: z.ZodType<TicketTriageProposal> = z.object({
  version: z.literal(1),
  summary: sanitizedText(1, 2000, 'summary'),
  fields: z.object({
    categoryId: categoryIdFieldProposal.optional(),
    priority: priorityFieldProposal.optional(),
  }).strict().optional(),
  device: z.object({
    hostname: sanitizedText(1, 255, 'device.hostname').optional(),
    // O1 (final review #4191): 100, NOT 255 — must stay coupled to the
    // `link_device` AI-tool schema's own `serial: z.string().min(1).max(100)`
    // bound (apps/api/src/services/aiToolSchemas.ts). A proposal serial
    // longer than 100 but <=255 used to pass HERE and then get silently
    // rejected as `intent_error` when the triage finisher fed it into
    // `link_device` — the device link slot dropped with no user-visible
    // signal. `hostname` has no such coupling (aiToolSchemas caps it at 255
    // too), so it is left at 255.
    serial: sanitizedText(1, 100, 'device.serial').optional(),
  }).strict().optional(),
  draftReply: sanitizedText(1, 4000, 'draftReply').optional(),
  draftResolutionNote: sanitizedText(1, 2000, 'draftResolutionNote').optional(),
  notes: z.array(sanitizedText(1, 500, 'note'))
    .max(5, { message: 'notes must have at most 5 entries' })
    .optional(),
}).strict();
