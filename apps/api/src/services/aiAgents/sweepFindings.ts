// apps/api/src/services/aiAgents/sweepFindings.ts
/**
 * Phase 2 wave P2-2 (scheduled sweeps) — Task A7. Turns the
 * `SweepFindingsOutcome` a `sweep`-profile run produced (`runLoop.ts`'s
 * `finalizeSweep`) into (a) durable per-finding proposal bookkeeping on the
 * run's `outcome` jsonb and (b) at most `maxActionsPerRun` DEVICE-SCOPED,
 * supervised action intents — plus the safe `AiAgentRunSweepDto` projection
 * `runTrace.ts` puts on the wire.
 *
 * Direct sibling of `alertVerdicts.ts` (wave P2-1's `persistAlertVerdict`);
 * read that file's header first — the DB-context rules, the
 * `pending_approval`-only linking contract, and the "never carry a raw
 * `Error.message` onto a persisted record" posture are all identical here.
 * The two differences are structural:
 *
 *  1. A sweep run is DEVICE-LESS (`ai_agent_runs.device_id IS NULL`): one run
 *     walks a whole fleet. Every intent it mints therefore carries an
 *     explicit `scope: { deviceId }` (Task A3's `action_intents.scope_kind` /
 *     `scope_device_id`), which is what lets `checkAgentGuardrails` resolve a
 *     target device at release time for a run that has none of its own.
 *  2. There is no dedicated table. A sweep's findings are model-authored
 *     narrative, not a classification other surfaces query — they live on the
 *     run row's `outcome` jsonb, written by `finishRun`'s single existing
 *     outcome write. This module performs NO writes of its own; it returns
 *     the records and intent ids for the caller to attach.
 *
 * ## The evidence set is the control, not the prompt
 *
 * `run.evidenceDeviceIds` is the set of device ids the SYSTEM actually loaded
 * for this run (`loadSweepEvidence`, Task 5). The sweep prompt tells the model
 * "only propose actions on devices in the evidence", but a prompt is not a
 * control: prompt text is assembled from rows whose display fields the model
 * can also read, and a crafted hostname could make a forged "evidence row"
 * look real in the rendered turn. So the FIRST gate below re-checks the
 * proposal's device against the set the loader returned, server-side, before
 * anything else happens — including before the device is even looked up.
 *
 * ## Gate order (per finding carrying a `proposedAction`)
 *
 *  1. `device_not_in_evidence` — `proposedAction.deviceId` must be in
 *     `run.evidenceDeviceIds`. The PROPOSAL's device is authoritative:
 *     `finding.deviceId` is `.nullable().optional()` on the schema, and the
 *     model omits it more often than it repeats it, so a present
 *     `finding.deviceId` need only AGREE with the proposal's device — an
 *     absent one is treated as agreeing, not as a mismatch. A
 *     present-but-different `finding.deviceId` is still refused; that is a
 *     genuinely contradictory finding, not an omission (bug fix, #4189 — the
 *     old "both must be set and equal" reading refused valid proposals
 *     whenever the model omitted `finding.deviceId`, silently, since a
 *     refusal is recorded on the outcome rather than surfaced as an error).
 *  1b. `subject_not_in_evidence` (#4442 W04) — the device is not the whole
 *     subject. A `service_down` observation is about (device, service NAME),
 *     so the proposal's own subject key (`sweepSubjectKey`) must resolve to a
 *     row the system loaded (`run.evidenceSubjects`, built by
 *     `indexEvidenceSubjects` from the same per-kind rule). Without this,
 *     evidence about service A would authorize an unattended restart of
 *     service B on the same device. The matched SYSTEM subject is recorded on
 *     the proposal and is what the act gate compares the intent's arguments
 *     against — the model never supplies it.
 *  2. `device_not_in_org` — the device must still resolve inside `run.orgId`
 *     and must not be an ephemeral (Quick Support) enrolment. Evidence is a
 *     point-in-time snapshot; a device can be deleted or moved to another org
 *     between collection and this call.
 *  3. `not_allowlisted` — the AGENT's own effective `toolAllowlist` (the run's
 *     stored `policySnapshot.effective`), matched as a bare tool name OR
 *     `tool:action`, exactly as `checkAgentGuardrails` matches. NOT the sweep
 *     profile floor (`sweepToolAllowlist`), which is a READ-only drill-down
 *     surface: a mutation is only proposed when the partner actually granted
 *     the mutating tool. Release time (`agentReleaseAuthority.ts`) re-checks
 *     this same authority, so gating here means a human is never asked to
 *     approve something that could not release.
 *  4. `max_actions_per_run` — the AGENT's `effective.limits.maxActionsPerRun`,
 *     passed in explicitly by the caller. Deliberately NOT the sweep profile's
 *     `sweepLimits().maxActionsPerRun`, which is a hard `0`: that zero governs
 *     what the RUN LOOP may execute or propose through the tool gate (a sweep
 *     executes nothing), not how many findings may become human-approvable
 *     intents.
 *  5. `createActionIntent(..., { scope: { deviceId } })` — linked ONLY when
 *     the returned snapshot is `pending_approval`. `createActionIntent` does
 *     not throw when nobody can approve: it commits the intent and instantly
 *     cancels it, returning that snapshot (P2-1 lesson — see
 *     `alertVerdicts.ts`). Linking a cancelled id would advertise a dead
 *     intent and break the "`intent_ids` are pending-only" invariant
 *     `routes/aiAgents.ts` depends on.
 *
 * The cap counts intents that were actually CREATED, not attempts — an
 * attempt that failed produced nothing for a human to approve, so it consumes
 * no slot. That mirrors `actRevalidation.ts`'s `reserved.count += 1`, which
 * likewise increments only after a successful reservation. The total number of
 * `createActionIntent` calls stays bounded regardless: `sweepFindingsOutcomeSchema`
 * caps a run at 50 findings.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  AI_SWEEP_KINDS,
  sweepTriggerKey,
  type AiAgentRunSweepDto,
  type AiAgentRunSweepFindingDto,
  type AiAgentRunSweepActSummaryDto,
  type AiAgentRunSweepProposalOutcome,
  type AiSweepKind,
  type SweepFinding,
  type SweepFindingsOutcome,
  type SweepProposalReason,
  type SweepProposedAction,
} from '@breeze/shared';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
// Direct module import, not the schema barrel — same note as runLoop.ts.
import { devices } from '../../db/schema/devices';
import type { AuthContext } from '../../middleware/auth';
import { computeExposureBudget } from '../actionIntents/exposureBudget';
import { createActionIntent } from '../actionIntents/intentService';
// From `intentTargetScope`, deliberately NOT from `intentService`: it is the
// pure home of the creation-time argument gates, and importing it here keeps
// this module's one comparison out of the heavy service module.
import { subjectMatchesArguments } from '../actionIntents/intentTargetScope';
import { captureException } from '../sentry';
import {
  orderCohortCandidates, selectCohort,
  type CohortCandidate, type CohortStopReason,
} from './sweepActCohort';
import { resolveEffectiveScheduleActMode } from './sweepActMode';
import { sweepSubjectIndexKey, type SweepEvidenceSubject } from './sweepEvidence';
import { isToolAllowlisted } from './toolAllowlist';

/**
 * Same skip-if-already-system shape as every other file in this directory
 * (see `runLoop.ts`'s own `inSystemDbContext` for the full rationale): a bare
 * system wrapper is a no-op inside an ambient request context, and re-entering
 * from an already-system context would take a SECOND pooled connection while
 * the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * `'intent_created'` — a genuinely PENDING approval exists and its id is on
 * the record. `'refused'` — a gate rejected the proposal before any intent was
 * attempted (gates 1-3). `'cap_reached'` — the run's action budget was already
 * spent. `'error'` — an intent WAS attempted and did not end up pending
 * (cancelled for lack of an approver, or `createActionIntent` threw).
 *
 * Mirrors `AiAgentRunSweepFindingDto.proposal.disposition` (@breeze/shared)
 * exactly; the DTO declares the same four literals so the projection below is
 * a pass-through rather than a remap that could silently drift.
 */
