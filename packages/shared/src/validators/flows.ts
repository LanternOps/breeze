import { z } from 'zod';
import { isStructurallyValidCron } from '../utils/cron';
import { FLOW_LIMIT_CEILINGS } from './flowBudgets';
import type { FlowAdmissionRefusal, FlowUsageDto } from './flowBudgets';
import { FLOW_WEBHOOK_AUTH_MODES } from './flowWebhooks';
import type { FlowWebhookInfoDto } from './flowWebhooks';

/**
 * Flow document v1 (tool catalog W3, #5218). Stored as `flows.definition jsonb`.
 * Catalog-aware validation lives on the API; this module is browser safe.
 */

export const FLOW_DOCUMENT_VERSION = 1;

export const FLOW_LIMITS = {
  maxSteps: 50,
  maxInputs: 20,
  maxForEachItems: 500,
  maxConcurrency: 10,
  defaultTimeoutSec: 300,
  maxTimeoutSec: 3600,
  maxExprLength: 2048,
  maxDocumentBytes: 262_144,
  maxInputDepth: 16,
  maxTemplates: 500,
} as const;

export const FLOW_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const FLOW_STEP_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const FLOW_INPUT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

export function isValidFlowSlug(s: string): boolean {
  return FLOW_SLUG_RE.test(s) && !s.includes('__');
}

export function slugifyFlowName(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (s.length === 0) s = 'flow';
  if (!/^[a-z]/.test(s) || s.length < 2) s = `f_${s}`;
  s = s.slice(0, 48).replace(/_+$/g, '');
  // Defensive: the replace above cannot produce '__', but the contract is "never".
  s = s.replace(/_{2,}/g, '_');
  return s.length >= 2 ? s : 'f_flow';
}

const EVENT_FILTER_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.]{0,127}$/;

/**
 * Webhook org resolver path (W5, Decision 5): a dotted own-property path into the
 * request body, `body.<seg>(.<seg>)*`, at most 8 segments. Segments are identifiers
 * only (no brackets, no dashes) so the path cannot express anything but a plain read.
 */
export const FLOW_WEBHOOK_RESOLVER_PATH_RE = /^body(\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,8}$/;
/** `organization_external_links.system` value a resolver names. */
export const FLOW_WEBHOOK_RESOLVER_SYSTEM_RE = /^[a-z0-9_]{1,64}$/;

const resolverPath = z.string().max(600).regex(FLOW_WEBHOOK_RESOLVER_PATH_RE);

export const flowWebhookOrgResolverSchema = z.union([
  z.object({ path: resolverPath, system: z.string().regex(FLOW_WEBHOOK_RESOLVER_SYSTEM_RE) }).strict(),
  z.object({ path: resolverPath, kind: z.literal('breeze_org_id') }).strict(),
]);
export type FlowWebhookOrgResolver = z.infer<typeof flowWebhookOrgResolverSchema>;

export const flowTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1).max(100).refine(isStructurallyValidCron, { message: 'Invalid cron expression' }),
    timezone: z.string().min(1).max(64),
  }).strict(),
  z.object({
    type: z.literal('event'),
    event: z.string().min(1).max(64),
    filter: z
      .record(z.string().regex(EVENT_FILTER_KEY_RE), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .refine((f) => Object.keys(f).length <= 20, { message: 'filter may have at most 20 keys' })
      .default({}),
  }).strict(),
  z.object({
    type: z.literal('webhook'),
    auth: z.enum(FLOW_WEBHOOK_AUTH_MODES).default('hmac'),
    // Required on partner-wide flows, refused on org flows (catalog-aware validator).
    orgResolver: flowWebhookOrgResolverSchema.optional(),
  }).strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);

export const flowInputDeclSchema = z.object({
  name: z.string().regex(FLOW_INPUT_NAME_RE),
  type: z.enum(['string', 'number', 'boolean', 'uuid']),
  required: z.boolean().default(false),
  description: z.string().max(500).optional(),
}).strict();

export const flowStepSchema = z.object({
  id: z.string().regex(FLOW_STEP_ID_RE),
  tool: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
  when: z.string().min(1).max(FLOW_LIMITS.maxExprLength).optional(),
  forEach: z.object({
    items: z.string().min(1).max(FLOW_LIMITS.maxExprLength),
    as: z.literal('item').default('item'),
    maxItems: z.number().int().min(1).max(FLOW_LIMITS.maxForEachItems).default(100),
    concurrency: z.number().int().min(1).max(FLOW_LIMITS.maxConcurrency).default(1),
  }).strict().optional(),
  approval: z.enum(['default', 'pre_approved']).default('default'),
  onFailure: z.enum(['stop', 'continue']).default('stop'),
  timeoutSec: z.number().int().min(1).max(FLOW_LIMITS.maxTimeoutSec).default(FLOW_LIMITS.defaultTimeoutSec),
}).strict();

