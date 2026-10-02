/**
 * Request schemas for the /ai/models API (AI model registry W04, #7602).
 * Response DTOs live in ../types/aiModelRegistry.ts.
 *
 * Extension points:
 *  - connectionCreateSchema is a discriminated union on `kind`; W06 added
 *    `openai_compatible`, W07 adds `bedrock` | `vertex` | `foundry`.
 *  - assignment role/fallback fields: widened by W09 (#7607).
 *  - aiUsageQuerySchema.groupBy; W10/W11 add groupings (W11: a sibling aiQualityQuerySchema over the same base and range rules).
 */
import { z } from 'zod';
import { AI_AGENT_ESCALATION_ROLES, AI_SURFACE_ROLES, AI_SURFACES, MAX_FALLBACK_OFFERINGS, type AiSurface } from '../constants/aiSurfaces';
import { BYO_MODEL_ID_PATTERN } from '../constants/aiConnectionKinds';
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
/**
 * W06: syntax of a BYO OpenAI-compatible base URL. This is NOT the egress policy —
 * private/metadata addresses, https-on-hosted and DNS pinning are enforced
 * server-side (services/aiModels/gateway/byoEndpointPolicy.ts) and at connect.
 */
export const byoBaseUrlSchema = z.string().trim().max(2048)
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    let u: URL;
    try { u = new URL(v); } catch { return false; }
    return (u.protocol === 'https:' || u.protocol === 'http:')
      && u.hostname !== '' && u.username === '' && u.password === ''
      && !v.includes('?') && !v.includes('#');
  }, { message: 'Enter an http(s) URL with no credentials, query or fragment.' });

/** Optional on a BYO endpoint: a local Ollama/vLLM usually has none. */
// ≥ 8 chars: the gateway's scrubber redacts secrets of 8+ characters wherever they
// are echoed (Codex review #2); a shorter "key" could not be scrubbed safely.
const byoApiKey = z.string().trim().min(8, 'A key must be at least 8 characters.').max(500);

export const connectionCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_byok'),
    apiKey,
    name: connectionName.optional(),
    inferenceGeo: inferenceGeo.nullable().optional(),
  }).strict(),
  // W06 (#7604): BYO OpenAI-compatible. No inferenceGeo: its geography is
  // unverifiable, so it is never residency-eligible (Decision D7).
  z.object({
    kind: z.literal('openai_compatible'),
    name: connectionName,
    baseUrl: byoBaseUrlSchema,
    apiKey: byoApiKey.optional(),
  }).strict(),
]);
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;

/** W06: edit a gateway connection's endpoint/key. `apiKey: null` clears it. */
export const connectionGatewayPatchSchema = z.object({
  baseUrl: byoBaseUrlSchema.optional(),
  apiKey: byoApiKey.nullable().optional(),
  /** Optimistic concurrency on config_version (bumped by every endpoint/key change). */
  expectedConfigVersion: z.number().int().min(1),
}).strict().refine((v) => v.baseUrl !== undefined || v.apiKey !== undefined, {
  message: 'Change the URL or the key.',
});
export type ConnectionGatewayPatchInput = z.infer<typeof connectionGatewayPatchSchema>;

/** W06: hand-entered model on a gateway connection (spec §6 "manual entry is always allowed"). */
export const manualOfferingCreateSchema = z.object({
  modelId: z.string().trim().regex(BYO_MODEL_ID_PATTERN, 'Enter the model id exactly as the endpoint expects it.'),
  displayName: z.string().trim().min(1).max(120).optional(),
  prices: modelRatesSchema.nullable().optional(),
}).strict();
export type ManualOfferingCreateInput = z.infer<typeof manualOfferingCreateSchema>;

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
/** W09 (#7607): `default` on every surface; ai_agents also has the escalation stages (checked per surface below). */
export const AI_ASSIGNMENT_WRITE_ROLES = ['default', ...AI_AGENT_ESCALATION_ROLES] as const;
export type AiAssignmentWriteRole = (typeof AI_ASSIGNMENT_WRITE_ROLES)[number];
const assignmentRole = z.enum(AI_ASSIGNMENT_WRITE_ROLES);
const permittedIds = z.array(uuid).min(1).max(200)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate model in the permitted list.' });

/** Every configurable (surface, role) pair, in surface order then role order. */
export const CONFIGURABLE_AI_SURFACE_ROLES: ReadonlyArray<{ surface: AiSurface; role: string }> =
  CONFIGURABLE_AI_SURFACES.flatMap((surface) => AI_SURFACE_ROLES[surface].map((role) => ({ surface, role })));

const fallbackIds = z.array(uuid).max(MAX_FALLBACK_OFFERINGS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate model in the fallback list.' });

function roleBelongsToSurface(row: { surface: AiSurface; role: string }, ctx: z.RefinementCtx): void {
  if (!(AI_SURFACE_ROLES[row.surface] as readonly string[]).includes(row.role)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'That feature has no such role.' });
  }
}

