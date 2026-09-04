/**
 * The run loop's internal shape contracts, split out of `runLoop.ts` (issue
 * #4451) so the loop itself and its per-profile finalizers (`runFinalizers.ts`)
 * can both name them without importing each other. TYPES ONLY — no runtime
 * code lives here, and nothing in this file imports `runLoop.ts`, which is what
 * keeps the module graph acyclic (`runLoop` → `runFinalizers` → `runLoopTypes`,
 * plus `runLoop` → `runLoopTypes`).
 *
 * `AgentRunOutcome` and its three companions are re-exported from `runLoop.ts`
 * so existing importers (`aiAgentSdkTools.ts`'s tests, `runTrace.ts`) keep
 * their current import path.
 */
import type {
  AgentRunVerdict,
  AiAgentKind,
  AiAgentMode,
  AiAgentPolicySnapshot,
  AiAgentRecipients,
  AiAgentRunProfile,
  AiAgentTriggerKind,
  AiSweepKind,
  AlertVerdictOutcome,
  NarrativeOutcome,
  SweepFindingsOutcome,
  TicketTriageProposal,
  TicketTriageSkip,
} from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import type { AlertVerdictIntentInfo } from './alertVerdicts';
import type { AnomalyRunContext } from './anomalyContext';
import type { NarrativeContext } from './narrativeContext';
import type { SweepEvidence } from './sweepEvidence';
import type { SweepProposalRecord } from './sweepFindings';
import type { TicketRunContext } from './ticketContext';

export interface OutcomeProposedAction {
  tool: string;
  action?: string;
  args: Record<string, unknown>;
  /**
   * Set for Tier-3 proposals that reached `action_intents`. Presence alone does
   * NOT mean a human can still approve it — `createActionIntent` commits and
   * then cancels an intent nobody is eligible to decide. `intentError` is the
   * authoritative signal, and `run.intent_ids` only ever lists PENDING ones.
   */
  intentId?: string;
  /**
   * Set instead of a live approval when the intent could not be created, or was
   * born terminal (`no_eligible_approvers`).
   */
  intentError?: string;
  /**
   * Set only for an act-mode downgrade-to-propose that carried a concrete
   * `normalizeTarget` reason (#3826 cheap nonblocking fix) — e.g. a missing
   * identity field the manifest requires. Absent for an ordinary shadow-mode
   * proposal and for a drift/cap-exhaustion downgrade, neither of which has
   * a single call-specific reason to attach.
   */
  downgradeReason?: string;
}

export interface OutcomeExecutedAction {
  tool: string;
  action?: string;
  /**
   * The real `ai_tool_executions` row id (wave 4a's execution ledger), or
   * `'(inline)'` when the ledger write itself failed — a ledger failure must
   * never block the tool call, so the call still executes and is recorded
   * with the placeholder id (see `executionLedger.ts` and the pre/post hooks
   * below). Correlation between the pre and post hook is per-tool FIFO order
   * (same assumption `allowedPending` already made) — genuine per-invocation
   * ids need SDK hook support the loop doesn't have yet.
   */
  executionId: string;
  result: 'ok' | 'failed';
  durationMs: number;
  /**
   * Act-mode fields (Part B, Task 4) — set ONLY for a call that actually
   * dispatched through the act branch (an `ActAssetPin` was pinned for it in
   * the pre-hook; see `actRevalidation.ts`). Absent for every ordinary
   * Tier-1/2 auto-executed call, exactly like the pre-Part-B behavior.
   */
  execution?: 'succeeded' | 'failed' | 'timeout' | 'unknown';
  verification?: 'passed' | 'failed' | 'inconclusive' | 'skipped';
  /** Short, human-readable — never a raw tool input/output blob. */
  verifyDetail?: string;
  /** The manifest op key (e.g. `manage_services.restart`) — sanitized for the
   *  finished-run notification; never the raw tool input. */
  actOpKey?: string;
  /** Sanitized target identity (service/process name, script/playbook id, or
   *  a path COUNT) — see `actTargetSummary` (actVerify.ts). Never a full
   *  path list or tool input/output. */
  actTargetName?: string;
}