export type SweepProposalDisposition = 'intent_created' | 'refused' | 'cap_reached' | 'error';

// `SweepProposalReason` — why a proposal did not become a pending intent
// (display strings only, NEVER a raw `Error.message` from
// `createActionIntent`; `intent_error` is the whole story a persisted record
// gets, with the real error logged instead; same posture as
// `AlertVerdictSuggestionReason`, P2-1) — is declared in `@breeze/shared`
// (`types/aiAgentRuns.ts`, imported above) rather than here so the web
// sweep-findings UI can reuse the same union instead of re-deriving it
// (#4458).

/**
 * One row of `AgentRunOutcome.sweepProposals` — the bookkeeping for ONE
 * finding's `proposedAction`. Findings that proposed nothing get no record at
 * all (there is nothing to report on), which is why `findingIndex` and not
 * array position is what the projection joins on.
 *
 * Declared HERE rather than in `runLoop.ts` for the same reason
 * `AlertVerdictIntentInfo` is: `runLoop.ts` already imports from this file, so
 * importing the type back the other way would be circular.
 */
export interface SweepProposalRecord {
  findingIndex: number;
  tool: string;
  /** `null` for a tool whose union member carries no action discriminator
   *  (`remediate_vulnerability`). */
  action: string | null;
  deviceId: string;
  disposition: SweepProposalDisposition;
  reason?: SweepProposalReason;
  /**
   * #4442 W04 — the SYSTEM's own subject for the evidence row this proposal
   * matched (gate 1b). Present only when gate 1b passed; written from
   * `evidenceSubjects`, NEVER from the model's text. Scalars only (three
   * strings, one flat object): this is persisted into the run's `outcome`
   * jsonb, which is already `excludedOpen` in the export registry, so it
   * needs no registry change — but nesting anything richer here would be a
   * new shape inside an opaque column.
   */
  subject?: { kind: AiSweepKind; key: string; observedAt: string | null };
  /** Present ONLY for `disposition: 'intent_created'` — a pending-approval id. */
  intentId?: string;
  /**
   * #4442 W05 — was this proposal inside the occurrence's readiness cohort,
   * i.e. minted act-eligible? Present only when the schedule was armed (a
   * disarmed occurrence computes no cohort at all and this stays undefined,
   * which is what keeps a pre-act-mode run rendering exactly as before).
   * `false` means the proposal is an ORDINARY supervised card — it was never
   * dropped.
   */
  cohort?: boolean;
  /**
   * #4442 W05 — which cap ended the cohort walk, so the run detail can say
   * WHY the rest are waiting for approval. Null when nothing bound.
   */
  stoppedBy?: CohortStopReason | null;
}

