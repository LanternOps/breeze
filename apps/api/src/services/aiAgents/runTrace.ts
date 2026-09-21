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
import { projectFleetDesign } from './fleetDesignReport';
import { projectNarrative } from './narrativeReport';
import { countFindingsToReview } from './runFindings';
import { projectSweep } from './sweepFindings';
import { projectPatch } from './patchPlan';
import {
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  type AiAgentKind,
  type AiAgentMode,
  type AiAgentRunDetailDto,
  type AiAgentRunIntentSummaryDto,
  type AiAgentRunSweepProposalOutcome,
  type AiAgentRunLedgerEntryDto,
  type AiAgentRunNarrativeDeliveryDto,
  type AiAgentRunStatus,
  type AiAgentRunTicketProposalDto,
  type AiAgentRunTraceEntryDto,
  type AiAgentRunWorkspaceDto,
  type AiAgentRunWorkspaceStepDto,
  type AiRunArtifactDto,
  type AiAgentTriggerKind,
  type AiToolStatus,
  type TicketTriageSkip,
  AnalysisOutcomeDto,
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
   * Execution plane W04 — `ai_agent_runs.compute_cents`, the settled sandbox
   * charge. `null`/absent for every run that never built a workspace, which
   * the projection reads as 0.
   */
  computeCents?: number | null;
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
 * Fleet Designer W01 (#5651), Task 9 — the scalars the design DTO needs off
 * the linked `report_runs` artifact, projected out of its stored jsonb by
 * Postgres (`fleetDesignArtifactProjection`, fleetDesignReport.ts) so the
 * route never drags the whole result document — the full outcome, scripts
 * included — across the wire to read them. `null` when the run links no
 * artifact. Direct sibling of `RunTraceNarrativeArtifactInput` above.
 */
export interface RunTraceFleetDesignArtifactInput {
  reportId: string | null;
  generatedAt: string | null;
  evidenceTruncated: boolean;
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
  /**
   * Issue #4467 — the row's live `content`. Read here so `mapTicketProposal`
   * can derive `draftReply`/`draftResolutionNote` from this SAME query
   * rather than always echoing `TicketProposalOutcome.draftReply`/
   * `draftResolutionNote` (the persisted-at-proposal-time text), which could
   * go stale the moment the draft is edited on the ticket's "AI draft"
   * surface after it's written. Never placed on the wire DTO's
   * `draftsWritten` entries themselves (see that field's own docstring) —
   * it feeds the derivation only, so the content is exposed exactly once.
   */
  content: string;
  /**
   * Issue #4467 review round 1 — more than one row of the SAME `kind` can be
   * linked to one run_id (the `draft` tool executor supersedes-then-inserts
   * on every call, including its own unique-violation retry path; the
   * `ticket_drafts_active_uq` uniqueness is scoped to `(ticket_id, kind)`,
   * not `(run_id, kind)`). `state` lets `pickDraftText` prefer the row that
   * is still `active` over a `superseded`/`consumed`/`discarded` one sharing
   * this run_id + kind, rather than picking whichever the query happened to
   * return first.
   */
  state: 'active' | 'consumed' | 'discarded' | 'superseded';
}

/** The safe-projected subset of one linked `action_intents` row. */
export interface RunTraceIntentRowInput {
  id: string;
  status: ActionIntentStatus;
  actionName: string;
  approvalScope: ActionIntentApprovalScope;
  decidedVia: string | null;
}

/**
 * #4442 W05 — the live per-intent outcome the sweep projection joins on.
 * `decided_via = 'policy'` + `approved` is `auto_executing`: the act-mode
 * case, which reads very differently from a human approval.
 */
export function sweepProposalOutcome(
  row: Pick<RunTraceIntentRowInput, 'status' | 'decidedVia'>,
): AiAgentRunSweepProposalOutcome {
  switch (row.status) {
    case 'pending_approval':
      return 'pending';
    case 'approved':
    case 'executing':
      return row.decidedVia === 'policy' ? 'auto_executing' : 'pending';
    case 'completed':
      return 'executed';
    case 'failed':
      return 'failed';
    case 'rejected':
    case 'cancelled':
      return 'declined';
    case 'expired':
      return 'expired';
    default:
      // The cases above exhaustively cover `actionIntentStatusEnum` today, so
      // this is dead code — until someone adds a ninth status and does not
      // come here. Reporting an unknown TERMINAL state as `pending` would tell
      // an operator to go approve something that has already finished, so the
      // fallback is loud rather than silent.
      console.warn('[runTrace] unmapped action-intent status on a sweep proposal', {
        status: row.status, decidedVia: row.decidedVia,
      });
      return 'pending';
  }
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
 * Issue #4467: `draftReply`/`draftResolutionNote` used to be projected
 * straight off `proposal` — the text the model proposed, frozen at proposal
 * time — independently of `draftsWritten`, which reads live off
 * `ticket_drafts`. The two are two representations of the SAME draft and
 * could disagree: once a draft is written, a technician can edit its content
 * on the ticket's "AI draft" surface (`TicketWorkbench.tsx`), or a retry can
 * supersede it, and the run-detail page would keep showing the now-stale
 * originally-proposed text forever. `pickDraftText` below makes the live
 * `ticket_drafts` row (via `draftRows`, the same query `draftsWritten` is
 * built from) authoritative for its kind whenever one exists — a derivation
 * off ONE source, not a second copy kept in sync — falling back to the
 * proposal's own text only pre-write, when no row exists yet (a draft intent
 * left `pending_approval` hasn't released into a `ticket_drafts` row — see
 * `RunTraceDraftRowInput`'s docstring — so the proposal text is the only
 * preview available before a technician approves it).
 *
 * Issue #4462: `skipped` is `outcome.ticketTriageSkipped` verbatim (already
 * the safe, display-string-only shape `persistTicketTriage` built — see
 * `TicketTriageSkip`'s own docstring), undefined-when-empty like its two
 * siblings above.
 */
/**
 * Issue #4467 review round 1 — more than one `draftRows` entry can share the
 * same `kind` for a single run (see `RunTraceDraftRowInput.state`'s
 * docstring), so picking the first match isn't safe by construction. Prefers
 * the row that is still `active` for this kind; if none is (every write of
 * that kind was later superseded/consumed/discarded, or the route's query
 * ordering changes), falls back to `draftRows[0]` of that kind — the route
 * orders `draftRows` newest-first (`ORDER BY created_at DESC`), so that's
 * the most recently written row, the next-best approximation of "current".
 */
function pickDraftText(
  proposalText: string | undefined,
  draftRows: RunTraceDraftRowInput[],
  kind: 'reply' | 'resolution_note',
): string | undefined {
  const matches = draftRows.filter((row) => row.kind === kind);
  const written = matches.find((row) => row.state === 'active') ?? matches[0];
  return written ? written.content : proposalText;
}

export function mapTicketProposal(
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
    draftReply: pickDraftText(proposal.draftReply, draftRows, 'reply'),
    draftResolutionNote: pickDraftText(proposal.draftResolutionNote, draftRows, 'resolution_note'),
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

const WORKSPACE_STEP_LANGUAGES = new Set(['bash', 'python', 'node']);

/**
 * Project `ai_run_workspaces.steps` (jsonb, written by the worker) into the
 * wire shape (execution-plane spec §5.8). Defensive on purpose: this column is
 * `excludedOpen` open-ended content, and the run page's whole value is that a
 * technician can TRUST what it says ran. A malformed entry is dropped, never
 * coerced — a step rendered with `exitCode: undefined` reads as success, which
 * is the one lie this surface must not tell.
 */
export function mapWorkspaceSteps(raw: unknown): AiAgentRunWorkspaceStepDto[] {
  if (!Array.isArray(raw)) return [];
  const steps: AiAgentRunWorkspaceStepDto[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.ordinal !== 'number') continue;
    if (typeof e.language !== 'string' || !WORKSPACE_STEP_LANGUAGES.has(e.language)) continue;
    if (typeof e.durationMs !== 'number') continue;
    if (e.exitCode !== null && typeof e.exitCode !== 'number') continue;
    steps.push({
      ordinal: e.ordinal,
      language: e.language as 'bash' | 'python' | 'node',
      scriptArtifactHandle:
        typeof e.scriptArtifactHandle === 'string' ? e.scriptArtifactHandle : null,
      exitCode: (e.exitCode as number | null) ?? null,
      timedOut: e.timedOut === true,
      durationMs: e.durationMs,
      stdoutArtifactHandle:
        typeof e.stdoutArtifactHandle === 'string' ? e.stdoutArtifactHandle : null,
    });
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The `ai_run_workspaces` scalars the run page projects (spec §6.2).
 * `provider_ref` is deliberately absent — it is a vendor handle the reaper
 * needs and nothing outside the API has any use for.
 */
export interface RunWorkspaceRowInput {
  backend: string;
  region: 'eu' | 'us';
  status: string;
  bootstrapHash: string | null;
  /** Exact selected image reference; null for legacy/unknown runtimes. */
  runtimeImage: string | null;
  createdAt: Date;
  readyAt: Date | null;
  destroyedAt: Date | null;
  cpuMs: number | null;
  wallMs: number | null;
  memAllocatedMb: number | null;
  stagedBytes: number;
  artifactBytes: number;
  stepCount: number;
  steps: unknown;
}

function mapWorkspace(row: RunWorkspaceRowInput | null): AiAgentRunWorkspaceDto | null {
  if (!row) return null;
  return {
    backend: row.backend,
    region: row.region,
    status: row.status,
    bootstrapHash: row.bootstrapHash,
    runtimeImage: row.runtimeImage ?? null,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    destroyedAt: row.destroyedAt?.toISOString() ?? null,
    cpuMs: row.cpuMs,
    wallMs: row.wallMs,
    memAllocatedMb: row.memAllocatedMb,
    // bigint columns come back as strings on some drivers; the wire type is a number.
    stagedBytes: Number(row.stagedBytes),
    artifactBytes: Number(row.artifactBytes),
    stepCount: row.stepCount,
    steps: mapWorkspaceSteps(row.steps),
  };
}

export function buildRunTrace(
  run: RunTraceRunInput,
  // `null` when the agent row is RLS-invisible to the caller. A partner-wide
  // agent (#2135) is not reachable via breeze_has_partner_access from an
  // org-scoped context; since
  // migrations/2026-10-11-150000-ai-partner-wide-select.sql the separate
  // FOR SELECT branch does make the caller's OWN partner's partner-wide rows
  // readable, so this is null far less often — but not never: the branch keys
  // on the caller's own partner, so a run whose org has moved to a different
  // partner still has an invisible agent row, while the run itself (plain
  // org-scoped) stays visible. The route left-joins ai_agents for exactly this
  // reason: a run must never disappear because its agent row did.
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
  // Fleet Designer W01 (#5651), Task 9 — the linked design report artifact's
  // scalars, or `null` for every run that has none. Defaults null so every
  // existing caller is unchanged.
  fleetDesignArtifact: RunTraceFleetDesignArtifactInput | null = null,
  // #4248 W03 (Task 10) — the narrative's email delivery counts, or `null`
  // for every run that produced no narrative artifact. Defaults null so every
  // existing caller is unchanged.
  narrativeDelivery: AiAgentRunNarrativeDeliveryDto | null = null,
  // Execution plane W05 (spec §5.8) — the run's artifacts, newest first, and
  // the sandbox it used. Both default to the empty answer so every existing
  // caller (and every run outside the `analysis` profile, which is most of
  // them) is unchanged. The DTOs are already-safe projections: `toArtifactDto`
  // is what keeps `blobKey` inside the API.
  artifacts: AiRunArtifactDto[] = [],
  workspace: RunWorkspaceRowInput | null = null,
  // `progress` is intentionally NOT a parameter here: it is read from the
  // live Redis ring (`readRunProgress`, W03) by the route, not assembled
  // from persisted run state like everything else this function builds.
  // The route merges it in after calling this function (see
  // routes/aiAgents.ts GET /runs/:runId).
): Omit<AiAgentRunDetailDto, 'progress'> {
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
    // The SAME helper the runs list and the agents list use — not a second
    // count derived from `trace`/`sweep` below. `runVerdict` alone understates
    // a run (a sweep that found six problems and could execute none of them
    // still rolls up `no_action`), and the detail page's own override was the
    // only place that knew it; carrying the server's answer here is what lets
    // the list surfaces say the same thing. See runFindings.ts.
    findingsToReview: countFindingsToReview(run.outcome),
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
    sweep: projectSweep(
      run,
      outcome,
      deviceHostnames,
      // #4442 W05 — built from the run's FULL intent set (the route reads by
      // `requesting_agent_run_id`, not the pending-only `run.intentIds`), so
      // an auto-executed or expired proposal still reports its outcome.
      new Map(intents.map((row) => [row.id, sweepProposalOutcome(row)])),
    ),
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
    // Fleet Designer W01 (#5651), Task 9: null for every non-design run and
    // for a design run that produced nothing — see `projectFleetDesign`'s
    // own safe-projection contract. The bounded `DesignEvidence` bundle the
    // run was built from is never carried here (nor persisted at all); the
    // derived markdown is deliberately left out too, since the detail view
    // renders the structured sections itself.
    fleetDesign: projectFleetDesign(run, outcome, fleetDesignArtifact),
    // AI patch agent W01 (#5747): null for every non-patch run and for a
    // patch run that produced no plan — see `projectPatch`'s safe-projection
    // contract. The raw patch/job-result id lists never reach the wire.
    // Hostnames ride the same batched map the sweep uses.
    patch: projectPatch(run, outcome, deviceHostnames),
    // Execution plane W04 (#5715): null for every non-analysis run and for an
    // analysis run that never submitted. Read DEFENSIVELY — `outcome` is
    // jsonb, and a row from before this wave simply lacks the key.
    analysis: (outcome?.analysis as AnalysisOutcomeDto | undefined) ?? null,
    // Stamped by `finalizeWorkspaceForRun`. `run.computeCents` is W02's
    // column; a run that never built a sandbox reads 0.
    computeCents: Number(run.computeCents ?? 0) || 0,
    computeUsageEstimated: outcome?.computeUsageEstimated === true,
    // #4248 W03: counts only, never a recipient — see the DTO docstring.
    narrativeDelivery,
    // Execution plane W05 (spec §5.8).
    artifacts,
    workspace: mapWorkspace(workspace),
  };
}
