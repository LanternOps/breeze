import type { AiApprovalScope, AiToolStatus } from './ai';
import type {
  ActExecutionVerdict,
  ActVerificationVerdict,
  AgentRunVerdict,
  AiAgentKind,
  AiAgentMode,
  AiAgentRunStatus,
  AiAgentTriggerKind,
} from './aiAgents';

/**
 * Wave 6 PR 1 (#3828) — the execution-trace DTOs: what `GET /ai/agents/runs`
 * (org-wide keyset list) and `GET /ai/agents/runs/:runId` (stitched detail)
 * actually put on the wire.
 *
 * These are NOT the raw `ai_agent_runs` row, the raw `AgentRunOutcome`
 * (services/aiAgents/runLoop.ts), or the raw `ai_tool_executions` /
 * `action_intents` rows. Every one of those carries a raw-tool-input field
 * somewhere (`OutcomeProposedAction.args`, `ai_tool_executions.toolInput` /
 * `toolOutput`, `action_intents.arguments`) — model-directed tool calls can
 * carry credentials, file contents, or anything else the model chose to pass
 * as an argument, and none of that is safe to hand a browser tab.
 *
 * `AiAgentRunTraceEntryDto` is the load-bearing type: its three variants
 * between them have NO field named `args`, `input`, `output`, `arguments`,
 * `toolInput`, or `toolOutput` — display-only fields (tool/action, verdicts,
 * a short human-readable `verifyDetail`, sanitized `actOpKey`/`actTargetName`,
 * denial `reason`) are all that exist on the type. A field that would leak
 * a raw payload cannot be added to this union without every call site (and
 * `runTrace.test.ts`'s tripwire) visibly failing to compile/type-check — the
 * leak is impossible by construction, not just avoided by convention.
 *
 * `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` is the single source both here and in the
 * route-level serialization test use to assert no forbidden key ever reaches
 * `JSON.stringify(response)` — see Global Constraints in the wave-6.1 plan.
 */
export const AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS = ['args', 'toolInput', 'toolOutput', 'arguments'] as const;

/** All DTOs in this file are versioned (Partner-API schema precedent,
 *  routes/partnerApi/schemas.ts): a shape change bumps this, never mutates
 *  version 1 in place. */
export const AI_AGENT_RUN_DTO_SCHEMA_VERSION = 1 as const;

/**
 * One row of `GET /ai/agents/runs` — org-wide, keyset-paginated. Deliberately
 * carries NO outcome payload (no trace, no ledger, no intents) — that is the
 * whole point of a list endpoint versus the detail one; a caller that needs
 * the trace fetches `GET /ai/agents/runs/:runId`.
 */
export interface AiAgentRunListItemDto {
  schemaVersion: 1;
  id: string;
  agentId: string;
  /**
   * Left-joined from `ai_agents.name` — null when the agent row is invisible
   * under the caller's RLS context. `ai_agents` is a dual-ownership table
   * (#2135): an org-scoped caller's `breeze_has_partner_access` is always
   * false (their token carries no accessible partner ids), so a partner-wide
   * agent's row never joins for them even though the run itself (plain
   * org-scoped) does. Never assume the caller already has the agent list
   * loaded even when this is non-null.
   */
  agentName: string | null;
  orgId: string;
  /**
   * Left-joined from `organizations.name` — the web list's fleet
   * (All-organizations) view shows an Organization column so cross-org rows
   * stay legible, mirroring `routes/alerts/alerts.ts`'s `orgName` join. Runs
   * are plain org-scoped (`ai_agent_runs.org_id` is NOT NULL, unlike the
   * dual-ownership `ai_agents` row), so this is null only in the
   * practically-unreachable case of a deleted/renamed organizations row, not
   * for the partner-wide-agent RLS gap `agentName` above documents.
   */
  orgName: string | null;
  deviceId: string | null;
  status: AiAgentRunStatus;
  triggerKind: AiAgentTriggerKind;
  /** Absent until `finishRun` computes it (services/aiAgents/runLoop.ts); null for any run that hasn't reached a terminal rollup yet. */
  runVerdict: AgentRunVerdict | null;
  queuedAt: string;
  finishedAt: string | null;
  costCents: number;
}

/**
 * The safe projection of one `OutcomeExecutedAction` (runLoop.ts). `result`
 * and `durationMs` exist for every entry; the `execution`/`verification`/
 * `verifyDetail`/`actOpKey`/`actTargetName` fields are act-mode-only and
 * absent for an ordinary auto-executed Tier-1/2 call, exactly mirroring the
 * source type's own optionality.
 */
export interface AiAgentRunTraceExecutedEntryDto {
  kind: 'executed';
  tool: string;
  action?: string;
  result: 'ok' | 'failed';
  durationMs: number;
  execution?: ActExecutionVerdict;
  verification?: ActVerificationVerdict;
  /** Short, human-readable — never a raw tool input/output blob. */
  verifyDetail?: string;
  actOpKey?: string;
  actTargetName?: string;
}