/** The run fields `persistSweepFindings` needs, all already loaded by the
 *  caller (`finalizeSweep`) — this function issues exactly one query of its
 *  own, the device existence gate. */
export interface SweepPersistRunInput {
  id: string;
  orgId: string;
  agentId: string;
  /** Always `null` — a sweep run is device-less by construction. Carried so
   *  the type documents (and pins) the invariant that makes the explicit
   *  per-intent `scope` necessary in the first place. */
  deviceId: null;
  scheduleId: string | null;
  /** The AGENT's effective allowlist — see gate 3. */
  toolAllowlist: string[];
  /** The AGENT's effective `limits.maxActionsPerRun` — see gate 4. */
  maxActionsPerRun: number;
  /** The device ids the SYSTEM loaded evidence for — see gate 1. Kept as its
   *  own field rather than derived from `evidenceSubjects` below: the
   *  device-level kinds (`stale_agents`, `pending_reboots`, `failed_backups`)
   *  produce NO subject, so deriving would silently narrow gate 1 and report
   *  the wrong refusal reason for a proposal on such a device. */
  evidenceDeviceIds: ReadonlySet<string>;
  /**
   * #4442 W04 — the SYSTEM's own subjects for those same rows, keyed
   * `kind|deviceId|key` (`indexEvidenceSubjects`, sweepEvidence.ts). Gate 1b
   * matches each proposal against this, so evidence about one service can
   * never authorize acting on another. The run outcome does NOT store the
   * evidence itself (`runLoopTypes.ts`: "the evidence itself is never stored
   * on the run"), so this map is assembled in memory by `finalizeSweep` and
   * discarded with the run.
   */
  evidenceSubjects: ReadonlyMap<string, SweepEvidenceSubject>;
  /**
   * #4442 W05 — the three caps the readiness cohort walks against. The first
   * two are the AGENT's effective exposure-ledger limits, identical to the
   * ones `runAuthorizeTransaction` enforces per intent (this walk only
   * bounds over-subscription across the occurrence; it reserves nothing).
   * The third is the new per-OCCURRENCE device cap. All three are read only
   * when the schedule is armed.
   */
  maxFleetPercentPerDay: number;
  maxPolicyDecisionsPerDay: number;
  maxUnattendedDevicesPerSweep: number;
}

/** `action` for the record/projection: only `manage_services` carries one. */
function proposedActionName(proposal: SweepProposedAction): string | null {
  return proposal.tool === 'manage_services' ? proposal.action : null;
}

/**
 * The tool arguments an accepted proposal is converted into. Built by NAME
 * from the closed `SweepProposedAction` union rather than spread from it, so
 * a field added to that union can never reach `createActionIntent` (and
 * therefore an approval card) without someone deliberately adding it here.
 *
 * `deviceId` is present on both shapes and always equals the intent's own
 * `scope.deviceId`: `assertArgsMatchScope` (intentTargetScope.ts) requires
 * exactly that when a `deviceId` argument exists, and `remediate_vulnerability`
 * additionally re-asserts every cited finding belongs to that device.
 */
function proposalToolInput(proposal: SweepProposedAction): Record<string, unknown> {
  return proposal.tool === 'manage_services'
    ? { action: proposal.action, deviceId: proposal.deviceId, serviceName: proposal.serviceName }
    : { deviceId: proposal.deviceId, deviceVulnerabilityIds: proposal.deviceVulnerabilityIds };
}

/**
 * PRECONDITION (inherited from `createActionIntent`, same as
 * `persistAlertVerdict`): must NOT be called from inside an ambient DB
 * context. `finalizeSweep` (runLoop.ts) satisfies this — it runs from the
 * background run loop, which holds no ambient context of its own.
 * `createActionIntent` is deliberately called OUTSIDE this file's own
 * `inSystemDbContext` wrapper for the reason spelled out at length in
 * `alertVerdicts.ts`'s header: it internally `runOutsideDbContext`es to open
 * its own transaction, which would be a second pooled connection held while
 * ours was still open.
 *
 * Never throws for a per-finding failure: a proposal that cannot become an
 * intent is RECORDED as such and the remaining findings are still processed.
 * Losing a whole sweep's findings because one proposal was refused would
 * throw away the useful half of the run's output (P2-1 precedent).
 */
