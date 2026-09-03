import type { AiApprovalScope, AiToolStatus } from './ai';
import type {
  ActExecutionVerdict,
  ActVerificationVerdict,
  AgentRunVerdict,
  AiAgentKind,
  AiAgentMode,
  AiAgentRunProfile,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAlertVerdictClassification,
  AiAlertVerdictPattern,
} from './aiAgents';
import type { AiSweepKind, AiSweepSeverity } from './aiAgentSchedules';
import type { AiAgentRunNarrativeDto } from './orgNarrativeReport';
import type { TicketTriageProposal } from './ticketTriage';

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

/**
 * All DTOs in this file are versioned (Partner-API schema precedent,
 * routes/partnerApi/schemas.ts) — this never mutates in place once a
 * version has shipped.
 *
 * The bump rule is precise, not "any shape change": an ADDITIVE field that
 * is always present on the DTO and nullable (a caller that has never seen
 * the key still gets a value it can type-check against, `null`) does NOT
 * bump the version — every consumer already has to tolerate unknown keys on
 * a versioned wire type (that is the whole point of versioning being
 * available at all), and requiring a version bump for every such addition
 * would make the version number churn on every backward-compatible change,
 * defeating its purpose as a signal. `AiAgentRunDetailDto.alertVerdict`
 * (phase 2 P2-1) is exactly this case — added at version 1, still version 1.
 *
 * The version bumps ONLY when a field is removed, renamed, or changes type
 * or semantics — i.e. when an existing consumer parsing the OLD shape would
 * misinterpret or reject the NEW one.
 */
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
  /**
   * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — which run profile
   * produced this row (`full` | `verdict` | `sweep`). The web runs list
   * badges sweep/verdict rows off this rather than inferring one from
   * `triggerKind`, which cannot distinguish a scheduled SWEEP from any other
   * schedule-triggered run. Additive and always present, so it does NOT bump
   * `AI_AGENT_RUN_DTO_SCHEMA_VERSION` (see the bump rule above).
   */
  profile: AiAgentRunProfile;
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

/**
 * Phase 2 wave P2-4 (#4191) — replaces the wave 6 PR 3 shape (`summary` +
 * `proposedReply`/`proposedStatus`/`proposedPriority` + `notes`), which had
 * ZERO writers: no path ever turned a `proposedStatus`/`proposedPriority`
 * into a write, and `submit_ticket_proposal` never accepted them as
 * structured fields. No DTO version bump — this simply mirrors what
 * `submit_ticket_proposal` actually produces now (`TicketTriageProposal`,
 * `types/ticketTriage.ts`, imported rather than re-declared since it is
 * already a shared, wire-safe type — not an API-only internal one), plus the
 * outcome of turning it into writes: which Tier-2 `manage_tickets` intents
 * `finishRun` created (`intentIds`) and which `ticket_drafts` rows it wrote
 * (`draftsWritten`). Still text/identifier-only — no `args`/`input`/`output`
 * blob, nothing a raw tool payload could carry.
 */
export interface AiAgentRunTicketProposalDto extends TicketTriageProposal {
  /** Tier-2 `manage_tickets` intent ids `finishRun` created from this
   *  proposal's `fields`/`device`/`comment` writes (act + autonomousWrites,
   *  or an inbox card — either way an intent id, never the raw args). */
  intentIds?: string[];
  /** `ticket_drafts` rows `finishRun` wrote from `draftReply`/
   *  `draftResolutionNote` — never the draft's own content, which lives on
   *  the ticket UI's "AI draft" surface, not this run-trace DTO. */
  draftsWritten?: Array<{ kind: 'reply' | 'resolution_note'; draftId: string }>;
  /** Follow-up to #4191/#4301 (issue #4462) — why a slot this proposal named
   *  did NOT become a write, e.g. a field proposed below
   *  `TICKET_TRIAGE_CONFIDENCE_FLOOR` or a device already linked. Previously
   *  computed by `persistTicketTriage`
   *  (services/aiAgents/ticketTriageFindings.ts) and only `console.info`'d —
   *  never reached this DTO. `undefined` (not `[]`) when nothing was skipped,
   *  matching `intentIds`/`draftsWritten`'s undefined-when-empty convention. */
  skipped?: TicketTriageSkip[];
}

/**
 * Phase 2 wave P2-4 (#4191) follow-up (#4462) — the five deterministic
 * proposal->intent slots `persistTicketTriage` considers, and why one did not
 * become a write. Shared between the API's internal
 * `AgentRunOutcome.ticketTriageSkipped` (services/aiAgents/ticketTriageFindings.ts
 * / runLoop.ts) and this DTO so the two can never drift apart — same pattern
 * as `AlertVerdictSuggestionReason` above.
 */
export type TicketTriageSlot = 'fields' | 'link' | 'note' | 'draft-reply' | 'draft-resolution';