/**
 * The safe projection of one `OutcomeProposedAction` (runLoop.ts). Note what
 * is missing on purpose: `args` (the raw tool input the model proposed) is
 * NEVER carried onto this DTO.
 */
export interface AiAgentRunTraceProposedEntryDto {
  kind: 'proposed';
  tool: string;
  action?: string;
  intentId?: string;
  intentError?: string;
  downgradeReason?: string;
}

/** The safe projection of one `outcome.deniedActions` entry (runLoop.ts). */
export interface AiAgentRunTraceDeniedEntryDto {
  kind: 'denied';
  tool: string;
  reason: string;
}

/**
 * The trace-entry union. See the file header — the absence of any
 * args/input/output-shaped field on every variant is the safety property.
 */
export type AiAgentRunTraceEntryDto =
  | AiAgentRunTraceExecutedEntryDto
  | AiAgentRunTraceProposedEntryDto
  | AiAgentRunTraceDeniedEntryDto;

/**
 * The safe projection of one `ai_tool_executions` row. Deliberately omits
 * `toolInput`/`toolOutput`/`approvedBy`/`commandId`/`delegantToolCallId` —
 * only display-safe fields survive onto the wire.
 */
export interface AiAgentRunLedgerEntryDto {
  toolName: string;
  status: AiToolStatus;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

/**
 * The safe projection of one linked `action_intents` row. Deliberately omits
 * `arguments` (raw tool input the intent would execute) and every other
 * content/target-summary column — this is a status-and-provenance summary
 * for the trace view to link onward to `/approvals`, not the intent detail
 * itself.
 */
export interface AiAgentRunIntentSummaryDto {
  id: string;
  status: string;
  actionName: string;
  approvalScope: AiApprovalScope;
  decidedVia: string | null;
}

/**
 * `GET /ai/agents/runs/:runId` — the stitched detail: the run row's
 * display-safe fields, the SAFE outcome projection (`trace`), the execution
 * ledger, and a summary of any linked action intents. Built by
 * `buildRunTrace` (services/aiAgents/runTrace.ts).
 */
/**
 * `GET /ai/agents/exposure-budget` — the org+kind unattended-exposure
 * readout (Wave 6 PR 1, #3828), reusing `computeExposureBudget`
 * (services/actionIntents/exposureBudget.ts) — the SAME two read queries
 * `policyDecide.ts`'s authorize transaction uses to gate a policy decision,
 * called here read-only for display rather than enforcement.
 *
 * `recordedOnly` is always `true`: every figure on this DTO reflects rows
 * already written to `ai_unattended_exposure`, not a live/projected count —
 * unlike the enforcement path (which projects the CURRENT device being
 * decided into `distinctDevices`), this readout has no in-flight decision to
 * project, so `distinctDevices` is exactly what is currently recorded in the
 * trailing `windowHours` window.
 *
 * `accountingMode` is `'full'` when `policyDecideEnabled()` is on (every
 * `act`-mode unattended authorization the policy-decide lane grants is
 * recorded here) and `'partial'` while the flag is dark — the act lane can
 * still record `source: 'act'` exposure rows independent of this flag, so
 * the count is never zero-meaning, just an undercount of what policy-decide
 * WOULD have added, relative to what an operator might expect once they
 * flip the flag on.
 */
export interface ExposureBudgetDto {
  schemaVersion: 1;
  orgId: string;
  agentId: string;
  /** Distinct devices with a recorded exposure row in the trailing window. */
  distinctDevices: number;
  contractDeviceCount: number;
  maxFleetPercentPerDay: number;
  /** floor(contractDeviceCount * maxFleetPercentPerDay / 100) — the same
   *  formula `runAuthorizeTransaction` enforces against. */
  allowance: number;
  policyDecisionsToday: number;
  maxPolicyDecisionsPerDay: number;
  windowHours: 24;
  recordedOnly: true;
  accountingMode: 'partial' | 'full';
}

export interface AiAgentRunDetailDto {
  schemaVersion: 1;
  id: string;
  agentId: string;
  /** Left-joined from `ai_agents` — null under the same RLS-visibility gap
   *  documented on `AiAgentRunListItemDto.agentName` above. */
  agentName: string | null;
  agentKind: AiAgentKind | null;
  orgId: string;
  deviceId: string | null;
  deviceHostname: string | null;
  alertId: string | null;
  triggerKind: AiAgentTriggerKind;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
  status: AiAgentRunStatus;
  /** `ai_agent_runs.summary` — narrative text, never a tool payload. */
  summary: string | null;
  runVerdict: AgentRunVerdict | null;
  turnCount: number;
  costCents: number;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  budgetExceeded: boolean;
  wallClockExceeded: boolean;
  maxTurnsExceeded: boolean;
  trace: AiAgentRunTraceEntryDto[];
  ledger: AiAgentRunLedgerEntryDto[];
  intents: AiAgentRunIntentSummaryDto[];
}