export async function persistSweepFindings(
  run: SweepPersistRunInput,
  outcome: SweepFindingsOutcome,
  agentAuth: AuthContext,
): Promise<{ proposals: SweepProposalRecord[]; intentIds: string[] }> {
  const findings = Array.isArray(outcome.findings) ? outcome.findings : [];

  // Gate 1 first, for EVERY finding, before any DB work: the device set the
  // system loaded is the control (see the header). Only devices that clear it
  // are ever named in a query.
  const candidates: Array<{ index: number; finding: SweepFinding; proposal: SweepProposedAction }> = [];
  const proposals: SweepProposalRecord[] = [];
  const refusals = new Map<number, SweepProposalReason>();
  /** The SYSTEM's matched subject per surviving candidate (gate 1b). */
  const subjects = new Map<number, SweepEvidenceSubject>();

  for (const [index, finding] of findings.entries()) {
    const proposal = finding.proposedAction;
    if (!proposal) continue;
    const deviceId = proposal.deviceId;
    // The proposal's device is authoritative (see the header). A missing
    // `finding.deviceId` agrees trivially; a present one must match.
    const findingDeviceId = finding.deviceId ?? null;
    const agrees = findingDeviceId === null || findingDeviceId === deviceId;
    if (!agrees || !run.evidenceDeviceIds.has(deviceId)) {
      console.warn('[sweepFindings] proposal refused — device is not in the run\'s evidence set', {
        runId: run.id, agentId: run.agentId, findingIndex: index,
        findingDeviceId, proposalDeviceId: deviceId,
      });
      refusals.set(index, 'device_not_in_evidence');
    } else {
      // Gate 1b (#4442 W04) — evaluated HERE, in the same pre-DB pass as gate
      // 1, so a proposal whose subject the system never observed never reaches
      // the batched device read either. See the header.
      const proposalSubjectKey = sweepSubjectKey(finding);
      const subject = proposalSubjectKey === null
        ? undefined
        : run.evidenceSubjects.get(sweepSubjectIndexKey(finding.kind, deviceId, proposalSubjectKey));
      if (subject) {
        subjects.set(index, subject);
      } else {
        console.warn('[sweepFindings] proposal refused — the subject it names is not in the run\'s evidence', {
          runId: run.id, agentId: run.agentId, findingIndex: index, kind: finding.kind, deviceId,
        });
        refusals.set(index, 'subject_not_in_evidence');
      }
    }
    candidates.push({ index, finding, proposal });
  }

  // #4442 W04 — the schedule brake, resolved ONCE for the whole occurrence and
  // before the device read so a disarmed schedule costs nothing per proposal.
  // Resolved ONCE for the whole occurrence, and before the device read so a
  // disarmed schedule costs nothing per proposal. Shared with the
  // RELEASE-time brake (`sweepActMode.ts`) so creation and release can never
  // disagree about whether this org is armed.
  const scheduleActMode = await resolveEffectiveScheduleActMode(run.scheduleId, run.orgId);

  // Gate 2, batched: ONE org-pinned, non-ephemeral existence read for every
  // device that cleared gate 1 — never a query per finding.
  const gate1Passed = candidates.filter((c) => !refusals.has(c.index));
  const lookupIds = [...new Set(gate1Passed.map((c) => c.proposal.deviceId))];
  let inOrg: ReadonlySet<string> = new Set();
  if (lookupIds.length > 0) {
    const rows = await inSystemDbContext(() => db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        inArray(devices.id, lookupIds),
        eq(devices.orgId, run.orgId),
        // A Quick Support enrolment is a one-off support device no scheduled
        // hygiene sweep should ever act on — the same exclusion every
        // `loadSweepEvidence` statement carries.
        eq(devices.isEphemeral, false),
      )));
    inOrg = new Set(rows.map((row) => row.id));
  }

  // #4442 W05 §3.5 — the READINESS cohort. Deliberately NOT a reservation:
  // see `sweepActCohort.ts`'s header (a `sweep_fanout` exposure row would be
  // excluded from the day count, `runAuthorizeTransaction` would insert its
  // own anyway, and its rollback cannot undo a prior transaction). Each
  // intent's own `attemptPolicyDecision` performs the single, idempotent
  // reservation exactly as today; this walk only bounds over-subscription
  // across the occurrence.
  //
  // Read-only, but under the SAME per-org advisory lock the authorize path
  // takes, so the snapshot this walk sees cannot be split by a concurrent
  // authorization mid-occurrence. The lock is released by ending that
  // transaction BEFORE the mint loop starts — `createActionIntent` opens its
  // own transaction via `runOutsideDbContext`, and holding a pooled
  // connection across N of those is the double-hold hang CLAUDE.md warns
  // about.
  //
  // A cohort member can STILL individually lose the authorize race or fail
  // decide-time revalidation and degrade to `human_required`. This is a
  // bound, not a promise of atomic execution.
  //
  // A DISARMED schedule computes no cohort at all: nothing here can make a
  // proposal act-eligible, so the ledger read is pure cost.
  const cohortEligible = new Map<number, CohortCandidate>();
  /** Gate-3/act-gate results reused by the mint loop — computed once. */
  const argumentsMatch = new Map<number, boolean>();
  if (scheduleActMode) {
    for (const { index, finding, proposal } of candidates) {
      if (refusals.has(index)) continue;
      const subject = subjects.get(index);
      const deviceId = proposal.deviceId;
      if (!subject || !inOrg.has(deviceId)) continue;
      if (!isToolAllowlisted(run.toolAllowlist, proposal.tool, proposedActionName(proposal))) continue;
      const matches = subjectMatchesArguments(
        subject, proposal.tool, proposalToolInput(proposal), deviceId,
      );
      argumentsMatch.set(index, matches);
      // A proposal whose arguments do not match the system's subject can
      // never be act-eligible (`resolvePolicyDecisionState`), so it must not
      // consume a cohort slot a genuinely eligible sibling could use.
      if (!matches) continue;
      cohortEligible.set(index, {
        findingIndex: index,
        deviceId,
        severity: finding.severity,
        kind: finding.kind,
        subjectKey: subject.key,
      });
    }
  }

  let cohortMembers: ReadonlySet<number> = new Set<number>();
  let cohortStoppedBy: CohortStopReason | null = null;
  if (cohortEligible.size > 0) {
    const ordered = orderCohortCandidates([...cohortEligible.values()]);
    const budget = await inSystemDbContext(async () => {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-exposure:${run.orgId}`}, 0))`);
      return computeExposureBudget({
        orgId: run.orgId,
        agentId: run.agentId,
        maxFleetPercentPerDay: run.maxFleetPercentPerDay,
        maxPolicyDecisionsPerDay: run.maxPolicyDecisionsPerDay,
        // No `deviceId`: this wants the WINDOW as it stands, with no
        // hypothetical device projected into it — the cohort walk does the
        // projecting, as a set union.
      });
    });
    const selected = selectCohort({
      ordered,
      existingExposedDevices: budget.exposedDeviceIds,
      allowance: budget.allowance,
      // `policyDecisionsToday` is null ONLY under `shortCircuitOnFleetCapExceeded`,
      // which this call never sets. Treated as "cap already spent" rather than
      // zero if it ever were null: fail closed, never open.
      policyDecisionsToday: budget.policyDecisionsToday ?? run.maxPolicyDecisionsPerDay,
      maxPolicyDecisionsPerDay: run.maxPolicyDecisionsPerDay,
      maxUnattendedDevicesPerSweep: run.maxUnattendedDevicesPerSweep,
    });
    cohortMembers = new Set(selected.admitted.map((c) => c.findingIndex));
    cohortStoppedBy = selected.stoppedBy;
    console.info('[sweepFindings] readiness cohort selected', {
      runId: run.id, agentId: run.agentId, orgId: run.orgId,
      eligible: cohortEligible.size, admitted: cohortMembers.size,
      stoppedBy: cohortStoppedBy, allowance: budget.allowance,
      exposedDevices: budget.exposedDeviceIds.size,
      maxUnattendedDevicesPerSweep: run.maxUnattendedDevicesPerSweep,
    });
  }

  const intentIds: string[] = [];
  let created = 0;

  for (const { index, finding, proposal } of candidates) {
    const deviceId = proposal.deviceId;
    const action = proposedActionName(proposal);
    const record: SweepProposalRecord = {
      findingIndex: index,
      tool: proposal.tool,
      action,
      deviceId,
      disposition: 'refused',
    };

    const gate1Reason = refusals.get(index);
    if (gate1Reason) {
      record.reason = gate1Reason;
      proposals.push(record);
      continue;
    }

    // The SYSTEM's subject for this proposal, matched in the pre-DB pass above
    // (gate 1b). Expected to be present — a candidate with no subject was
    // recorded in `refusals` and returned by the branch above — but the
    // invariant spans two loops and two maps, so it is CHECKED rather than
    // asserted: if a later edit to gate 1b's `continue` ever breaks the
    // pairing, this must refuse the proposal (the same refusal gate 1b would
    // have made), never throw a TypeError deep inside intent creation and
    // never fall through to an intent carrying no trusted subject at all.
    const subject = subjects.get(index);
    if (!subject) {
      console.warn('[sweepFindings] proposal refused — no matched subject survived the gate pass (invariant)', {
        runId: run.id, agentId: run.agentId, findingIndex: index, kind: finding.kind, deviceId,
      });
      record.reason = 'subject_not_in_evidence';
      proposals.push(record);
      continue;
    }
    record.subject = { kind: subject.kind, key: subject.key, observedAt: subject.observedAt };
    if (scheduleActMode) {
      // Recorded for EVERY surviving proposal, member or not: `false` is the
      // signal the run detail needs to say "waiting for approval". Left
      // undefined for a disarmed occurrence so a pre-act-mode run renders
      // exactly as before.
      record.cohort = cohortMembers.has(index);
      // `stoppedBy` is the CAPACITY explanation, so it is attached only to a
      // proposal the walk actually turned away — one that was cohort-ELIGIBLE
      // and fell beyond the prefix. A proposal that was never eligible (its
      // tool is not allowlisted, its arguments do not match the system's
      // subject, its device no longer resolves) is waiting on a human for a
      // reason that has nothing to do with the caps, and labelling it with
      // one would be a plainly wrong explanation on the run detail.
      record.stoppedBy = cohortEligible.has(index) && !cohortMembers.has(index)
        ? cohortStoppedBy
        : null;
    }

    if (!inOrg.has(deviceId)) {
      console.warn('[sweepFindings] proposal refused — device no longer resolves inside the run org', {
        runId: run.id, agentId: run.agentId, findingIndex: index, deviceId, orgId: run.orgId,
      });
      record.reason = 'device_not_in_org';
      proposals.push(record);
      continue;
    }

    if (!isToolAllowlisted(run.toolAllowlist, proposal.tool, action)) {
      console.warn('[sweepFindings] proposal refused — tool is not in the agent\'s effective allowlist', {
        runId: run.id, agentId: run.agentId, findingIndex: index, tool: proposal.tool, action,
      });
      record.reason = 'not_allowlisted';
      proposals.push(record);
      continue;
    }

    if (created >= run.maxActionsPerRun) {
      console.warn('[sweepFindings] proposal not converted — the run\'s action cap is spent', {
        runId: run.id, agentId: run.agentId, findingIndex: index, maxActionsPerRun: run.maxActionsPerRun,
      });
      record.disposition = 'cap_reached';
      record.reason = 'max_actions_per_run';
      proposals.push(record);
      continue;
    }

    try {
      const intent = await createActionIntent(agentAuth, {
        trigger: { kind: 'sweep_finding', refId: run.id, key: sweepTriggerKey(finding.kind, sweepSubjectKey(finding) ?? '') },
        toolName: proposal.tool,
        input: proposalToolInput(proposal),
        source: 'ai_agent',
        orgId: run.orgId,
        // The finding TITLE, not its detail: this is what the approval card
        // shows a human as the justification, and the title is the one field
        // the schema bounds to a single short line (120 chars).
        reason: finding.title,
        // Stable per (run, finding) so a redelivered run cannot mint a second
        // intent for the same finding.
        idempotencyKey: `sweep:${run.id}:${index}`,
        scope: { deviceId },
        // #4442 W04 — everything CREATION needs to decide act eligibility,
        // assembled from SYSTEM state only. `argumentsMatchSubject` compares
        // the arguments built above against the subject gate 1b matched,
        // through the one shared comparison in `intentService.ts` so the gate
        // and any later re-check cannot drift.
        //
        // #4442 W05 — WITHHELD from a cohort non-member. A proposal that was
        // otherwise act-eligible but fell beyond the canary prefix simply gets
        // no `sweepAct`, and `resolvePolicyDecisionState` returns
        // `human_required` through the gate that already exists: it becomes an
        // ordinary supervised card, exactly as before act mode. Nothing is
        // dropped — the cohort decides act-ELIGIBILITY, not existence.
        //
        // A proposal that was never cohort-ELIGIBLE (disarmed schedule,
        // arguments that do not match the system's subject, …) still carries
        // its descriptor, unchanged from W04: the descriptor is the honest
        // report of what creation observed, and those cases are already
        // refused by the W04 gates it feeds. Withholding it there would hide
        // the reason rather than add a bound.
        sweepAct: cohortEligible.has(index) && !cohortMembers.has(index)
          ? undefined
          : {
            scheduleActMode,
            subject: { kind: subject.kind, key: subject.key, observedAt: subject.observedAt },
            argumentsMatchSubject: argumentsMatch.get(index) ?? subjectMatchesArguments(
              subject,
              proposal.tool,
              proposalToolInput(proposal),
              deviceId,
            ),
          },
      });
      if (intent.status === 'pending_approval') {
        record.disposition = 'intent_created';
        record.intentId = intent.id;
        intentIds.push(intent.id);
        created += 1;
      } else {
        // P2-1 lesson: never link a cancelled snapshot. `createActionIntent`
        // commits then immediately cancels when nobody can approve.
        record.disposition = 'error';
        record.reason = intent.errorCode === 'no_eligible_approvers' ? 'no_eligible_approvers' : 'intent_error';
        console.warn('[sweepFindings] proposal intent was not left pending approval', {
          runId: run.id, findingIndex: index, intentId: intent.id,
          status: intent.status, errorCode: intent.errorCode,
        });
      }
    } catch (error) {
      if (error instanceof ZodError) {
        // `createActionIntent` validates `trigger` with
        // `remediationTriggerSchema.parse(...)` (intentService.ts) — a
        // ZodError here means THIS file built a malformed trigger, a code
        // defect, not a business-outcome denial like the ones below. Loud in
        // Sentry, and a distinct reason so it is never confused with an
        // ordinary refused/cancelled intent.
        record.disposition = 'error';
        record.reason = 'intent_invalid_provenance';
        captureException(error, undefined, {
          service: 'aiAgents', operation: 'sweepProposals.createActionIntent',
          runId: run.id, findingIndex: String(index),
        });
        console.warn('[sweepFindings] proposal intent trigger failed schema validation', {
          runId: run.id, findingIndex: index, tool: proposal.tool, error: error.message,
        });
      } else {
        // agent_policy_denied, scope_argument_mismatch, org_resolution_failed, …
        // The message is LOGGED, never persisted (it can echo tool input).
        record.disposition = 'error';
        record.reason = 'intent_error';
        console.warn('[sweepFindings] proposal intent not created', {
          runId: run.id, findingIndex: index, tool: proposal.tool,
          error: (error as Error).message,
        });
      }
    }

    proposals.push(record);
  }

  return { proposals, intentIds };
}