/**
 * Display strings only — never a raw `Error.message` (same posture as
 * `SweepProposalReason`/`AlertVerdictSuggestionReason`).
 *
 * `no_fields_proposed` / `below_confidence_floor` / `human_set` are the three
 * (mutually exclusive) reasons the `fields` slot can end up empty: nothing
 * was proposed at all, something was proposed but none of it met
 * `TICKET_TRIAGE_CONFIDENCE_FLOOR`, or everything proposed was already
 * human-provenanced. A run mixing a floor-drop with a human-set drop is
 * reported as `below_confidence_floor` — the coarser of the two, since either
 * alone would already have emptied the slot.
 */
export type TicketTriageSkipReason =
  | 'no_fields_proposed'
  | 'below_confidence_floor'
  | 'human_set'
  | 'no_device_proposed'
  | 'device_already_linked'
  | 'no_draft_reply'
  | 'no_draft_resolution'
  | 'resolution_note_exists'
  | 'max_actions_per_run'
  | 'intent_error'
  | 'ticket_not_found';

export interface TicketTriageSkip {
  item: TicketTriageSlot;
  reason: TicketTriageSkipReason;
}

/**
 * Phase 2 wave P2-1 (alert verdicts), review round 1 (IMPORTANT 2) — the
 * disposition of `suggestedAction`'s Tier-2 `manage_alerts` intent attempt.
 * `'intent_created'` means a genuinely PENDING approval was created (see
 * `createActionIntent`'s `pending_approval`-only linking contract in
 * `alertVerdicts.ts`); every other outcome (refused before an attempt,
 * cancelled for lack of an approver, a thrown error) is `'not_created'`,
 * discriminated by `reason`. Shared between the API's internal
 * `AgentRunOutcome.alertVerdictIntent` (services/aiAgents/alertVerdicts.ts)
 * and this DTO so the two can never drift apart.
 */
export type AlertVerdictSuggestionDisposition = 'intent_created' | 'not_created';
/**
 * `'not_allowlisted'` (review round 2, IMPORTANT 1) — the agent's own
 * effective `toolAllowlist` (the run's stored `policySnapshot.effective`,
 * not the tool's registry tier) admits neither `manage_alerts` nor
 * `manage_alerts:<action>`. Checked at CREATION time in `alertVerdicts.ts`
 * so a human is never asked to approve something the RELEASE-time
 * `checkAgentGuardrails` re-check (`agentReleaseAuthority.ts`) would
 * terminally deny anyway. `'target_mismatch'` also covers the sibling
 * device-binding gate there: a suggestion whose target alert's device does
 * not equal the run's own `deviceId` (including a device-less run) is
 * refused with this same reason.
 *
 * `'superseded_concurrently'` (carry-in C, live-verdict partial unique) — a
 * concurrent `persistAlertVerdict` call for the SAME target (alert or
 * correlation group) committed first. This run's own verdict row was never
 * written; the run's suggestion is skipped rather than attempted against a
 * verdict that lost the race. See `alertVerdicts.ts`'s write-ordering
 * docstring for the full mechanism (deferred self-FK + 23505 handling).
 */
export type AlertVerdictSuggestionReason =
  | 'low_confidence' | 'target_mismatch' | 'alert_not_found' | 'no_eligible_approvers' | 'intent_error'
  | 'not_allowlisted' | 'superseded_concurrently';

/**
 * Phase 2 wave P2-1 (alert verdicts) — the safe projection of one
 * `ai_alert_verdicts` row for `GET /ai/agents/runs/:runId`'s detail DTO.
 * Display fields only, mirroring the rest of this file's leak-impossible
 * convention: no raw tool `args`, just the classification, confidence,
 * rationale, and a flattened summary of `pattern`/`suggestedAction`.
 */
export interface AiAgentRunAlertVerdictDto {
  classification: AiAlertVerdictClassification;
  confidence: number;
  rationale: string;
  patternKind: AiAlertVerdictPattern['kind'] | null;
  evidenceAlertIds: string[];
  suggestedAction: {
    tool: 'manage_alerts';
    action: 'suppress' | 'resolve';
    /** Review round 1, IMPORTANT 2: was a suggested mutation actually
     *  turned into a live, pending-approval intent? */
    disposition: AlertVerdictSuggestionDisposition;
    /** Display string only — never the raw `Error.message` from
     *  `createActionIntent`. `null` when `disposition === 'intent_created'`. */
    reason: AlertVerdictSuggestionReason | null;
  } | null;
}

/**
 * Phase 2 wave P2-2 (scheduled sweeps) — the safe projection of one
 * `SweepFinding` for `GET /ai/agents/runs/:runId`'s detail DTO. Same
 * leak-impossible convention as the rest of this file: `evidence` is the
 * already-bounded scalar map the finding schema enforces (see
 * `sweepFindingsOutcomeSchema`), never a raw tool payload, and `proposal`
 * carries only the display-safe outcome of attempting the finding's
 * `SweepProposedAction`, never the raw args.
 */