/**
 * Wave 6 PR 3 (#3828, Task 4) — the model's structured proposal for a
 * ticket-triggered run. Reserved: nothing in this PR populates it (there is no SDK structured-output wiring yet — the
 * model's only output channel is still the free-text summary `driveSdkLoop`
 * already extracts). The field exists now so the outcome shape, the
 * `ai_agent_runs.outcome` jsonb, and `AiAgentRunTicketProposalDto`
 * (`@breeze/shared`) do not change again when a later task wires it up.
 *
 * `notes` are PROPOSED talking points for a human reviewer — see the plan's
 * "no autonomous notes, not even private" design authority. Nothing here is
 * ever the input to a write: shadow mode + the device-less mutation gate
 * together guarantee `manage_tickets` cannot execute for a ticket run
 * regardless of what this field ever holds (`ticketShadowGuardrail.contract.test.ts`).
 *
 * P2-4 (#4191) compile-forward fix: this had zero writers pre-P2-4 (grepped
 * repo-wide), so it is now a type alias onto the shared `TicketTriageProposal`
 * — the real `submit_ticket_proposal` outcome shape — rather than the old
 * ad-hoc `proposedReply`/`proposedStatus`/`proposedPriority` shape, keeping
 * this file and `runTrace.ts`'s projection of it coherent with the DTO.
 *
 * Task A6 (this task) is what actually populates this field: the post-hook
 * (`createAgentRunPostToolUse`'s `submit_ticket_proposal` case) captures the
 * model's validated submission verbatim (no server-owned rebuild, unlike
 * `submit_narrative`) the moment a `triage`-profile run calls its one
 * outcome tool. Turning a populated value into `manage_tickets` intents/
 * `ticket_drafts` rows is still task A8's job (`finishRun`), not this one's.
 */
export type TicketProposalOutcome = TicketTriageProposal;

export interface AgentRunOutcome {
  /** The model's `submit_ticket_proposal` submission on a `triage`-profile
   *  run — see `TicketProposalOutcome`'s docstring. Absent for every
   *  non-triage run, and for a triage run that never called the tool. */
  ticketProposal?: TicketProposalOutcome;
  /**
   * Follow-up to #4191/#4301 (issue #4462) — per-slot reasons
   * `finalizeTicketTriage` did not turn part of `ticketProposal` into a
   * write (e.g. a field below `TICKET_TRIAGE_CONFIDENCE_FLOOR`, a device
   * already linked). Set at most once, alongside `ticketProposal`, by
   * `finalizeTicketTriage` from `persistTicketTriage`'s own return value
   * (`ticketTriageFindings.ts`). Absent when `ticketProposal` is absent, or
   * when nothing was skipped. `runTrace.ts`'s `mapTicketProposal` carries
   * this onto the wire DTO's `AiAgentRunTicketProposalDto.skipped`.
   */
  ticketTriageSkipped?: TicketTriageSkip[];
  proposedActions: OutcomeProposedAction[];
  executedActions: OutcomeExecutedAction[];
  deniedActions: Array<{ tool: string; reason: string }>;
  /** Tool calls that actually EXECUTED (denials and proposals excluded). */
  toolExecutionCount: number;
  budgetExceeded?: boolean;
  wallClockExceeded?: boolean;
  /** The SDK stopped because `maxTurns` was reached (`error_max_turns`). */
  maxTurnsExceeded?: boolean;
  /**
   * Run-level rollup over every act execution's (execution, verification)
   * pair, computed once at finish by `computeRunVerdict` — see there for the
   * exact rule. Absent (rather than defaulted) for anything that never
   * reaches the rollup — kept optional so old rows read back without it
   * don't need a migration.
   */
  runVerdict?: AgentRunVerdict;
  /**
   * Phase 2 wave P2-1 (alert verdicts) — the validated `submit_alert_verdict`
   * input, captured by the post-tool-use hook on a verdict-profile run. Set
   * at most once (the outcome tool's own description tells the model to call
   * it exactly once); absent for a `full`-profile run, which never has the
   * outcome tool exposed at all. Persisted to `ai_alert_verdicts` by
   * `finalizeVerdict` (below), which also carries this value into
   * `finishRun`'s persisted `outcome` jsonb.
   */
  alertVerdict?: AlertVerdictOutcome;
  /**
   * Phase 2 wave P2-1 (alert verdicts), review round 1 (IMPORTANT 2) — the
   * disposition of `alertVerdict.suggestedAction`'s Tier-2 intent attempt,
   * set by `finalizeVerdict` alongside `alertVerdict` itself. Absent when
   * there was no `suggestedAction` to act on in the first place (nothing to
   * report) OR for a `full`-profile run. Display strings only — NEVER the
   * raw `Error.message` from `createActionIntent` (that could carry
   * tool-input detail); see `AlertVerdictIntentInfo`'s own docstring.
   */
  alertVerdictIntent?: AlertVerdictIntentInfo;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps) — the validated
   * `submit_sweep_findings` input, captured by the post-tool-use hook on a
   * sweep-profile run. Set at most once (the outcome tool's own description
   * and the sweep task turn both tell the model to call it exactly once);
   * absent for every other profile, which never has the sweep outcome tool
   * exposed at all. Task A7 persists it and turns each accepted
   * `proposedAction` into a supervised action intent — NOTHING here executes.
   */
  sweepFindings?: SweepFindingsOutcome;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — one bookkeeping record
   * per finding that carried a `proposedAction`, written by `finalizeSweep`
   * below. Absent when the run proposed nothing at all (nothing to report on)
   * and for every non-sweep profile. Display strings only — NEVER the raw
   * `Error.message` from `createActionIntent`; see `SweepProposalRecord`'s own
   * docstring (sweepFindings.ts).
   */
  sweepProposals?: SweepProposalRecord[];
  /**
   * Phase 2 wave P2-2, Task A7 — whether the SYSTEM evidence this sweep run
   * reported on was capped/byte-trimmed (`SweepEvidence.truncated`, Task 5).
   * Persisted here because the evidence itself is never stored on the run,
   * and the run-detail projection has to be able to tell a reader "the model
   * saw a sample, not the whole fleet". Absent for every non-sweep profile.
   */
  sweepEvidenceTruncated?: boolean;
  /**
   * Phase 2 wave P2-3 (weekly org narrative) — the weekly narrative, captured
   * by the post-tool-use hook on a narrative-profile run. Set at most once
   * (the outcome tool's description and the narrative task turn both tell the
   * model to call it exactly once); absent for every other profile, which
   * never has the narrative outcome tool exposed at all.
   *
   * NOT the raw tool input, unlike its two siblings above: the model submits
   * `{ headline, sections: [{ key, bullets }] }` and the SERVER attaches the
   * section titles, imposes the canonical section order and derives the
   * markdown (`narrativeOutcomeFromSubmission`, reached through
   * `validateOutcomeToolInput`). See `orgNarrativeReport.ts`'s file docstring
   * for why the model never authors any of those three.
   *
   * Task A7 persists it as a system-authored report artifact and links
   * `ai_agent_runs.report_run_id` — NOTHING here executes.
   */
  narrative?: NarrativeOutcome;
  /**
   * Phase 2 wave P2-3, Task A7 — the system-authored report the narrative was
   * materialised into, written by `finalizeNarrative` once
   * `persistNarrativeReport`'s transaction committed. Absent for every other
   * profile, for a narrative run that produced nothing, and for one whose
   * persistence lost the CAS (in which case the run's `error_code` says so).
   *
   * TWO ids and nothing else. `runFinishedNotify` reads exactly this to build
   * the notification's `metadata.narrative`, and the run-detail route reads
   * `ai_agent_runs.report_run_id` (the typed column) rather than this jsonb —
   * so nothing downstream is tempted to grow a copy of the narrative, let
   * alone of the weekly context, on the run row.
   */
  narrativeReport?: { reportId: string; reportRunId: string };
}