/**
 * The distinct, non-null device ids a run's findings (and their proposals)
 * name — the id set `GET /ai/agents/runs/:runId` batches ONE org-pinned
 * `devices` read over to build `projectSweep`'s hostname map. Exported so the
 * route never has to reach into the raw `outcome` jsonb itself, and reads
 * defensively for the same reason `runTrace.ts` does: the column carries no
 * compile-time shape.
 *
 * `sweepProposals` device ids are included too (bug fix, #4189): a finding
 * that omitted its own `deviceId` still names a device through
 * `proposedAction.deviceId` — and `persistSweepFindings` always copies that
 * onto the proposal record's `deviceId`, regardless of disposition —
 * `projectSweep` now falls back to that id, so the hostname read must
 * resolve it too or the finding would still render a `null` hostname.
 */
export function sweepFindingDeviceIds(outcome: Record<string, unknown>): string[] {
  const sweep = outcome.sweepFindings as SweepFindingsOutcome | undefined;
  const findings = Array.isArray(sweep?.findings) ? sweep.findings : [];
  const proposals = outcome.sweepProposals as SweepProposalRecord[] | undefined;
  const ids = new Set<string>();
  for (const finding of findings) {
    if (typeof finding?.deviceId === 'string') ids.add(finding.deviceId);
  }
  if (Array.isArray(proposals)) {
    for (const record of proposals) {
      if (typeof record?.deviceId === 'string') ids.add(record.deviceId);
    }
  }
  return [...ids];
}

