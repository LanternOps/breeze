import { z } from 'zod';
import { AI_AGENT_SCHEDULE_KINDS, AI_SWEEP_KINDS, AI_SWEEP_SEVERITIES, type SweepFinding, type SweepFindingsOutcome, type SweepProposedAction } from '../types/aiAgentSchedules';
import { isStructurallyValidCron } from '../utils/cron';
import { canonicalizeTimezone } from '../utils/timezone';

/**
 * The CADENCE FLOOR (review fix, #4189). A sweep occurrence fans out one
 * LLM-spending run per LIVE org under the partner, so cadence is a fleet-wide
 * cost and rate multiplier that a single PATCH can turn on — a star-slash-15
 * minute on a 400-org partner is 1,600 runs an hour. The minute field is
 * restricted to a literal integer or a comma-separated list of integers: no
 * `*`, no step (`/`), no range (`-`). That makes "fires at most once per
 * hour" a property of the STORED value rather than something the tick has to
 * rate-limit after the fact.
 *
 * Only the minute field is constrained. Every other field stays fully
 * expressive (`0 6 * * 1-5` — weekdays at 06:00 — is the canonical schedule),
 * because a coarser field can only ever REDUCE the firing rate.
 *
 * `isStructurallyValidCron` already range-checks each token (0-59 here), so
 * this pattern only has to exclude the operators.
 */
const LITERAL_MINUTE_LIST = /^\d{1,2}(,\d{1,2})*$/;

/** Exported so `services/aiAgents/scheduleService.ts` — which validates
 *  independently of this schema, being reachable from non-HTTP callers —
 *  enforces the SAME floor rather than a second hand-rolled copy of it. */
export function isHourlyFloorCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  // 5-field only; a 6-field pattern is already rejected by the refine below
  // (its leading field is SECONDS, so reading fields[0] as the minute would
  // be wrong — return false rather than judge an expression this schema does
  // not accept in the first place).
  if (fields.length !== 5) return false;
  return LITERAL_MINUTE_LIST.test(fields[0]!);
}

/**
 * The WEEKLY LITERAL rule (phase 2 P2-3). A `narrative` schedule produces one
 * customer-facing weekly report per org, so "weekly" has to be a property of
 * the STORED cron rather than something the report generator asserts after
 * the fact: a schedule that fired daily would mail an MSP's customer seven
 * "weekly" reports covering overlapping windows.
 *
 * Exactly one firing per week means every field is pinned:
 *   minute        a literal integer 0-59
 *   hour          a literal integer 0-23
 *   day-of-month  `*`  (a literal day would make it monthly, not weekly)
 *   month         `*`  (a literal month would make it annual)
 *   day-of-week   a single literal integer 0-6
 *
 * No lists, ranges, steps, or three-letter names anywhere — each of those is
 * a way to fire more than once a week (`0 7 * * 1,3`) or to change the
 * cadence entirely (`0 7 1 * *`).
 *
 * Exported for the same reason as `isHourlyFloorCron`: the schedule service
 * validates independently of this schema (it is reachable from non-HTTP
 * callers), and must enforce the identical rule rather than a second
 * hand-rolled copy of it.
 */
const LITERAL_INT = /^\d{1,2}$/;
export function isWeeklyLiteralCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (!LITERAL_INT.test(minute) || Number(minute) > 59) return false;
  if (!LITERAL_INT.test(hour) || Number(hour) > 23) return false;
  if (dayOfMonth !== '*' || month !== '*') return false;
  return /^[0-6]$/.test(dayOfWeek);
}

// The sweeper evaluates crons with a strictly 5-field evaluator, so a
// 6-field cron (the optional leading-seconds field `isStructurallyValidCron`
// otherwise tolerates for BullMQ's benefit — see cron.ts) is rejected HERE,
// at the schema, even though the structural validator alone would accept it.
const scheduleCronSchema = z.string()
  .refine(
    (v) => isStructurallyValidCron(v) && v.trim().split(/\s+/).length === 5,
    { message: 'must be a structurally valid 5-field cron expression' },
  )
  .refine(isHourlyFloorCron, {
    message: 'the minute field must be a literal minute or comma-separated list of minutes — sweep schedules fire at most hourly',
  });

const scheduleTimezoneSchema = z
  .string()
  .refine((v) => canonicalizeTimezone(v) !== null, { message: 'must be a valid IANA timezone' })
  .transform((v) => canonicalizeTimezone(v)!);