export const flowDocumentV1Schema = z.object({
  version: z.literal(FLOW_DOCUMENT_VERSION),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  trigger: flowTriggerSchema,
  inputs: z.array(flowInputDeclSchema).max(FLOW_LIMITS.maxInputs).default([]),
  steps: z.array(flowStepSchema).min(1).max(FLOW_LIMITS.maxSteps),
  /** W5 (Decision 15): lowers the owner's per-flow monthly cap; snapshotted by the publication. */
  limits: z.object({
    monthlyRuns: z.number().int().min(1).max(FLOW_LIMIT_CEILINGS.monthlyRunsPerFlow).optional(),
  }).strict().optional(),
  /** W5 (Decision 14): where pause, unknown-outcome and cap notices go besides the delegator's in-app notice. */
  notices: z.object({ channelId: z.string().uuid() }).strict().optional(),
}).strict();

export type FlowDocumentV1 = z.infer<typeof flowDocumentV1Schema>;
export type FlowStatus = 'draft' | 'enabled' | 'paused' | 'disabled';

export type FlowIssueCode =
  | 'schema' | 'duplicate_step_id' | 'unknown_step_reference' | 'forward_reference'
  | 'item_outside_foreach' | 'unknown_root' | 'undeclared_input' | 'expr_parse_error' | 'template_parse_error'
  | 'tool_not_found' | 'tool_not_allowed' | 'builtin_not_available' | 'trigger_not_available' | 'input_invalid'
  | 'input_not_supported' | 'action_not_literal' | 'tier_input_not_literal' | 'tool_blocked'
  | 'pre_approval_not_available' | 'reference_not_owned' | 'device_not_owned' | 'device_in_partner_flow' | 'group_in_partner_flow'
  | 'event_unknown' | 'document_too_large' | 'input_too_deep' | 'too_many_templates'
  | 'event_dispatch_not_durable' | 'foreach_concurrency_not_available' | 'pre_approval_not_eligible'
  // W5 (#5220)
  | 'webhook_org_resolver_required' | 'webhook_org_resolver_not_allowed' | 'flow_step_not_supported'
  | 'http_origin_not_literal' | 'http_origin_not_allowed' | 'http_method_not_literal' | 'http_header_not_allowed'
  | 'secret_in_document' | 'ai_tool_not_tier1' | 'ai_output_schema_invalid' | 'notify_channel_not_literal'
  | 'notify_channel_not_owned' | 'channel_type_not_supported';

/** Where a flow step's tool comes from. Defined here (not flowRuns.ts) so flows.ts never imports flowRuns.ts. */
export type FlowToolSource = 'core' | 'tenant' | 'builtin';

/** Why an enabled flow was paused. Re-exported from flowRuns.ts. */
export const FLOW_PAUSED_REASONS = ['drift', 'binding_drift', 'delegator_inactive', 'org_merged', 'event_dispatch_not_durable'] as const;
export type FlowPausedReason = (typeof FLOW_PAUSED_REASONS)[number];

export type PreApprovalEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | 'not_tier3' | 'tool_not_supported' | 'script_not_literal' | 'run_context_not_literal' | 'group_target'
        | 'variable_dependent' | 'script_not_found' | 'four_eyes' | 'tenant_tool';
    };

export interface FlowIssue {
  code: FlowIssueCode;
  severity: 'error' | 'warning';
  message: string;
  stepId?: string;
  pointer?: string;
}

export interface FlowStepSummary {
  id: string;
  tool: string;
  source: FlowToolSource;
  tier: 1 | 2 | 3 | null;
  approval: 'default' | 'pre_approved';
}

export interface FlowValidationResult {
  valid: boolean;
  effectiveTier: 1 | 2 | 3 | null;
  steps: FlowStepSummary[];
  issues: FlowIssue[];
}

export interface FlowSummaryDto {
  id: string;
  slug: string;
  name: string;
  ownerScope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  status: FlowStatus;
  effectiveTier: 1 | 2 | 3;
  triggerType: string;
  definitionVersion: number;
  updatedAt: string;
  /** W5: the last admission refusal (a monthly cap or the active queue), for the list badge and the detail banner. */
  lastAdmissionRefusal: { at: string; code: FlowAdmissionRefusal } | null;
}

export interface FlowDetailDto extends FlowSummaryDto {
  description: string | null;
  definition: FlowDocumentV1;
  createdByUserId: string | null;
  aiSessionId: string | null;
  createdAt: string;
  enabledPublicationSeq: number | null;
  enabledAt: string | null;
  enabledByUserId: string | null;
  pausedReason: FlowPausedReason | null;
  preApprovalEligibility: Record<string, PreApprovalEligibility>;
  preApprovedStepIds: string[];
  /** W5: set for flows whose draft trigger is a webhook, else null. */
  webhook: FlowWebhookInfoDto | null;
  /** W5: this month's run counts against the effective caps; null when not computed. */
  usage: FlowUsageDto | null;
}