export interface RunRow {
  id: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
  alertId: string | null;
  /** Wave 6 PR 3 (#3828, Task 1/4) — the triggering ticket for `triggerKind:
   *  'ticket'` runs; always `null` for every other trigger kind. */
  ticketId: string | null;
  /** Wave 6 PR 4 (#3828, Task 1/4) — the triggering canonical incident for
   *  `triggerKind: 'anomaly'` runs; always `null` for every other trigger kind. */
  anomalyIncidentId: string | null;
  status: string;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
  triggerKind: AiAgentTriggerKind;
  policySnapshot: AiAgentPolicySnapshot;
  /** Phase 2 wave P2-1 (alert verdicts) — see `verdictProfile.ts`. */
  profile: AiAgentRunProfile;
  correlationGroupId: string | null;
  /** Phase 2 wave P2-2 (scheduled sweeps) — the `ai_agent_schedules` row a
   *  `sweep`-profile run was fanned out from; `null` for every other trigger. */
  scheduleId: string | null;
  /** Free-form trigger provenance (`jsonb`, defaults `{}`). A sweep run's
   *  carries `{ scheduleId, occurrenceKey, sweepKinds }`, written by the
   *  fixed-tick sweeper — read DEFENSIVELY below (any field may be missing or
   *  the wrong shape; the column has no compile-time schema). */
  triggerRef: Record<string, unknown>;
}

export interface AgentRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  kind: AiAgentKind;
  recipients: Partial<AiAgentRecipients>;
}

