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

import { and, eq, inArray } from 'drizzle-orm';
import {
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  AI_SWEEP_KINDS,
  type AiAgentRunSweepDto,
  type AiAgentRunSweepFindingDto,
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
import { createActionIntent } from '../actionIntents/intentService';
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
  /** Present ONLY for `disposition: 'intent_created'` — a pending-approval id. */
  intentId?: string;
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
  /** The device ids the SYSTEM loaded evidence for — see gate 1. */
  evidenceDeviceIds: ReadonlySet<string>;
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
    }
    candidates.push({ index, finding, proposal });
  }

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
      // agent_policy_denied, scope_argument_mismatch, org_resolution_failed, …
      // The message is LOGGED, never persisted (it can echo tool input).
      record.disposition = 'error';
      record.reason = 'intent_error';
      console.warn('[sweepFindings] proposal intent not created', {
        runId: run.id, findingIndex: index, tool: proposal.tool,
        error: (error as Error).message,
      });
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
          }
          : null,
      };
    }),
  };
}
