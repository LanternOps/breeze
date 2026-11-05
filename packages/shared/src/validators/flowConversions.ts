import { z } from 'zod';
import { FLOW_STEP_ID_RE } from './flows';
import type { FlowDocumentV1 } from './flows';
import { FLOW_WEBHOOK_DELIVERY_ID_RE } from './flowWebhooks';

/**
 * Legacy automation ("Job") → flow conversion contracts (tool catalog W6, #5221). Browser safe.
 *
 * A conversion is an append-only generation in `flow_automation_conversions`
 * (`shadow → switched → reverted`). Cross-engine idempotency is the automation-wide
 * `automation_occurrence_claims` table, keyed by `occurrenceKey.*`.
 */

export const FLOW_CONVERSION_STATES = ['shadow', 'switched', 'reverted'] as const;
export type FlowConversionState = (typeof FLOW_CONVERSION_STATES)[number];

export const FLOW_CONVERSION_FIDELITIES = ['exact', 'needs_review', 'unconvertible'] as const;
export type FlowConversionFidelity = (typeof FLOW_CONVERSION_FIDELITIES)[number];

export const FLOW_CONVERSION_FINDING_SEVERITIES = ['info', 'review', 'blocker'] as const;
export type FlowConversionFindingSeverity = (typeof FLOW_CONVERSION_FINDING_SEVERITIES)[number];

export const OCCURRENCE_CLAIM_ENGINES = ['legacy', 'flow'] as const;
export type OccurrenceClaimEngine = (typeof OCCURRENCE_CLAIM_ENGINES)[number];

const BLOCKER_CODES = [
  'flows_disabled', 'managed_row', 'policy_workflow', 'already_retired', 'compliance_remediation_target',
  'event_dispatch_not_durable', 'event_filter_not_strict', 'event_filter_null', 'cron_semantics_differ',
  'condition_unknown_type', 'targets_over_cap', 'partner_wide_group_target', 'run_as_elevated',
  'restart_service_monitor_only', 'command_mixed_os', 'notify_per_run_cap', 'channel_type_not_supported',
  'deploy_software_unmapped', 'monthly_cap_exceeded', 'reference_not_owned',
  // A partner-wide webhook Job has no org resolver; legacy text with a '{{' a flow would read as a template.
  'partner_wide_webhook', 'text_template_unsupported',
] as const;
const REVIEW_CODES = [
  'event_filter_string_coercion', 'approval_each_run', 'command_becomes_script', 'partner_wide_org_set_differs',
  'failure_notice_cap', 'owner_cap_pressure', 'site_ceiling_removed', 'webhook_body_shape',
  'legacy_secret_header_possible', 'name_truncated',
] as const;
const INFO_CODES = [
  'duration_minutes_ignored', 'schedule_outage_catch_up', 'queued_is_success', 'severity_mapped',
  'notification_emails_unused', 'webhook_url_changes', 'delegator_pause',
] as const;

export const FLOW_CONVERSION_FINDING_CODES = [...BLOCKER_CODES, ...REVIEW_CODES, ...INFO_CODES] as const;
export type FlowConversionFindingCode = (typeof FLOW_CONVERSION_FINDING_CODES)[number];

export const FLOW_CONVERSION_FINDING_SEVERITY: Readonly<Record<FlowConversionFindingCode, FlowConversionFindingSeverity>> =
  Object.freeze({
    ...Object.fromEntries(BLOCKER_CODES.map((c) => [c, 'blocker'])),
    ...Object.fromEntries(REVIEW_CODES.map((c) => [c, 'review'])),
    ...Object.fromEntries(INFO_CODES.map((c) => [c, 'info'])),
  } as Record<FlowConversionFindingCode, FlowConversionFindingSeverity>);

export interface FlowConversionFinding {
  code: FlowConversionFindingCode;
  severity: FlowConversionFindingSeverity;
  /** Index into the legacy `actions` array, or null for an automation-level finding. */
  actionIndex: number | null;
  /** ≤ 500 chars; ids and field names only — never a script body, a command or a secret. */
  detail: string;
}

export const FLOW_CONVERSION_FINDING_DETAIL_MAX = 500;

/** Any blocker ⇒ unconvertible; else any review ⇒ needs_review; else exact. */
export function fidelityOf(findings: readonly FlowConversionFinding[]): FlowConversionFidelity {
  if (findings.some((f) => f.severity === 'blocker')) return 'unconvertible';
  if (findings.some((f) => f.severity === 'review')) return 'needs_review';
  return 'exact';
}

// ── Occurrence keys ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * The DB `automation_occurrence_claims_key_chk` pattern, kept identical here so a
 * builder can never produce a key the table refuses (pinned by the schema test).
 */
export const OCCURRENCE_KEY_RE =
  /^(event:[0-9a-f-]{36}|schedule:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z|webhook:sig:[0-9a-f]{64}|webhook:dlv:[A-Za-z0-9._:-]{1,128})$/;

