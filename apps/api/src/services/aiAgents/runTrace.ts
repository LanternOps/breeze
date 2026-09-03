/**
 * Wave 6 PR 1 (#3828) — builds the stitched `GET /ai/agents/runs/:runId`
 * detail DTO out of the run row, its `AgentRunOutcome` (runLoop.ts), the
 * execution-ledger rows, and any linked action-intent rows.
 *
 * SAFE PROJECTION IS THE POINT OF THIS FILE. `OutcomeProposedAction.args`
 * (the raw tool input the model proposed) and `ai_tool_executions.toolInput`/
 * `toolOutput` are read from their source objects here — and deliberately
 * never assigned onto the returned DTO. `AiAgentRunTraceEntryDto`
 * (@breeze/shared) has no field that could carry them even by accident; see
 * its header for the full rationale. Pure and synchronous — every DB read
 * happens in the route handler, which hands this function already-loaded
 * rows, so this file is unit-testable against fixtures with no DB.
 */

import type {
  ActionIntentApprovalScope,
  ActionIntentStatus,
} from '../../db/schema/actionIntents';
import type {
  AgentRunOutcome,
  OutcomeExecutedAction,
  OutcomeProposedAction,
  TicketProposalOutcome,
} from './runLoop';
import { projectAlertVerdict } from './alertVerdicts';
import { projectNarrative } from './narrativeReport';
import { projectSweep } from './sweepFindings';
import {
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  type AiAgentKind,
  type AiAgentMode,
  type AiAgentRunDetailDto,
  type AiAgentRunIntentSummaryDto,
  type AiAgentRunLedgerEntryDto,
  type AiAgentRunStatus,
  type AiAgentRunTicketProposalDto,
  type AiAgentRunTraceEntryDto,
  type AiAgentTriggerKind,
  type AiToolStatus,
  type TicketTriageSkip,
} from '@breeze/shared';

