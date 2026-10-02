/**
 * Request schemas for the /ai/models API (AI model registry W04, #7602).
 * Response DTOs live in ../types/aiModelRegistry.ts.
 *
 * Extension points, deliberately narrow in W04:
 *  - connectionCreateSchema is a discriminated union on `kind`; W06 adds
 *    `openai_compatible`, W07 adds `bedrock` | `vertex` | `foundry`.
 *  - assignment `role` is `'default'` only; W09 widens it to AI_SURFACE_ROLES.
 *  - assignment writes never carry fallback fields; W09 adds them.
 *  - aiUsageQuerySchema.groupBy; W10/W11 add groupings.
 */
import { z } from 'zod';
import { AI_SURFACES, type AiSurface } from '../constants/aiSurfaces';
import { INFERENCE_GEO_PATTERN, modelRatesSchema, offeringOptionsSchema } from './aiModelOptions';

export const CONFIGURABLE_AI_SURFACES = AI_SURFACES.filter(
  (s): s is Exclude<AiSurface, 'patch_test'> => s !== 'patch_test',
) as readonly AiSurface[];

/** Offered as a checkbox in the offering drawer. Spec §5.3, §15 #7. */
export const AI_MODEL_REQUIRED_PERMISSION_CHOICES = ['ai_models:premium'] as const;

export const AI_USAGE_GROUP_BYS = ['model', 'surface', 'user', 'org'] as const;
export type AiUsageGroupBy = (typeof AI_USAGE_GROUP_BYS)[number];
export const MAX_AI_USAGE_RANGE_DAYS = 92;

const uuid = z.string().uuid();
const apiKey = z.string().trim().min(20, 'Enter a valid Anthropic API key.').max(500);
const connectionName = z.string().trim().min(1).max(80);
const inferenceGeo = z.string().regex(INFERENCE_GEO_PATTERN);

export const connectionCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_byok'),
    apiKey,
    name: connectionName.optional(),
    inferenceGeo: inferenceGeo.nullable().optional(),
  }).strict(),
]);
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;

export const connectionRotateKeySchema = z.object({ apiKey }).strict();

export const connectionEndpointSchema = z.object({
  catalogEntryId: z.string().trim().min(1).nullable(),
  acknowledgeDataNote: z.boolean().optional().default(false),
}).strict();

export const connectionSettingsPatchSchema = z.object({
  name: connectionName.optional(),
  inferenceGeo: inferenceGeo.nullable().optional(),
}).strict().refine((v) => v.name !== undefined || v.inferenceGeo !== undefined, {
  message: 'Change at least one setting.',
});
export type ConnectionSettingsPatch = z.infer<typeof connectionSettingsPatchSchema>;

export const offeringEnableSchema = z.object({
  enabled: z.boolean(),
  /** Disable even when a surface uses this offering as its default. */
  force: z.boolean().optional().default(false),
}).strict();

/** An allow-list of option values; [] is rejected (use null for "all the model supports"). */
const allowedOptionsSchema = z.object({
  effort: z.array(offeringOptionsSchema.shape.effort.unwrap()).min(1).optional(),
  thinkingDisplay: z.array(offeringOptionsSchema.shape.thinkingDisplay.unwrap()).min(1).optional(),
  speed: z.array(offeringOptionsSchema.shape.speed.unwrap()).min(1).optional(),
}).strict();

export const offeringDetailsPatchSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  /** All four or null (DB price_chk). Only discovered/manual offerings carry prices (spec §8). */
  prices: modelRatesSchema.nullable().optional(),
  defaultOptions: offeringOptionsSchema.nullable().optional(),
  allowedOptions: allowedOptionsSchema.nullable().optional(),
  requiredPermission: z.enum(AI_MODEL_REQUIRED_PERMISSION_CHOICES).nullable().optional(),
  refusalFallbackOfferingId: uuid.nullable().optional(),
}).strict();
export type OfferingDetailsPatch = z.infer<typeof offeringDetailsPatchSchema>;

const configurableSurface = z.enum(CONFIGURABLE_AI_SURFACES as unknown as [AiSurface, ...AiSurface[]]);
/** The assignment roles a write may target. W09 (#7607) widens this one list to AI_SURFACE_ROLES. */
export const AI_ASSIGNMENT_WRITE_ROLES = ['default'] as const;
export type AiAssignmentWriteRole = (typeof AI_ASSIGNMENT_WRITE_ROLES)[number];
const assignmentRole = z.enum(AI_ASSIGNMENT_WRITE_ROLES);
const permittedIds = z.array(uuid).min(1).max(200)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate model in the permitted list.' });

export const partnerAssignmentInputSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  defaultOfferingId: uuid,
  /** null = every enabled model. */
  permittedOfferingIds: permittedIds.nullable(),
  allowUserChoice: z.boolean(),
  options: offeringOptionsSchema.nullable(),
  /** The row's updatedAt as read; null when no partner row existed. */
  expectedUpdatedAt: z.string().datetime().nullable(),
}); // non-strict on purpose: stray fields (e.g. W09's fallbacks) are stripped, not written
export type PartnerAssignmentInput = z.infer<typeof partnerAssignmentInputSchema>;

function uniqueSurfaceRole(rows: Array<{ surface: string; role: string }>): boolean {
  return new Set(rows.map((r) => `${r.surface}/${r.role}`)).size === rows.length;
}

export const partnerAssignmentsPutSchema = z.object({
  assignments: z.array(partnerAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature may appear once.' }),
}).strict();

export const orgAssignmentInputSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  /** null = inherit the partner default. */
  defaultOfferingId: uuid.nullable(),
  /** null = inherit the partner's permitted set. */
  permittedOfferingIds: permittedIds.nullable(),
  /** An org can only lock choice (false) or inherit (null). */
  allowUserChoice: z.literal(false).nullable(),
  /** null = inherit; per-key values may only narrow (checked server-side). */
  options: offeringOptionsSchema.nullable(),
  expectedUpdatedAt: z.string().datetime().nullable(),
});
export type OrgAssignmentInput = z.infer<typeof orgAssignmentInputSchema>;

export const orgAssignmentsPutSchema = z.object({
  assignments: z.array(orgAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature may appear once.' }),
}).strict();

export const residencyPutSchema = z.object({
  required: z.boolean(),
  /** Required when turning residency on would make any feature unavailable (see the preview). */
  acknowledgeImpact: z.boolean().optional().default(false),
}).strict();

/** A real calendar date (2026-02-30 is rejected: it must round-trip through Date). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, { message: 'Enter a valid date (YYYY-MM-DD).' });
/** The usage query fields without the range rules: later waves `.extend()` this, then re-apply the refines below. */
export const aiUsageQueryBaseSchema = z.object({
  groupBy: z.enum(AI_USAGE_GROUP_BYS),
  /** Inclusive UTC dates, BOTH or NEITHER (neither = the first of the current month → today, applied by the route). */
  from: isoDate.optional(),
  to: isoDate.optional(),
  orgId: uuid.optional(),
});
export const aiUsageQuerySchema = aiUsageQueryBaseSchema.refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'Give both `from` and `to`, or neither.' })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`.' })
  .refine((q) => {
    if (!q.from || !q.to) return true;
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
    return days <= MAX_AI_USAGE_RANGE_DAYS;
  }, { message: `Choose a range of at most ${MAX_AI_USAGE_RANGE_DAYS} days.` });
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;