export const occurrenceKey = {
  /** `event:<eventId>` — the platform event id (a lowercase uuid). */
  event(eventId: string): string {
    const id = eventId.toLowerCase();
    if (!UUID_RE.test(id)) throw new Error('occurrenceKey.event: the event id is not a uuid');
    return `event:${id}`;
  },
  /** `schedule:<UTC ISO minute>`, e.g. `schedule:2027-01-09T03:00Z`, whatever the schedule's timezone. */
  schedule(instant: Date): string {
    const ms = instant.getTime();
    if (!Number.isFinite(ms)) throw new Error('occurrenceKey.schedule: invalid instant');
    return `schedule:${new Date(ms).toISOString().slice(0, 16)}Z`;
  },
  /** `webhook:sig:<signatureDigest>` — sha256 hex of the signed material. */
  webhookSig(digest: string): string {
    if (!SHA256_HEX_RE.test(digest)) throw new Error('occurrenceKey.webhookSig: the digest is not lowercase sha256 hex');
    return `webhook:sig:${digest}`;
  },
  /** `webhook:dlv:<deliveryId>` — the sender's delivery id (`FLOW_WEBHOOK_DELIVERY_ID_RE`). */
  webhookDelivery(id: string): string {
    if (!FLOW_WEBHOOK_DELIVERY_ID_RE.test(id)) throw new Error('occurrenceKey.webhookDelivery: invalid delivery id');
    return `webhook:dlv:${id}`;
  },
} as const;

// ── Constants (plan Global Constraints) ──────────────────────────────────────

/** 10 min: longer than the 300 s HMAC window and the 5 min legacy Redis replay TTL. */
export const CONVERSION_MIN_SHADOW_MS = 600_000;
export const CONVERSION_SHADOW_MIN_RUNS = 3;
/** 7 days. */
export const CONVERSION_SHADOW_MIN_MS = 604_800_000;
/** The converter refuses more current targets than this (run time refuses above FLEET_MAX_TARGETS). */
export const CONVERSION_TARGET_HEADROOM = 400;
/** = FLOW_LIMITS.maxForEachItems. */
export const FLEET_MAX_TARGETS = 500;
export const SWITCH_LEAD_MS = 60_000;
/** 30 days. */
export const LEGACY_DRAIN_MIN_MS = 2_592_000_000;

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface FlowConversionGeneratedScriptDto {
  stepId: string;
  name: string;
  language: 'bash' | 'powershell' | 'cmd';
  body: string;
}

export interface FlowConversionPreviewDto {
  automationId: string;
  fidelity: FlowConversionFidelity;
  findings: FlowConversionFinding[];
  document: FlowDocumentV1 | null;
  preApprovalCandidates: { stepId: string; currentTargetCount: number | null }[];
  generatedScripts: FlowConversionGeneratedScriptDto[];
  sourceDigest: string;
  documentDigest: string | null;
  targetCount: number | null;
  estimatedMonthlyRuns: number | null;
}

export const SHADOW_DIVERGENCE_KINDS = ['trigger_mismatch', 'target_set_mismatch', 'would_park', 'over_cap'] as const;
export type ShadowDivergenceKind = (typeof SHADOW_DIVERGENCE_KINDS)[number];

export const FLOW_CONVERSION_SWITCH_BLOCKERS = [
  'shadow_too_new', 'shadow_too_short', 'shadow_divergent', 'source_changed', 'unconvertible',
] as const;
export type FlowConversionSwitchBlocker = (typeof FLOW_CONVERSION_SWITCH_BLOCKERS)[number];

export interface FlowConversionDto {
  id: string;
  automationId: string;
  flowId: string;
  state: FlowConversionState;
  fidelity: FlowConversionFidelity;
  findings: FlowConversionFinding[];
  createdAt: string;
  switchAt: string | null;
  revertAt: string | null;
  shadow: {
    runs: number;
    divergences: number;
    startedAt: string;
    lastAt: string | null;
    lastDivergence: { kind: ShadowDivergenceKind; at: string; detail: string } | null;
  };
  switchBlockedBy: FlowConversionSwitchBlocker | null;
}

export const conversionSwitchRequestSchema = z.object({
  expectedFlowVersion: z.number().int().min(1),
  preApprovals: z.array(z.object({
    stepId: z.string().regex(FLOW_STEP_ID_RE),
    maxTargets: z.number().int().min(1).max(FLEET_MAX_TARGETS),
  }).strict()).max(50).default([]),
  acceptScopeWidening: z.boolean().default(false),
  acceptDelegatorLifecycle: z.literal(true),
  acknowledgeDivergence: z.boolean().default(false),
}).strict();
export type ConversionSwitchRequest = z.infer<typeof conversionSwitchRequestSchema>;

/** The additive `conversion` field on automation reads (Decision 9): exactly these three keys, or null. */
export interface AutomationConversionSummaryDto {
  id: string;
  state: FlowConversionState;
  flowId: string;
}