export interface AiAgentRunSweepFindingDto {
  kind: AiSweepKind;
  severity: AiSweepSeverity;
  deviceId: string | null;
  deviceHostname: string | null;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
  proposal: {
    tool: string;
    action: string | null;
    disposition: 'intent_created' | 'refused' | 'cap_reached' | 'error';
    reason: string | null;
    intentId: string | null;
  } | null;
}

/**
 * Phase 2 wave P2-2 (scheduled sweeps) — the safe projection of a
 * `sweep`-profile run's outcome for `GET /ai/agents/runs/:runId`'s detail
 * DTO. `scheduleId`/`occurrenceKey` are null for a manually-triggered sweep
 * run (not every sweep run originates from a schedule).
 */
export interface AiAgentRunSweepDto {
  scheduleId: string | null;
  occurrenceKey: string | null;
  kinds: AiSweepKind[];
  summary: string;
  findings: AiAgentRunSweepFindingDto[];
  evidenceTruncated: boolean;
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
  /** Wave 6 PR 4 (#3828) — the triggering `metric_anomaly_incidents` row for
   *  a `triggerKind: 'anomaly'` run; null for every other trigger kind. */
  anomalyIncidentId: string | null;
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
  /**
   * Non-null only for a ticket-triggered run whose outcome carries a
   * `ticketProposal` (runLoop.ts) — null for every other run, and for a
   * ticket run from before this field existed (a v-prior outcome jsonb row
   * simply lacks the key). See `AiAgentRunTicketProposalDto`'s docstring.
   */
  ticketProposal: AiAgentRunTicketProposalDto | null;
  /**
   * Phase 2 wave P2-1 (alert verdicts) — the verdict this run produced, for a
   * `verdict`-profile run that reached a `submit_alert_verdict` outcome. Null
   * for every `full`-profile run and for a `verdict`-profile run that has not
   * (yet, or ever) produced one. Populated by Task 8's projection; every
   * caller before that lands sees `null` unconditionally.
   */
  alertVerdict: AiAgentRunAlertVerdictDto | null;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps) — the findings this run produced,
   * for a `sweep`-profile run that reached a sweep outcome. Null for every
   * `full`/`verdict`-profile run and for a `sweep`-profile run that has not
   * produced one. Additive nullable field — does NOT bump
   * `AI_AGENT_RUN_DTO_SCHEMA_VERSION` (same rule as `alertVerdict` above: a
   * caller that has never seen this key still gets `null`, not `undefined`).
   */
  sweep: AiAgentRunSweepDto | null;
  /**
   * Phase 2 wave P2-3 (weekly org narrative) — the narrative this run
   * produced, for a `narrative`-profile run that reached a
   * `submit_narrative` outcome. Null for every `full`/`verdict`/`sweep`
   * run and for a narrative run that has not produced one. Additive nullable
   * field — does NOT bump `AI_AGENT_RUN_DTO_SCHEMA_VERSION` (same rule as
   * `alertVerdict`/`sweep` above).
   */
  narrative: AiAgentRunNarrativeDto | null;
  /**
   * Phase 2 wave P2-3 — the `report_runs` row this run materialised its
   * narrative into, when it did. Duplicated from `narrative.reportRunId` on
   * purpose: the runs UI links straight to the generated report without
   * having to reach through a nullable sub-object, and a run whose narrative
   * projection was dropped (a legacy outcome row) can still carry the link.
   * Additive nullable field — does NOT bump the DTO schema version.
   */
  reportRunId: string | null;
}

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 14 — the safe projection of one
 * LIVE `ai_alert_verdicts` row carried on `GET /alerts` (list), `GET
 * /alerts/:id` (detail), and a correlation group's `GET
 * /correlations/:groupId` detail. Deliberately NOT `AiAgentRunAlertVerdictDto`
 * (the run-detail projection above): that DTO is built from the in-flight
 * `AlertVerdictOutcome` + this file's own `intentInfo` bookkeeping, neither of
 * which is available where the alerts API attaches this — only the persisted
 * `ai_alert_verdicts` row is. In particular `suggestedAction.disposition`
 * (was a Tier-2 intent actually created?) is NOT reproduced here: answering
 * that cheaply would require re-reading the verdict's owning run row, which
 * this call site never loads. `suggestedIntentId` alone (present only when an
 * intent WAS created and linked back) is what the alerts UI has to work with.
 *
 * `confidence` is `Number(...)` of the `numeric(3,2)` column — never the raw
 * Postgres string. `feedback`/`suggestedIntentId` mirror the row verbatim
 * (both already nullable, already display-safe — no raw tool payload lives on
 * this table at all, unlike `ai_agent_runs.outcome`).
 */
export interface AlertAiVerdictSummaryDto {
  id: string;
  classification: AiAlertVerdictClassification;
  confidence: number;
  rationale: string;
  patternKind: AiAlertVerdictPattern['kind'] | null;
  feedback: 'up' | 'down' | null;
  suggestedIntentId: string | null;
  createdAt: string;
}