/** `triggerRef.sweepKinds` narrowed to the catalog, deduped, source order
 *  preserved — the same defensive narrowing `runLoop.ts` applies when it
 *  builds `RunContext.sweep.kinds` (the column is jsonb: any field may be
 *  missing or the wrong shape). */
function readSweepKinds(triggerRef: Record<string, unknown> | null | undefined): AiSweepKind[] {
  const raw = (triggerRef ?? {}).sweepKinds;
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(AI_SWEEP_KINDS);
  return [...new Set(raw.filter((k): k is AiSweepKind => typeof k === 'string' && known.has(k)))];
}

/**
 * Evidence keys that would SHADOW a leak tripwire, lowercased once at module
 * load (review fix, #4189).
 *
 * `evidence` is a model-authored `string -> scalar` map that the schema only
 * bounds by key count and value length — nothing stops the model from naming
 * a key `toolOutput` and putting its own raw tool transcript in it. Every
 * leak assertion in this repo is written as
 * `expect(JSON.stringify(dto)).not.toContain('"toolOutput"')`, so such a key
 * is not merely a leak: it DEFEATS the tripwire that exists to catch leaks,
 * turning a red suite green. Dropped at projection, case-insensitively —
 * `ARGS` and `toolinput` shadow the tripwire exactly as well as the canonical
 * spelling does.
 */