/** The inner object, exported for `.shape`/`.extend` callers (the refined schema below is a ZodEffects). */
export const partnerAssignmentObjectSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  /** null only on a role row (role other than 'default'): clears it, so the role inherits the feature default. */
  defaultOfferingId: uuid.nullable(),
  /** null = every enabled model. */
  permittedOfferingIds: permittedIds.nullable(),
  allowUserChoice: z.boolean(),
  options: offeringOptionsSchema.nullable(),
  /** W09: ordered failover list. Omitted = keep the stored list; null or [] = no failover. */
  fallbackOfferingIds: fallbackIds.nullable().optional(),
  /** W09: may failover move between Breeze credits and the partner's own key. Omitted = keep the stored value. */
  fallbackMayCrossFunding: z.boolean().optional(),
  /** The row's updatedAt as read; null when no partner row existed. */
  expectedUpdatedAt: z.string().datetime().nullable(),
});
export const partnerAssignmentInputSchema = partnerAssignmentObjectSchema.superRefine((row, ctx) => {
  roleBelongsToSurface(row, ctx);
  if (row.defaultOfferingId === null) {
    if (row.role === 'default') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultOfferingId'], message: 'Choose a default model.' });
    } else if (row.permittedOfferingIds !== null || row.options !== null || (row.fallbackOfferingIds ?? null) !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultOfferingId'], message: 'Clear the whole role row to inherit the feature default.' });
    }
  }
  if (row.defaultOfferingId && row.fallbackOfferingIds?.includes(row.defaultOfferingId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fallbackOfferingIds'], message: 'A model cannot be its own fallback.' });
  }
});
export type PartnerAssignmentInput = z.infer<typeof partnerAssignmentInputSchema>;

function uniqueSurfaceRole(rows: Array<{ surface: string; role: string }>): boolean {
  return new Set(rows.map((r) => `${r.surface}/${r.role}`)).size === rows.length;
}

export const partnerAssignmentsPutSchema = z.object({
  assignments: z.array(partnerAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACE_ROLES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature role may appear once.' }),
}).strict();

export const orgAssignmentObjectSchema = z.object({
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
  /** W09: null/omitted = inherit the partner list; a list narrows it (each id must be partner-permitted). */
  fallbackOfferingIds: fallbackIds.nullable().optional(),
  /** W09: an org can only switch cross-funding failover OFF (false) or inherit (null). */
  fallbackMayCrossFunding: z.literal(false).nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable(),
});
export const orgAssignmentInputSchema = orgAssignmentObjectSchema.superRefine((row, ctx) => roleBelongsToSurface(row, ctx));
export type OrgAssignmentInput = z.infer<typeof orgAssignmentInputSchema>;

export const orgAssignmentsPutSchema = z.object({
  assignments: z.array(orgAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACE_ROLES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature role may appear once.' }),
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
/**
 * The usage range rules on any schema with optional from/to: both or
 * neither, ordered, and at most `maxDays` apart. zod 4 forbids `.extend()`
 * after a refine, so every usage-shaped schema builds its object first and
 * applies these last.
 */
export function withUsageRangeRules<T extends z.ZodType<{ from?: string | undefined; to?: string | undefined }>>(
  schema: T,
  maxDays: number = MAX_AI_USAGE_RANGE_DAYS,
): T {
  return schema
    .refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'Give both `from` and `to`, or neither.' })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`.' })
    .refine((q) => {
      if (!q.from || !q.to) return true;
      const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
      return days <= maxDays;
    }, { message: `Choose a range of at most ${maxDays} days.` });
}

export const aiUsageQuerySchema = withUsageRangeRules(aiUsageQueryBaseSchema);
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

/** W11 (#7609): the quality view's groupings (spec §13: by model, surface and prompt profile). */
export const AI_QUALITY_GROUP_BYS = ['model', 'surface', 'prompt_profile'] as const;
export type AiQualityGroupBy = (typeof AI_QUALITY_GROUP_BYS)[number];

export const aiQualityQuerySchema = withUsageRangeRules(
  aiUsageQueryBaseSchema.omit({ groupBy: true }).extend({ groupBy: z.enum(AI_QUALITY_GROUP_BYS) }),
);
export type AiQualityQuery = z.infer<typeof aiQualityQuerySchema>;

/** The platform prompt-variant report reads every partner's ledger: a tighter range than the partner view. */
export const PROMPT_VARIANT_REPORT_MAX_DAYS = 31;
export const aiPromptVariantReportQuerySchema = withUsageRangeRules(
  z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  PROMPT_VARIANT_REPORT_MAX_DAYS,
);
