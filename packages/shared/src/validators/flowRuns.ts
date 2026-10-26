import { z } from 'zod';
import { FLOW_STEP_ID_RE, FLOW_PAUSED_REASONS } from './flows';
import type { FlowDetailDto, FlowDocumentV1, FlowPausedReason, FlowToolSource } from './flows';

/**
 * Flow run contracts (tool catalog W4, #5219). Browser safe.
 *
 * `FlowToolSource`, `FLOW_PAUSED_REASONS`, `FlowPausedReason` and `PreApprovalEligibility`
 * are defined in flows.ts (which flowRuns.ts imports) so the two modules never form an
 * import cycle; they are re-exported here for the run-side surface.
 */
export { FLOW_PAUSED_REASONS };
export type { FlowPausedReason, FlowToolSource };

export const FLOW_RUN_STATUSES = [
  'queued', 'running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired',
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const FLOW_RUN_ACTIVE_STATUSES = ['queued', 'running', 'waiting', 'awaiting_approval'] as const satisfies readonly FlowRunStatus[];
export type FlowRunTerminalStatus = Exclude<FlowRunStatus, (typeof FLOW_RUN_ACTIVE_STATUSES)[number]>;

export const FLOW_RUN_STEP_STATUSES = [
  'running', 'awaiting_approval', 'completed', 'failed', 'skipped', 'unknown_outcome', 'cancelled',
] as const;
export type FlowRunStepStatus = (typeof FLOW_RUN_STEP_STATUSES)[number];

export const FLOW_TRIGGER_KINDS = ['manual', 'schedule', 'event', 'webhook', 'tool'] as const;
export type FlowTriggerKind = (typeof FLOW_TRIGGER_KINDS)[number];

/**
 * Kind ↔ via pairs (DB `flow_runs_via_matches_kind_chk`): schedule⇔scheduler, event⇔event,
 * webhook⇔webhook; tool ⇒ ai_tool | mcp | ai_agent; manual ⇒ ui | api | ai_tool (W04 `run_flow`).
 */
export const FLOW_TRIGGERED_VIA = ['ui', 'api', 'ai_tool', 'scheduler', 'event', 'webhook', 'mcp', 'ai_agent'] as const;
export type FlowTriggeredVia = (typeof FLOW_TRIGGERED_VIA)[number];

export const FLOW_STEP_ERROR_CODES = [
  'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
  'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
  'no_eligible_approvers', 'worker_lost', 'cancelled',
  // W5 built-ins (#5220)
  'egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached',
] as const;
export type FlowStepErrorCode = (typeof FLOW_STEP_ERROR_CODES)[number];

// Chain-depth refusals create no run, so they are a log/metric (flow_chain_depth_refused), not an error code.
export const FLOW_RUN_ERROR_CODES = [
  ...FLOW_STEP_ERROR_CODES, 'run_timeout', 'flow_disabled', 'flows_disabled', 'delegator_inactive', 'org_merged',
] as const;
export type FlowRunErrorCode = (typeof FLOW_RUN_ERROR_CODES)[number];

export const FLOW_RUN_LIMITS = {
  maxActiveMs: 3_600_000,
  maxActivePerOwner: 1000,
  maxChainDepth: 3,
  maxStoredOutputBytes: 262_144,
  defaultMaxRunningPerOwner: 20,
  slotRetryDelayMs: 15_000,
  leaseTtlMs: 360_000,
  leaseRenewEveryMs: 60_000,
  // W5 (#5220)
  webhookMaxBodyBytes: 262_144,
  webhookTimestampWindowMs: 300_000,
  httpTimeoutMs: 30_000,
  httpMaxResponseBytes: 1_048_576,
  httpMaxRequestBodyBytes: 262_144,
  httpPerRunMax: 100,
  notifyPerRunMax: 20,
  aiMaxTurns: 8,
  aiMaxTools: 20,
  aiOutputSchemaMaxBytes: 16_384,
  /** Concurrent for-each units one worker process runs at once (each holds DB connections). */
  maxParallelUnitsPerProcess: 20,
  flowToolsPerSessionMax: 20,
} as const;

export const flowManualRunRequestSchema = z.object({
  orgId: z.string().uuid().optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
export type FlowManualRunRequest = z.infer<typeof flowManualRunRequestSchema>;

export const flowEnableRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  preApprovedStepIds: z.array(z.string().regex(FLOW_STEP_ID_RE)).max(50).default([]),
});
export type FlowEnableRequest = z.infer<typeof flowEnableRequestSchema>;

/** `POST /flows/:id/enable` 200 body. */
export interface FlowEnableResultDto {
  ok: true;
  flow: FlowDetailDto;
  publication: { id: string; publicationSeq: number; definitionVersion: number };
  /**
   * W5 (#10270): true when this enable cleared the flow's webhook secret,
   * because it was minted against an older draft than the one just published.
   * The flow is live, but every delivery gets 401 until someone creates a new
   * secret (`POST /flows/:id/webhook-secret`, shown once) and gives it to the
   * sender. Always false for a flow whose trigger is not a webhook.
   */
  webhookSecretInvalidated: boolean;
}

interface FlowRunStepBase {
  id: string;
  stepId: string;
  itemIndex: number | null;
  attempt: number;
  tool: string;
  toolSource: FlowToolSource;
  tier: 1 | 2 | 3;
  status: FlowRunStepStatus;
  outputTruncated: boolean;
  bodiesPruned: boolean;
  errorCode: FlowStepErrorCode | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** W5: model usage of an `ai` step; null for every other step. */
  aiUsage: { inputTokens: number; outputTokens: number; costCents: number } | null;
}

export type FlowRunStepSummaryDto = FlowRunStepBase & (
  | { approvalMode: 'none' | 'pre_approved'; actionIntentId: null; approvedByUserId: null }
  | { approvalMode: 'intent'; actionIntentId: string; approvedByUserId: string | null }
);

/** `renderedInput` / `output` are null after retention pruning. */
export type FlowRunStepDetailDto = FlowRunStepSummaryDto & { renderedInput: unknown | null; output: unknown | null };

export interface FlowRunSummaryDto {
  id: string;
  flowId: string;
  flowName: string;
  orgId: string;
  definitionVersion: number;
  triggerKind: FlowTriggerKind;
  triggeredVia: FlowTriggeredVia;
  status: FlowRunStatus;
  errorCode: FlowRunErrorCode | null;
  currentStepId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface FlowRunDetailDto extends FlowRunSummaryDto {
  triggerPayload: unknown;
  inputs: unknown;
  error: string | null;
  preApprovalsHonored: boolean;
  chainDepth: number;
  publicationSeq: number;
  wakeAt: string | null;
  bodiesPrunedAt: string | null;
  /** W5: AI tokens this run's `ai` steps used, against the per-run ceiling. */
  aiTokensUsed: number;
  /** W5: the agent run that started this run (`triggeredVia = 'ai_agent'`), else null. */
  parentAgentRunId: string | null;
  definition: FlowDocumentV1;
  steps: FlowRunStepSummaryDto[]; // bodies via GET /runs/:runId/steps/:stepRowId
}

export function isTerminalFlowRunStatus(s: FlowRunStatus): s is FlowRunTerminalStatus {
  return !(FLOW_RUN_ACTIVE_STATUSES as readonly FlowRunStatus[]).includes(s);
}