const SHADOWED_EVIDENCE_KEYS: ReadonlySet<string> = new Set(
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS.map((key) => key.toLowerCase()),
);

function withoutShadowedEvidenceKeys(
  evidence: SweepFinding['evidence'] | undefined,
): SweepFinding['evidence'] {
  if (!evidence) return {};
  const entries = Object.entries(evidence).filter(
    ([key]) => !SHADOWED_EVIDENCE_KEYS.has(key.toLowerCase()),
  );
  return Object.fromEntries(entries);
}

/**
 * Safe projection of a sweep run's outcome for `GET /ai/agents/runs/:runId`.
 *
 * Display fields only, matching this file's siblings: the finding's
 * `proposedAction` — the raw tool arguments the model proposed, including the
 * service name or the vulnerability ids — is READ here to nothing. Only the
 * bookkeeping record's tool/action/disposition/reason and, when one exists,
 * the PENDING intent id reach the wire. `intentId` is the single id exposed;
 * the caller can dereference it through `/approvals`, which applies its own
 * tenancy checks.
 *
 * `hostnames` is built by the route from ONE batched, org-pinned `devices`
 * read (see `sweepFindingDeviceIds`) — never a lookup per finding. A device
 * missing from the map (deleted, or not visible under the caller's RLS
 * context) projects as a `null` hostname rather than hiding the finding.
 */