const sweepKindEnum = z.enum(AI_SWEEP_KINDS);

export const sweepProposedActionSchema: z.ZodType<SweepProposedAction> = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('manage_services'),
    action: z.literal('restart'),
    deviceId: z.string().uuid(),
    serviceName: z.string().min(1).max(255),
  }).strict(),
  z.object({
    tool: z.literal('remediate_vulnerability'),
    deviceId: z.string().uuid(),
    deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(100),
  }).strict(),
]);

const sweepFindingSchema: z.ZodType<SweepFinding> = z.object({
  kind: sweepKindEnum,
  severity: z.enum(AI_SWEEP_SEVERITIES),
  deviceId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(600),
  evidence: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 20, { message: 'evidence may have at most 20 keys' }),
  proposedAction: sweepProposedActionSchema.optional(),
}).strict();

export const sweepFindingsOutcomeSchema: z.ZodType<SweepFindingsOutcome> = z.object({
  summary: z.string().min(1).max(400),
  findings: z.array(sweepFindingSchema).max(50),
}).strict();

// Discriminated on `ownerScope`, mirroring the Partner-Wide First playbook
// (CLAUDE.md): a partner-wide baseline carries its own cron/timezone and a
// `.min(1)` sweepKinds list (a baseline that sweeps nothing is pointless);
// an org-level override carries no cron/timezone of its own — it always
// runs on its baseline's cadence — and its `sweepKinds` may be `[]`, which
// means "disable every kind for this org" (same convention as the org
// override's `enabled: false`).
const createPartnerScheduleSchema = z.object({
  ownerScope: z.literal('partner'),
  // Defaults to `sweep` so every pre-P2-3 create body — none of which sends
  // this field — still parses to exactly what it used to mean.
  kind: z.enum(AI_AGENT_SCHEDULE_KINDS).default('sweep'),
  agentId: z.string().uuid(),
  cron: scheduleCronSchema,
  timezone: scheduleTimezoneSchema,
  // .max(6): AI_SWEEP_KINDS has exactly 6 members, so a list longer than
  // that can only be a duplicate — the sweeper still no-ops on dupes, but
  // there is no legitimate 7th value to accept.
  //
  // The `.min(1)` that used to live here moved into the superRefine below,
  // because it is a SWEEP-only rule: a narrative baseline legitimately
  // sweeps nothing. Defaulting to `[]` keeps "omitted" and "explicitly
  // empty" the same thing for a narrative create.
  sweepKinds: z.array(sweepKindEnum).max(6).default([]),
  enabled: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'narrative') {
    if (value.sweepKinds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sweepKinds'],
        message: 'a narrative schedule evaluates no sweep kinds — sweepKinds must be omitted or empty',
      });
    }
    if (!isWeeklyLiteralCron(value.cron)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cron'],
        message: 'a narrative schedule must fire exactly once a week — literal minute and hour, `*` day-of-month and month, and a single day-of-week 0-6',
      });
    }
    return;
  }
  // kind === 'sweep': every pre-P2-3 rule, unchanged. A baseline that sweeps
  // nothing is pointless, so at least one kind is still required.
  if (value.sweepKinds.length < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['sweepKinds'],
      message: 'a sweep schedule must select at least one sweep kind',
    });
  }
});

// `.strict()` is what keeps `kind` off this branch: an override inherits its
// baseline's kind and may never set one (see AI_AGENT_SCHEDULE_KINDS).
const createOrgScheduleSchema = z.object({
  ownerScope: z.literal('organization'),
  orgId: z.string().uuid(),
  baselineScheduleId: z.string().uuid(),
  enabled: z.boolean(),
  sweepKinds: z.array(sweepKindEnum).max(6),
}).strict();

export const createAiAgentScheduleSchema = z.discriminatedUnion('ownerScope', [
  createPartnerScheduleSchema,
  createOrgScheduleSchema,
]);

// Never admits `ownerScope`, `agentId`, `baselineScheduleId`, or `kind` —
// those are immutable for the lifetime of a schedule row (changing which
// agent, baseline, or run profile a schedule belongs to is a
// delete-and-recreate, not a patch). `.strict()` is the enforcement: a PATCH
// carrying any of them is rejected, never silently stripped.
export const updateAiAgentScheduleSchema = z.object({
  cron: scheduleCronSchema.optional(),
  timezone: scheduleTimezoneSchema.optional(),
  sweepKinds: z.array(sweepKindEnum).max(6).optional(),
  enabled: z.boolean().optional(),
}).strict();
