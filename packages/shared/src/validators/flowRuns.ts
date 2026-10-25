import { z } from 'zod';
import { FLOW_STEP_ID_RE, FLOW_PAUSED_REASONS } from './flows';
import type { FlowDocumentV1, FlowPausedReason, FlowToolSource } from './flows';

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

export const FLOW_TRIGGER_KINDS = ['manual', 'schedule', 'event'] as const; // DB CHECK also admits 'webhook' | 'tool' (W05)
export type FlowTriggerKind = (typeof FLOW_TRIGGER_KINDS)[number];

export const FLOW_TRIGGERED_VIA = ['ui', 'api', 'ai_tool', 'scheduler', 'event'] as const; // W05 adds 'mcp' / 'webhook' with flow__<slug>
export type FlowTriggeredVia = (typeof FLOW_TRIGGERED_VIA)[number];

export const FLOW_STEP_ERROR_CODES = [
  'step_failed', 'rejected', 'drift', 'binding_drift', 'unknown_outcome', 'step_timeout', 'input_invalid',
  'reference_not_owned', 'tool_unavailable', 'tool_blocked', 'too_many_items', 'render_failed',
  'no_eligible_approvers', 'worker_lost', 'cancelled',
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
  definition: FlowDocumentV1;
  steps: FlowRunStepSummaryDto[]; // bodies via GET /runs/:runId/steps/:stepRowId
}

export function isTerminalFlowRunStatus(s: FlowRunStatus): s is FlowRunTerminalStatus {
  return !(FLOW_RUN_ACTIVE_STATUSES as readonly FlowRunStatus[]).includes(s);
}