export function projectSweep(
  run: { scheduleId: string | null; triggerRef: Record<string, unknown> },
  outcome: {
    sweepFindings?: SweepFindingsOutcome;
    sweepProposals?: SweepProposalRecord[];
    sweepEvidenceTruncated?: boolean;
  },
  hostnames: ReadonlyMap<string, string>,
  /**
   * #4442 W05 — LIVE outcomes for the intents this run minted, keyed by
   * intent id, built by the route from a `requesting_agent_run_id` read.
   * Deliberately not derived from `run.intentIds`, which is pending-only: act
   * mode makes the interesting outcomes non-pending, so a run's most
   * important proposals would simply vanish from this projection.
   */
  intentOutcomes: ReadonlyMap<string, AiAgentRunSweepProposalOutcome> = new Map(),
): AiAgentRunSweepDto | null {
  const sweep = outcome.sweepFindings;
  if (!sweep) return null;

  const byIndex = new Map<number, SweepProposalRecord>();
  for (const record of outcome.sweepProposals ?? []) byIndex.set(record.findingIndex, record);

  const triggerRef = run.triggerRef ?? {};
  const occurrenceKey = typeof triggerRef.occurrenceKey === 'string' ? triggerRef.occurrenceKey : null;
  const findings = Array.isArray(sweep.findings) ? sweep.findings : [];

  return {
    scheduleId: run.scheduleId,
    occurrenceKey,
    actSummary: projectActSummary(outcome.sweepProposals ?? []),
    kinds: readSweepKinds(triggerRef),
    // Defensive `?? ''`/`?? {}` below for the same reason `runTrace.ts`
    // defaults every outcome field: this is a jsonb column with no
    // compile-time shape, and a maximally-corrupt row must project rather
    // than throw inside a read route.
    summary: typeof sweep.summary === 'string' ? sweep.summary : '',
    evidenceTruncated: outcome.sweepEvidenceTruncated ?? false,
    findings: findings.map((finding, index): AiAgentRunSweepFindingDto => {
      const record = byIndex.get(index);
      // Fall back to the proposal's device when the finding omitted its own
      // (bug fix, #4189): gate 1 in `persistSweepFindings` now accepts that
      // shape and always copies `proposedAction.deviceId` onto the record's
      // `deviceId`, for every disposition — so a finding carrying a proposal
      // never projects a `null` device merely because the model didn't repeat
      // the id on the finding itself.
      const deviceId = finding.deviceId ?? record?.deviceId ?? null;
      return {
        kind: finding.kind,
        severity: finding.severity,
        deviceId,
        deviceHostname: deviceId ? hostnames.get(deviceId) ?? null : null,
        title: finding.title,
        detail: finding.detail,
        evidence: withoutShadowedEvidenceKeys(finding.evidence),
        // A finding whose proposal has no record (nothing was attempted, or a
        // pre-A7 outcome row) projects `null` — never the raw proposedAction.
        proposal: record
          ? {
            tool: record.tool,
            action: record.action,
            disposition: record.disposition,
            reason: record.reason ?? null,
            intentId: record.intentId ?? null,
            outcome: record.intentId ? intentOutcomes.get(record.intentId) ?? null : null,
            // `?? null`, never `?? false`: "this occurrence computed no
            // cohort" (disarmed, or a pre-act-mode run) is a different
            // statement from "this proposal was outside the cohort", and the
            // UI must not render the second when it only knows the first.
            cohort: record.cohort ?? null,
            stoppedBy: record.stoppedBy ?? null,
          }
          : null,
      };
    }),
  };
}


/**
 * #4442 W05 — the per-occurrence act roll-up. Counts DISTINCT DEVICES, not
 * proposals: two proposals on one machine are one machine acted on. `null`
 * when no record carries a cohort verdict at all — a disarmed occurrence or a
 * pre-act-mode run, where there is nothing truthful to say.
 */
function projectActSummary(records: readonly SweepProposalRecord[]): AiAgentRunSweepActSummaryDto | null {
  const scored = records.filter((r) => r.cohort !== undefined);
  if (scored.length === 0) return null;

  const acted = new Set<string>();
  const proposed = new Set<string>();
  let stoppedBy: string | null = null;
  for (const record of scored) {
    proposed.add(record.deviceId);
    if (record.cohort) acted.add(record.deviceId);
    if (stoppedBy === null && record.stoppedBy) stoppedBy = record.stoppedBy;
  }
  return { devicesActed: acted.size, devicesProposed: proposed.size, stoppedBy };
}

/** Subject of the finding from structured evidence/proposal, never its prose.
 * This is provenance, not proof that a model-authored subject is trusted. */
export function sweepSubjectKey(finding: SweepFinding): string | null {
  const proposal = finding.proposedAction;
  switch (finding.kind) {
    case 'service_down':
      return proposal?.tool === 'manage_services' ? proposal.serviceName
        : typeof finding.evidence.name === 'string' ? finding.evidence.name : null;
    case 'disk_pressure':
      return typeof finding.evidence.mountPoint === 'string' ? finding.evidence.mountPoint : null;
    case 'unpatched_critical':
      return proposal?.tool === 'remediate_vulnerability'
        ? [...proposal.deviceVulnerabilityIds].sort().join(',') || null : null;
    default: return null;
  }
}