export interface RunContext {
  run: RunRow;
  agent: AgentRow;
  orgPartnerId: string;
  device: { id: string; siteId: string; hostname: string; osType: string } | null;
  alert: { title: string; severity: string; message: string | null } | null;
  /** Bounded, sanitized ticket context (Task 4) — `null` for every non-ticket
   *  run, and for a ticket run whose ticket has vanished/moved org (same
   *  "moved/deleted reads as absent" posture `device`/`alert` already use). */
  ticket: TicketRunContext | null;
  /** Bounded anomaly context (wave 6 PR 4, #3828, Task 4) — `null` for every
   *  non-anomaly run, and for an anomaly run whose incident has vanished/
   *  moved org (same "moved/deleted reads as absent" posture as `ticket`
   *  above). */
  anomaly: AnomalyRunContext | null;
  /**
   * Phase 2 wave P2-1 (alert verdicts). Set only when `run.correlationGroupId`
   * is set AND the group still resolves inside the run's org — same
   * missing-reads-as-null shape as `device`/`alert` above (a group can be
   * deleted/re-scoped between admission and delivery). `correlationTypes` is
   * the `metadata.correlationTypes` array, narrowed to strings only — the
   * jsonb column carries no compile-time shape.
   */
  correlationGroup: {
    id: string;
    memberCount: number;
    noiseReductionPercent: number;
    rootAlertId: string | null;
    correlationTypes: string[];
  } | null;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps) — the schedule occurrence and the
   * bounded, system-collected evidence this run reports on. Set only for a
   * `sweep`-profile run; `null` for every other profile. An empty
   * `kinds`/`evidence` is a legitimate value (see the loader below), never a
   * reason to fail the run.
   */
  sweep: {
    scheduleId: string;
    occurrenceKey: string;
    kinds: AiSweepKind[];
    evidence: SweepEvidence;
  } | null;
  /**
   * Phase 2 wave P2-3 (weekly org narrative) — the schedule occurrence and the
   * bounded, system-assembled week of activity this run writes about. Set only
   * for a `narrative`-profile run; `null` for every other profile.
   *
   * A narrative run loads NO sweep evidence and NO device context: it is
   * device-less by construction and its tool floor is empty, so this context
   * is its entire input. An empty/unavailable block inside it is a legitimate
   * value the prompt renders as "(not measured)", never a reason to fail the
   * run.
   *
   * `scheduleId` is `''` when the run carries none — Task A7's
   * `finalizeNarrative` reports `narrative_no_schedule` rather than persisting
   * an artifact it cannot attribute to a schedule.
   */
  narrative: {
    scheduleId: string;
    occurrenceKey: string;
    context: NarrativeContext;
  } | null;
  /**
   * The execution-ledger `ai_sessions` row for this run (Task 1/2). Set once,
   * inside `driveSdkLoop`, right after the model is resolved — `null` until
   * then, and stays `null` for the lifetime of the run if session creation
   * itself failed (a best-effort write: see `driveSdkLoop`). `finishRun` reads
   * it back to reconcile/close the session.
   */
  sessionId: string | null;
}

export interface LoopResult {
  summary: string;
  costCents: number;
  turnCount: number;
  outcome: AgentRunOutcome;
  intentIds: string[];
  /**
   * The run's `ai_agent` principal context (built once, near the top of
   * `driveSdkLoop`, via `buildAgentAuthContext`) — carried out on `result`
   * rather than recomputed, since `finishRun` (Task 8, P2-1) needs it to call
   * `persistAlertVerdict`/`createActionIntent` for a verdict run and has no
   * other way to reach it: `driveSdkLoop` has exactly one return statement,
   * reached only after `buildAgentAuthContext` has already succeeded (a
   * throw there returns straight to `executeAgentRun`'s catch block, never
   * through here — see that call site's own comment), so this is always
   * populated whenever `finishRun` reads it. Smaller diff than widening
   * `RunContext` with a second mutated-after-construction field alongside
   * `sessionId`.
   */
  agentAuth: AuthContext;
  /**
   * Set when the SDK loop itself threw. Carried back rather than rethrown so
   * the tokens already burned still land on the run row — a crashed run that
   * recorded `cost_cents: 0` would make the agent's daily budget cap
   * under-count real spend. Setup failures BEFORE any spend still throw.
   */
  failure?: { errorCode: string; message: string };
  /**
   * Phase 2 wave P2-4 (#4191), Task A8 — the SUBSET of `intentIds` that a
   * creation-time `ticket_autonomy` grant already decided (status
   * `approved`, no human fan-out ever happened — see `ticketAutonomy.ts`).
   * Populated only by `finalizeTicketTriage`; every other profile's
   * finalizer only ever links a `pending_approval` intent, so this stays
   * empty (and every existing `intentIds.length > 0` reader is unaffected)
   * for `verdict`/`sweep`/`narrative`/`full` runs. See
   * `classifyIntentAwaitingApproval`'s own docstring for how this is used.
   */
  decidedIntentIds?: string[];
}
