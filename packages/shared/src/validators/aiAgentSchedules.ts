import { z } from 'zod';
import { AI_SWEEP_KINDS, AI_SWEEP_SEVERITIES, type SweepFinding, type SweepFindingsOutcome, type SweepProposedAction } from '../types/aiAgentSchedules';
import { isStructurallyValidCron } from '../utils/cron';
import { canonicalizeTimezone } from '../utils/timezone';

// The sweeper evaluates crons with a strictly 5-field evaluator, so a
// 6-field cron (the optional leading-seconds field `isStructurallyValidCron`
// otherwise tolerates for BullMQ's benefit — see cron.ts) is rejected HERE,
// at the schema, even though the structural validator alone would accept it.
const scheduleCronSchema = z.string().refine(
  (v) => isStructurallyValidCron(v) && v.trim().split(/\s+/).length === 5,
  { message: 'must be a structurally valid 5-field cron expression' },
);

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
  agentId: z.string().uuid(),
  cron: scheduleCronSchema,
  timezone: scheduleTimezoneSchema,
  sweepKinds: z.array(sweepKindEnum).min(1),
  enabled: z.boolean(),
}).strict();

const createOrgScheduleSchema = z.object({
  ownerScope: z.literal('organization'),
  orgId: z.string().uuid(),
  baselineScheduleId: z.string().uuid(),
  enabled: z.boolean(),
  sweepKinds: z.array(sweepKindEnum),
}).strict();

export const createAiAgentScheduleSchema = z.discriminatedUnion('ownerScope', [
  createPartnerScheduleSchema,
  createOrgScheduleSchema,
]);

// Never admits `ownerScope`, `agentId`, or `baselineScheduleId` — those are
// immutable for the lifetime of a schedule row (changing which agent or
// baseline a schedule belongs to is a delete-and-recreate, not a patch).
export const updateAiAgentScheduleSchema = z.object({
  cron: scheduleCronSchema.optional(),
  timezone: scheduleTimezoneSchema.optional(),
  sweepKinds: z.array(sweepKindEnum).optional(),
  enabled: z.boolean().optional(),
}).strict();