export interface RunTraceRunInput {
  id: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
  alertId: string | null;
  /** Wave 6 PR 4 (#3828) — see AiAgentRunDetailDto.anomalyIncidentId. */
  anomalyIncidentId: string | null;
  triggerKind: AiAgentTriggerKind;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
  status: AiAgentRunStatus;
  summary: string | null;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — the `ai_agent_schedules`
   * row a `sweep`-profile run was fanned out from; `null` for every other
   * trigger (including a manually-triggered sweep).
   */
  scheduleId: string | null;
  /**
   * The raw `ai_agent_runs.trigger_ref` jsonb — a sweep run's carries
   * `{ scheduleId, occurrenceKey, sweepKinds }`. Read DEFENSIVELY by
   * `projectSweep` (any field may be missing or the wrong shape); `{}` for
   * every run that carries no trigger provenance.
   */
  triggerRef: Record<string, unknown>;
  /**
   * Phase 2 wave P2-3 (weekly org narrative), Task A7 — the `report_runs`
   * artifact this run's narrative was materialised into (`ON DELETE SET
   * NULL`, so it goes back to `null` if the artifact is later deleted).
   * `null` for every other profile and for a narrative run whose persistence
   * never committed.
   */
  reportRunId: string | null;
  /**
   * The raw `ai_agent_runs.outcome` jsonb column — typed `Record<string,
   * unknown>` at the schema layer (see aiAgents.ts) because Postgres jsonb
   * carries no compile-time shape. Treated here as a `Partial<AgentRunOutcome>`
   * (we are the only writer, via `runLoop.ts`'s `finishRun`), tolerantly: a
   * run enqueued before wave 4's `execution`/`verification` fields, or before
   * `runVerdict` existed at all (wave 3-era rows), reads back with those keys
   * simply absent — `AgentRunOutcome`'s own optionality already models that,
   * so no extra normalization pass is needed beyond defensive `?? []`/`?? null`
   * defaults against a maximally-corrupt row.
   */
  outcome: Record<string, unknown>;
  /**
   * P2-4 (#4191), Task A10 — the raw `ai_agent_runs.intent_ids` column. For
   * every OTHER profile this only ever lists intents still `pending_approval`
   * (see `routes/aiAgents.ts`'s own comment on this same column) — but for a
   * `triage`-profile run it is the ONE place `finalizeTicketTriage`
   * (runLoop.ts) records every `manage_tickets` intent `persistTicketTriage`
   * created, decided or not (a granted `ticket_autonomy` intent lands
   * `approved` at creation and is never pruned back out of this array). Since
   * `ticketProposal` is non-null only for a triage-profile run, and a triage
   * run's `intent_ids` column holds ONLY the ids this proposal produced,
   * `mapTicketProposal` below can project it directly as the DTO's
   * `intentIds` with no extra filtering.
   */
  intentIds: string[];
  turnCount: number;
  costCents: number;
  errorCode: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface RunTraceAgentInput {
  name: string;
  kind: AiAgentKind;
}

export interface RunTraceDeviceInput {
  hostname: string;
}

/** The safe-projected subset of one `ai_tool_executions` row. */
export interface RunTraceLedgerRowInput {
  toolName: string;
  status: AiToolStatus;
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

/**
 * Phase 2 wave P2-3, Task A7 — the three scalars the narrative DTO needs off
 * the linked `report_runs` artifact, projected out of its stored jsonb by
 * Postgres (`narrativeArtifactProjection`, narrativeReport.ts) so the route
 * never drags the whole result document — markdown included — across the wire
 * to read them. `null` when the run links no artifact.
 */
export interface RunTraceNarrativeArtifactInput {
  reportId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  contextTruncated: boolean;
}

/**
 * P2-4 (#4191), Task A10 — the safe-projected subset of one `ticket_drafts`
 * row LINKED TO THIS RUN (`run_id = run.id`), for `ticketProposal.draftsWritten`.
 * Deliberately id/kind only — never `content` (the draft's own text lives on
 * the ticket's "AI draft" surface, not this run-trace DTO — same posture as
 * every other mapper in this file).
 *
 * This is a LIVE query the route runs at projection time (see
 * `routes/aiAgents.ts`), not something read out of the persisted `outcome`
 * jsonb: unlike `intentIds` (decided synchronously inside
 * `finalizeTicketTriage`, before the run terminates), a draft intent that
 * was left `pending_approval` has not written its `ticket_drafts` row yet —
 * that only happens later, when a human approves and the intent RELEASES
 * (Task 5's `draft` executor). Reading it live is the only way this field is
 * ever correct for a still-pending draft intent.
 */
export interface RunTraceDraftRowInput {
  id: string;
  kind: 'reply' | 'resolution_note';
}

/** The safe-projected subset of one linked `action_intents` row. */
export interface RunTraceIntentRowInput {
  id: string;
  status: ActionIntentStatus;
  actionName: string;
  approvalScope: ActionIntentApprovalScope;
  decidedVia: string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapExecuted(action: OutcomeExecutedAction): AiAgentRunTraceEntryDto {
  return {
    kind: 'executed',
    tool: action.tool,
    action: action.action,
    result: action.result,
    durationMs: action.durationMs,
    execution: action.execution,
    verification: action.verification,
    verifyDetail: action.verifyDetail,
    actOpKey: action.actOpKey,
    actTargetName: action.actTargetName,
  };
}

/**
 * `action.args` — the raw tool input the model proposed — is intentionally
 * never read here. Every field below is display-safe by construction (see
 * `OutcomeProposedAction`'s own docstring in runLoop.ts).
 */
function mapProposed(action: OutcomeProposedAction): AiAgentRunTraceEntryDto {
  return {
    kind: 'proposed',
    tool: action.tool,
    action: action.action,
    intentId: action.intentId,
    intentError: action.intentError,
    downgradeReason: action.downgradeReason,
  };
}

function mapDenied(action: { tool: string; reason: string }): AiAgentRunTraceEntryDto {
  return { kind: 'denied', tool: action.tool, reason: action.reason };
}

/**
 * Named-field projection, not a spread: `TicketProposalOutcome` is already
 * text-only (no `args`/tool-payload field exists on the source type), but
 * picking fields by name here — rather than `{ ...outcome.ticketProposal }`
 * — means a future field added to the OUTCOME side does not silently reach
 * the wire until someone deliberately adds it here too, matching every other
 * mapper in this file.
 *
 * P2-4 (#4191) compile-forward fix: `TicketProposalOutcome` is now a type
 * alias onto `TicketTriageProposal` (`@breeze/shared`); this projects the new
 * shape's fields (`version`, `summary`, `fields`, `device`, `draftReply`,
 * `draftResolutionNote`, `notes`) rather than the retired
 * `proposedReply`/`proposedStatus`/`proposedPriority` fields.
 *
 * Task A10 wires `intentIds`/`draftsWritten` in: `intentIds` is the run's own
 * `intent_ids` column verbatim (see `RunTraceRunInput.intentIds`'s docstring
 * for why that is safe for a triage run specifically), left `undefined`
 * rather than `[]` when empty so an old run that predates A8's finalizer (or
 * one whose persistence step failed outright) renders as "no intents" rather
 * than a misleadingly-present empty list. `draftsWritten` is the caller's
 * live `ticket_drafts` query result (`RunTraceDraftRowInput[]`), same
 * undefined-when-empty treatment.
 *
 * Issue #4462: `skipped` is `outcome.ticketTriageSkipped` verbatim (already
 * the safe, display-string-only shape `persistTicketTriage` built — see
 * `TicketTriageSkip`'s own docstring), undefined-when-empty like its two
 * siblings above.
 */
function mapTicketProposal(
  proposal: TicketProposalOutcome,
  intentIds: string[],
  draftRows: RunTraceDraftRowInput[],
  skipped: TicketTriageSkip[] | undefined,
): AiAgentRunTicketProposalDto {
  return {
    version: proposal.version,
    summary: proposal.summary,
    fields: proposal.fields,
    device: proposal.device,
    draftReply: proposal.draftReply,
    draftResolutionNote: proposal.draftResolutionNote,
    notes: proposal.notes,
    intentIds: intentIds.length > 0 ? intentIds : undefined,
    draftsWritten: draftRows.length > 0
      ? draftRows.map((row) => ({ kind: row.kind, draftId: row.id }))
      : undefined,
    skipped: skipped && skipped.length > 0 ? skipped : undefined,
  };
}

/**
 * Concatenation order: executed, then proposed, then denied. `AgentRunOutcome`
 * stores these as three separate arrays (runLoop.ts pushes into whichever one
 * applies as a turn resolves) with no shared timestamp to interleave by, so
 * there is no true chronological merge to recover — this order groups the
 * timeline into "what happened" / "what's waiting" / "what was refused",
 * which is also the reading order the run-detail UI wants (Task 4).
 */
function buildTraceEntries(outcome: Partial<AgentRunOutcome>): AiAgentRunTraceEntryDto[] {
  return [
    ...asArray<OutcomeExecutedAction>(outcome.executedActions).map(mapExecuted),
    ...asArray<OutcomeProposedAction>(outcome.proposedActions).map(mapProposed),
    ...asArray<{ tool: string; reason: string }>(outcome.deniedActions).map(mapDenied),
  ];
}

function mapLedgerRow(row: RunTraceLedgerRowInput): AiAgentRunLedgerEntryDto {
  return {
    toolName: row.toolName,
    status: row.status,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    errorMessage: row.errorMessage,
  };
}

function mapIntentRow(row: RunTraceIntentRowInput): AiAgentRunIntentSummaryDto {
  return {
    id: row.id,
    status: row.status,
    actionName: row.actionName,
    approvalScope: row.approvalScope,
    decidedVia: row.decidedVia,
  };
}

export function buildRunTrace(
  run: RunTraceRunInput,
  // `null` when the agent row is RLS-invisible to the caller — a partner-wide
  // agent (#2135) is not reachable via breeze_has_partner_access from an
  // org-scoped context even though the run it produced (plain org-scoped)
  // is. The route left-joins ai_agents for exactly this reason: a run must
  // never disappear because its agent row did.
  agent: RunTraceAgentInput | null,
  device: RunTraceDeviceInput | null,
  ledgerRows: RunTraceLedgerRowInput[],
  intents: RunTraceIntentRowInput[],
  // Phase 2 wave P2-2, Task A7 — deviceId -> hostname for the device ids a
  // SWEEP run's findings name, built by the route from ONE batched,
  // org-pinned `devices` read (see `sweepFindingDeviceIds`). Defaults empty
  // so every non-sweep caller is unchanged; a missing id projects a `null`
  // hostname rather than dropping the finding.
  deviceHostnames: ReadonlyMap<string, string> = new Map(),
  // Phase 2 wave P2-3, Task A7 — the linked narrative artifact's scalars, or
  // `null` for every run that has none. Defaults null so every existing caller
  // is unchanged.
  narrativeArtifact: RunTraceNarrativeArtifactInput | null = null,
  // Phase 2 wave P2-4, Task A10 — the `ticket_drafts` rows LINKED TO THIS RUN
  // (`run_id = run.id`), for `ticketProposal.draftsWritten`. Defaults empty
  // so every non-triage caller (and every triage run with no draft rows) is
  // unchanged; see `RunTraceDraftRowInput`'s docstring for why this is a live
  // query rather than something read off the persisted outcome.
  draftRows: RunTraceDraftRowInput[] = [],
): AiAgentRunDetailDto {
  const outcome = run.outcome as Partial<AgentRunOutcome>;
  return {
    schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION,
    id: run.id,
    agentId: run.agentId,
    agentName: agent?.name ?? null,
    agentKind: agent?.kind ?? null,
    orgId: run.orgId,
    deviceId: run.deviceId,
    deviceHostname: device?.hostname ?? null,
    alertId: run.alertId,
    anomalyIncidentId: run.anomalyIncidentId,
    triggerKind: run.triggerKind,
    modeAtStart: run.modeAtStart,
    status: run.status,
    summary: run.summary,
    runVerdict: outcome.runVerdict ?? null,
    turnCount: run.turnCount,
    costCents: run.costCents,
    errorCode: run.errorCode,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    budgetExceeded: outcome.budgetExceeded ?? false,
    wallClockExceeded: outcome.wallClockExceeded ?? false,
    maxTurnsExceeded: outcome.maxTurnsExceeded ?? false,
    trace: buildTraceEntries(outcome),
    ledger: ledgerRows.map(mapLedgerRow),
    intents: intents.map(mapIntentRow),
    ticketProposal: outcome.ticketProposal
      ? mapTicketProposal(outcome.ticketProposal, run.intentIds, draftRows, outcome.ticketTriageSkipped)
      : null,
    // Phase 2 wave P2-1 (alert verdicts), Task 8: null for every full-profile
    // run and for a verdict-profile run that has not (yet, or ever)
    // produced one — see `projectAlertVerdict`'s own safe-projection
    // contract. `outcome.alertVerdictIntent` (review round 1, IMPORTANT 2)
    // carries the suggestion's intent-creation disposition alongside it.
    alertVerdict: projectAlertVerdict(outcome.alertVerdict, outcome.alertVerdictIntent),
    // Phase 2 wave P2-2 (scheduled sweeps), Task A7: null for every
    // full/verdict-profile run and for a sweep run that has not produced
    // findings — see `projectSweep`'s own safe-projection contract. The raw
    // `proposedAction` args on each finding are never carried; only the
    // proposal's disposition and, when one exists, its PENDING intent id.
    sweep: projectSweep(run, outcome, deviceHostnames),
    // Phase 2 wave P2-3 (weekly org narrative), Task A7: null for every
    // non-narrative run and for a narrative run that produced nothing — see
    // `projectNarrative`'s own safe-projection contract. The weekly
    // `NarrativeContext` the run was built from is a whole org's activity and
    // is never carried here (nor persisted at all); the derived markdown is
    // deliberately left out too, since the detail view renders the structured
    // sections itself.
    narrative: projectNarrative(run, outcome, narrativeArtifact),
    // Duplicated from `narrative.reportRunId` so a caller that only wants to
    // know "is there a downloadable artifact" doesn't have to reach through a
    // nullable sub-object. Read from the typed COLUMN, not the outcome jsonb.
    reportRunId: run.reportRunId ?? null,
  };
}
