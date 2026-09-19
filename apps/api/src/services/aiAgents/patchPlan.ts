/**
 * AI patch agent W01 (#5747) — the patch plan's membership gate, persistence
 * and safe projection.
 *
 * `submit_patch_plan` already validated the plan structurally and checked
 * device/patch ids against the run's evidence INSIDE the tool (so the model
 * could retry). This module is the second, authoritative pass, copied from
 * `sweepFindings.persistSweepFindings`'s gate structure:
 *
 *  - **Gate 1, per item, before ANY DB work.** Every reference is checked
 *    against the refs built from the ASSEMBLED evidence: device ∈ evidence,
 *    patch ⊆ that device's evidence rows (or, for a device-less advisory, the
 *    whole evidence), window ∈ resolved windows (none in W01), job result ∈
 *    the failure section (none in W01). A refused id is never named in a
 *    query.
 *  - **Gate 2, batched.** ONE org-pinned, non-ephemeral existence read over
 *    the distinct devices that cleared gate 1 — a device moved out of the org
 *    (or turned out to be a Quick Support enrolment) since the evidence was
 *    assembled is refused, never recorded.
 *  - Every item gets exactly one record; `reason` is a DISPLAY enum
 *    (`PATCH_PLAN_REFUSAL_REASONS`), never an `Error.message`.
 *
 * **W02 (#5748) — the minting branch, after the gates.** An `install` item
 * that cleared gates 1 and 2 becomes ONE device-scoped, Tier-3 SUPERVISED
 * `manage_patches:install` action-intent card — a human decides it
 * (`resolvePolicyDecisionState` returns `human_required` on `hasScope`
 * before anything else; there is no patch exception). In order:
 *
 *  3. **Allowlist** — `isToolAllowlisted(run.toolAllowlist, 'manage_patches',
 *     'install')`, the AGENT's effective allowlist, exactly the gate sweeps
 *     apply. Checked BEFORE any eligibility read so a refused item never
 *     costs a query.
 *  4. **Eligibility** — `resolvePatchInstallEligibility`, ONCE per device
 *     over the union of every surviving install item's `patchIds`. The card
 *     carries only the ids eligible for that device RIGHT NOW; every drop is
 *     recorded with its reason (`droppedPatchIds`). Nothing eligible →
 *     `refused / no_eligible_patches`. The release worker re-runs the same
 *     resolver through the `manage_patches:install` effect digest.
 *  5. **Suppression (OD-4 A)** — ONE `findIntentsByIdempotencyKey` read for
 *     the whole run over every surviving id's problem-derived key
 *     `patch:<orgId>:<deviceId>:<patchId>`; `shouldSuppressPatchEpisode` per
 *     key. A live or recently-decided card for ANY id on the card suppresses
 *     the card. The intent's own key is the FIRST surviving id's; every
 *     surviving id is recorded in `mintedPatchIds` on the run outcome (an
 *     audit trail — the suppression read itself only sees
 *     `action_intents.idempotency_key`). A multi-patch card therefore has one key, and the
 *     plan deliberately accepts that a second card can appear for a patch that
 *     was bundled into a suppressed one — if that proves wrong in practice it
 *     is the OD-4 B (durable `ai_patch_episodes` table) trigger.
 *  6. **Cap** — `run.maxActionsPerRun` is the AGENT's post-run minting cap
 *     threaded by the finalizer (the `sweepFindings.ts` precedent). It is NOT
 *     `patchLimits().maxActionsPerRun`, which is a hard `0` governing what the
 *     RUN LOOP may execute — a patch run executes nothing. Conflating them
 *     would mint nothing or mint unbounded.
 *  7. `createActionIntent(agentAuth, { … scope: { deviceId } })` — linked
 *     ONLY when the returned snapshot is `pending_approval` (it commits then
 *     cancels when nobody can approve; P2-1). Errors are LOGGED, never
 *     persisted (`intent_error`).
 *
 * `approval_advisory` items mint nothing, ever (OD-3 A): `patch_approvals`
 * is partner/ring-scoped, and this program never calls the approve action.
 * `rollback` is never proposed.
 *
 * **W03 (#5749) — chase and escalation.** A `chase` is an install WITH A
 * HISTORY: it goes down the identical minting path above (same eligibility
 * intersection, same episode key, same suppression, same cap), and the only
 * difference is the intent `reason`, which carries `attempt N of M` and the
 * class. Before it reaches gate 3 it clears three extra pure gates in
 * `gateOne`, all against the failedWork evidence (`refs.failedWorkByJobResult`):
 *
 *  a. every cited `jobResultId` is in the evidence AND all of them belong to
 *     ONE group for this item's device and patch (`job_result_not_in_evidence`);
 *  b. the cited `failureClass` / `attemptCount` equal what the evidence
 *     computed — the model may QUOTE a class, never assign one
 *     (`failure_class_mismatch` / `attempt_count_mismatch`);
 *  c. the group's class is retryable (`class_not_retryable`), its attempt
 *     count is below `PATCH_CHASE_MAX_ATTEMPTS` (`chase_attempts_exhausted`),
 *     and the failed-work read was NOT capped — a truncated read makes the
 *     count a floor, so a chase off one could retry past the real budget
 *     (`failure_history_truncated`).
 *
 * `escalation` items never mint. One that quotes a class or attempt count
 * must cite the job results that prove it (gate b applies); one that quotes
 * nothing is recorded as-is. `queued` results are the delivery clock and
 * never appear in the failedWork section, so no chase can cite one.
 *
 * **W04 (#5750) — reboot plans.** A `reboot_plan` is a FINDING against a
 * window the evidence already resolved (`rebootPlanByDevice`, from the
 * next-occurrence projector): `rebootPlanGate` refuses a window that is not
 * this device's own, a reboot policy that is not `maintenance_window`, and an
 * unknown redundancy group; `refuseRedundancyCollisions` refuses the second
 * of two accepted items sharing `(windowId, redundancyGroup)`. Nothing mints,
 * nothing dispatches, no window is ever created — ordered reboots are
 * Operator P4-3's. A recorded item carries the window bounds and group so
 * the trace can show them after the evidence is gone.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  PATCH_CHASE_MAX_ATTEMPTS,
  PATCH_FAILURE_RETRYABLE_CLASSES,
  buildTriggerKey,
  type AiAgentRunPatchDto,
  type AiAgentRunPatchItemDto,
  type PatchFailedWorkRef,
  type PatchIneligibleReason,
  type PatchPlanItem,
  type PatchPlanItemRecord,
  type PatchPlanOutcome,
  type PatchPlanOutcomeRefs,
  type PatchPlanRefusalReason,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
// Direct module import, not the schema barrel — same note as runService.
import { devices } from '../../db/schema/devices';
import type { AuthContext } from '../../middleware/auth';
import { createActionIntent } from '../actionIntents/intentService';
import { findIntentsByIdempotencyKey } from '../actionIntents/intentQuery';
import { resolvePatchInstallEligibility } from '../patchEligibility';
import { captureException } from '../sentry';
import {
  PATCH_EPISODE_SUPPRESSION_DAYS,
  patchEpisodeIdempotencyKey,
  shouldSuppressPatchEpisode,
  type PatchEpisodeHistoryEntry,
} from './patchEpisode';
import { isToolAllowlisted } from './toolAllowlist';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * W03: resolve the ONE failedWork group an item's cited job results name.
 * `null` when they name none, several, or a group for another device/patch.
 */
function citedFailedWorkGroup(item: PatchPlanItem, refs: PatchPlanOutcomeRefs): PatchFailedWorkRef | null {
  const ids = item.jobResultIds ?? [];
  if (ids.length === 0) return null;
  const byJob = refs.failedWorkByJobResult;
  if (!byJob) return null;
  let group: PatchFailedWorkRef | null = null;
  for (const id of ids) {
    const g = byJob.get(id);
    if (!g) return null;
    if (group && g !== group) return null;
    group = g;
  }
  if (!group) return null;
  if (item.deviceId !== group.deviceId) return null;
  const patchIds = item.patchIds ?? [];
  if (patchIds.length > 0 && patchIds.some((p) => p !== group!.patchId)) return null;
  return group;
}

/**
 * W03 gate b — a quoted class / attempt count must be what the evidence
 * computed. Each field is judged on its own so the recorded reason names the
 * field that actually disagreed: an item quoting only `attemptCount` is an
 * `attempt_count_mismatch`, never a class mismatch it never made.
 */
function quoteMismatch(item: PatchPlanItem, group: PatchFailedWorkRef | null): PatchPlanRefusalReason | null {
  if (item.failureClass === undefined && item.attemptCount === undefined) return null;
  // Nothing to check the quote against: whichever field was quoted is unbacked.
  if (!group) return item.failureClass !== undefined ? 'failure_class_mismatch' : 'attempt_count_mismatch';
  if (item.failureClass !== undefined && item.failureClass !== group.failureClass) return 'failure_class_mismatch';
  if (item.attemptCount !== undefined && item.attemptCount !== group.attemptCount) return 'attempt_count_mismatch';
  return null;
}

/**
 * W04 (#5750) — the reboot_plan gates on top of window membership, all
 * against `refs.rebootPlanByDevice` (the reboot backlog the model was shown):
 *
 *  - the window must be THE window the evidence resolved for THIS device
 *    (`window_not_resolved` — a window resolved for a sibling is not this
 *    device's);
 *  - the device's resolved reboot policy must be `maintenance_window`
 *    (`reboot_policy_not_window_gated` — `patchRebootHandler.evaluateRebootPolicy`
 *    reboots `if_required`/`always` with NO window check, so a plan would be
 *    a claim the system does not honour; `never` never reboots at all);
 *  - the redundancy group must be known (`redundancy_unknown`).
 *
 * The cross-item rule — no two accepted items with the same
 * `(windowId, redundancyGroup)` — is `refuseRedundancyCollisions`, run after
 * gate 1 over the whole plan. Nothing here dispatches, schedules or creates
 * anything: a recorded reboot_plan is a finding for Operator P4-3.
 */
function rebootPlanGate(item: PatchPlanItem, refs: PatchPlanOutcomeRefs): PatchPlanRefusalReason | null {
  const ref = typeof item.deviceId === 'string' ? refs.rebootPlanByDevice?.get(item.deviceId) : undefined;
  if (!ref || ref.windowId === null || ref.windowId !== item.windowId) return 'window_not_resolved';
  if (ref.rebootPolicy !== 'maintenance_window') return 'reboot_policy_not_window_gated';
  if (ref.redundancyGroup === null) return 'redundancy_unknown';
  // An evidence-side reason the three checks above did not already name
  // (`no_window_in_horizon` cannot reach here — a null window was refused
  // above — but the mapping keeps the union closed rather than assumed).
  if (ref.unplannableReason !== null) {
    return ref.unplannableReason === 'no_window_in_horizon' ? 'window_not_resolved' : ref.unplannableReason;
  }
  return null;
}

/** W04: first accepted item per `(windowId, redundancyGroup)` wins; every later one is a `redundancy_collision`. */
function refuseRedundancyCollisions(
  items: PatchPlanItem[],
  refusals: Map<number, PatchPlanRefusalReason>,
  refs: PatchPlanOutcomeRefs,
): void {
  const taken = new Set<string>();
  items.forEach((item, index) => {
    if (item.class !== 'reboot_plan' || refusals.has(index) || typeof item.deviceId !== 'string') return;
    const group = refs.rebootPlanByDevice?.get(item.deviceId)?.redundancyGroup;
    if (!group || !item.windowId) return;
    const key = `${item.windowId}\u0000${group}`;
    if (taken.has(key)) refusals.set(index, 'redundancy_collision');
    else taken.add(key);
  });
}

/** Gate 1 for one item — pure, evidence-only. `null` = cleared. */
function gateOne(
  item: PatchPlanItem, refs: PatchPlanOutcomeRefs, allPatchIds: ReadonlySet<string>,
): { reason: PatchPlanRefusalReason | null; group: PatchFailedWorkRef | null } {
  const deviceId = item.deviceId ?? null;
  if (deviceId !== null && !refs.deviceIds.has(deviceId)) return { reason: 'device_not_in_evidence', group: null };
  const scope = deviceId !== null ? refs.patchIdsByDevice.get(deviceId) ?? new Set<string>() : allPatchIds;
  if ((item.patchIds ?? []).some((p) => !scope.has(p))) return { reason: 'patch_not_in_evidence', group: null };
  if (item.windowId != null && !refs.windowIds.has(item.windowId)) return { reason: 'window_not_resolved', group: null };
  if ((item.jobResultIds ?? []).some((j) => !refs.jobResultIds.has(j))) return { reason: 'job_result_not_in_evidence', group: null };
  if (item.class === 'reboot_plan') {
    const reason = rebootPlanGate(item, refs);
    if (reason) return { reason, group: null };
  }

  // W03 — the chase gates (a, b, c in the header).
  const group = citedFailedWorkGroup(item, refs);
  if (item.class === 'chase') {
    if (!group) return { reason: 'job_result_not_in_evidence', group: null };
    // A chase MUST quote the class it is retrying: it is the one field a
    // technician reads on the card, and an unquoted class is unverifiable.
    if (item.failureClass === undefined) return { reason: 'failure_class_mismatch', group };
    const mismatch = quoteMismatch(item, group);
    if (mismatch) return { reason: mismatch, group };
    if (!PATCH_FAILURE_RETRYABLE_CLASSES.has(group.failureClass)) return { reason: 'class_not_retryable', group };
    if (group.attemptCount >= PATCH_CHASE_MAX_ATTEMPTS) return { reason: 'chase_attempts_exhausted', group };
    // The read was capped, so `attemptCount` is a FLOOR: a group that looks
    // like one attempt may already have had three. Minting here would retry
    // past the budget with no signal, so it is refused and the model is asked
    // for an escalation instead. Never widened into "probably fine".
    if (group.truncated) return { reason: 'failure_history_truncated', group };
    return { reason: null, group };
  }
  if (item.class === 'escalation') {
    const mismatch = quoteMismatch(item, group);
    if (mismatch) return { reason: mismatch, group };
  }
  return { reason: null, group };
}

export interface PatchPersistRunInput {
  id: string;
  orgId: string;
  agentId: string;
  scheduleId: string | null;
  /** The AGENT's effective allowlist — see gate 3 in the header. */
  toolAllowlist: readonly string[];
  /** The AGENT's effective `limits.maxActionsPerRun` — see gate 6. */
  maxActionsPerRun: number;
}

/**
 * Re-validate every item against the run's evidence and org, mint an
 * approval card for each eligible `install` item, and return one record per
 * item. Throws only if the batched membership read, an eligibility read or
 * the suppression read itself fails (the finalizer maps that to
 * `patch_plan_persist_failed`); a per-item intent failure is RECORDED.
 *
 * PRECONDITION (inherited from `createActionIntent`, same as
 * `persistSweepFindings`): must NOT be called from inside an ambient DB
 * context — `createActionIntent` opens its own transaction. The finalizer
 * runs from the background run loop, which holds none.
 */
export async function persistPatchPlan(
  run: PatchPersistRunInput,
  plan: PatchPlanOutcome,
  refs: PatchPlanOutcomeRefs,
  agentAuth: AuthContext,
): Promise<{ dispositions: PatchPlanItemRecord[]; intentIds: string[] }> {
  const items = Array.isArray(plan.items) ? plan.items : [];
  const allPatchIds = new Set<string>();
  for (const ids of refs.patchIdsByDevice.values()) for (const id of ids) allPatchIds.add(id);

  const refusals = new Map<number, PatchPlanRefusalReason>();
  const groups = new Map<number, PatchFailedWorkRef>();
  items.forEach((item, index) => {
    const { reason, group } = gateOne(item, refs, allPatchIds);
    if (reason) refusals.set(index, reason);
    else if (group) groups.set(index, group);
  });
  refuseRedundancyCollisions(items, refusals, refs);

  const toCheck = [...new Set(items
    .filter((item, index) => !refusals.has(index) && typeof item.deviceId === 'string')
    .map((item) => item.deviceId as string))];

  if (toCheck.length > 0) {
    // Runs outside any request (the finalizer); the org pin below is the
    // tenant boundary, RLS is not.
    const rows = await inSystemDbContext(() => db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        inArray(devices.id, toCheck),
        eq(devices.orgId, run.orgId),
        eq(devices.isEphemeral, false),
      )));
    const present = new Set(rows.map((row) => row.id));
    items.forEach((item, index) => {
      if (refusals.has(index) || typeof item.deviceId !== 'string') return;
      if (!present.has(item.deviceId)) refusals.set(index, 'device_not_in_org');
    });
  }

  const dispositions = items.map((item, index): PatchPlanItemRecord => {
    const reason = refusals.get(index);
    // W04: a recorded reboot_plan carries its window bounds and group so the
    // trace can render them once the evidence is gone.
    const reboot = !reason && item.class === 'reboot_plan' && typeof item.deviceId === 'string'
      ? refs.rebootPlanByDevice?.get(item.deviceId)
      : undefined;
    return {
      index,
      class: item.class,
      deviceId: item.deviceId ?? null,
      disposition: reason ? 'refused' : 'recorded',
      ...(reason ? { reason } : {}),
      ...(reboot?.windowStartsAt ? { windowStartsAt: reboot.windowStartsAt } : {}),
      ...(reboot?.windowEndsAt ? { windowEndsAt: reboot.windowEndsAt } : {}),
      ...(reboot?.redundancyGroup ? { redundancyGroup: reboot.redundancyGroup } : {}),
    };
  });

  const intentIds = await mintInstallIntents(run, items, dispositions, groups, agentAuth);
  return { dispositions, intentIds };
}

/**
 * W03: the one thing that differs between an install card and a chase card
 * — the justification a technician reads. The attempt history is the
 * evidence's, not the model's (gate b already proved they agree).
 */
export function chaseIntentReason(title: string, group: PatchFailedWorkRef): string {
  return `${title} — retry attempt ${group.attemptCount + 1} of ${PATCH_CHASE_MAX_ATTEMPTS} after ${group.attemptCount} ${group.failureClass} failure(s)`;
}

/** Gates 3-7 of the header, over the `install` AND `chase` (W03) items that cleared 1 and 2. */
async function mintInstallIntents(
  run: PatchPersistRunInput,
  items: PatchPlanItem[],
  dispositions: PatchPlanItemRecord[],
  groups: ReadonlyMap<number, PatchFailedWorkRef>,
  agentAuth: AuthContext,
): Promise<string[]> {
  const candidates = dispositions.filter((record) =>
    record.disposition === 'recorded'
    && (record.class === 'install' || record.class === 'chase')
    && typeof record.deviceId === 'string');
  if (candidates.length === 0) return [];

  // Gate 3 — allowlist, before any read.
  const allowlisted = isToolAllowlisted(run.toolAllowlist, 'manage_patches', 'install');
  if (!allowlisted) {
    console.warn('[patchPlan] install proposals refused — manage_patches:install is not in the agent\'s effective allowlist', {
      runId: run.id, agentId: run.agentId, count: candidates.length,
    });
    for (const record of candidates) { record.disposition = 'refused'; record.reason = 'not_allowlisted'; }
    return [];
  }

  // Gate 4 — eligibility, ONCE per device over the union of its items' ids.
  const idsByDevice = new Map<string, string[]>();
  for (const record of candidates) {
    const list = idsByDevice.get(record.deviceId!) ?? [];
    for (const id of items[record.index]?.patchIds ?? []) if (!list.includes(id)) list.push(id);
    idsByDevice.set(record.deviceId!, list);
  }
  const verdicts = new Map<string, { eligible: Set<string>; reasons: Map<string, PatchIneligibleReason> }>();
  for (const [deviceId, patchIds] of idsByDevice) {
    const verdict = await inSystemDbContext(() => resolvePatchInstallEligibility({ deviceId, orgId: run.orgId, patchIds }));
    verdicts.set(deviceId, {
      eligible: new Set(verdict.eligible.map((e) => e.patchId)),
      reasons: new Map(verdict.ineligible.map((e) => [e.patchId, e.reason])),
    });
  }

  const survivors: Array<{ record: PatchPlanItemRecord; patchIds: string[] }> = [];
  for (const record of candidates) {
    const verdict = verdicts.get(record.deviceId!)!;
    const requested = items[record.index]?.patchIds ?? [];
    const kept = requested.filter((id) => verdict.eligible.has(id));
    const dropped = requested
      .filter((id) => !verdict.eligible.has(id))
      .map((patchId) => {
        const reason = verdict.reasons.get(patchId);
        if (!reason) {
          // The resolver is total over the requested ids (every candidate is
          // either eligible or denied with a reason); reaching here means that
          // invariant broke. Say so rather than mislabel silently.
          captureException(new Error('patchPlan: eligibility verdict named no reason for a dropped patch id'), undefined, {
            service: 'aiAgents', operation: 'mintInstallIntents', runId: run.id, deviceId: record.deviceId!,
          });
        }
        return { patchId, reason: reason ?? ('not_outstanding' as const) };
      });
    if (dropped.length > 0) record.droppedPatchIds = dropped;
    if (kept.length === 0) {
      record.disposition = 'refused';
      record.reason = 'no_eligible_patches';
      continue;
    }
    survivors.push({ record, patchIds: kept });
  }
  if (survivors.length === 0) return [];

  // Gate 5 — ONE suppression read for the whole run.
  const keyOf = (deviceId: string, patchId: string) => patchEpisodeIdempotencyKey(run.orgId, deviceId, patchId);
  const keys = [...new Set(survivors.flatMap(({ record, patchIds }) => patchIds.map((id) => keyOf(record.deviceId!, id))))];
  // The read is keyed on created_at; the rule is keyed on the DECISION time
  // (`decidedAt ?? createdAt`). A card can sit for up to 24h before it is
  // decided, so read two days past the suppression window — the rule, not the
  // read, decides the boundary.
  const since = new Date(Date.now() - (PATCH_EPISODE_SUPPRESSION_DAYS + 2) * 24 * 60 * 60 * 1000);
  const history = new Map<string, PatchEpisodeHistoryEntry[]>();
  for (const row of await findIntentsByIdempotencyKey({ orgId: run.orgId, keys, since })) {
    const list = history.get(row.idempotencyKey) ?? [];
    list.push({ status: row.status, createdAt: row.createdAt, decidedAt: row.decidedAt });
    history.set(row.idempotencyKey, list);
  }

  const intentIds: string[] = [];
  let created = 0;
  for (const { record, patchIds } of survivors) {
    const deviceId = record.deviceId!;
    const item = items[record.index]!;

    let suppressed: ReturnType<typeof shouldSuppressPatchEpisode> = { suppress: false };
    for (const patchId of patchIds) {
      suppressed = shouldSuppressPatchEpisode(history.get(keyOf(deviceId, patchId)) ?? [], new Date());
      if (suppressed.suppress) break;
    }
    if (suppressed.suppress) {
      record.disposition = 'suppressed';
      record.reason = suppressed.reason;
      continue;
    }

    // Gate 6 — the post-run minting cap (see the header: NOT patchLimits' 0).
    if (created >= run.maxActionsPerRun) {
      console.warn('[patchPlan] install proposal not converted — the run\'s action cap is spent', {
        runId: run.id, agentId: run.agentId, itemIndex: record.index, maxActionsPerRun: run.maxActionsPerRun,
      });
      record.disposition = 'cap_reached';
      record.reason = 'max_actions_per_run';
      continue;
    }

    // Gate 7 — mint. Called OUTSIDE this file's own system wrapper (it opens
    // its own transaction; see the precondition on persistPatchPlan).
    try {
      const intent = await createActionIntent(agentAuth, {
        trigger: {
          kind: run.scheduleId ? 'schedule' : 'manual',
          refId: run.id,
          key: buildTriggerKey(['patch', 'install', deviceId]),
        },
        toolName: 'manage_patches',
        // The tool's install action takes `deviceIds` — exactly one, equal to
        // the scope (assertArgsMatchScope) — and `patchIds`.
        input: { action: 'install', deviceIds: [deviceId], patchIds },
        source: 'ai_agent',
        orgId: run.orgId,
        // The item TITLE, not its detail: the one field the schema bounds to a
        // single short line, and what the approval card shows as justification.
        // A chase (W03) appends the evidence's attempt history.
        reason: item.class === 'chase' && groups.has(record.index)
          ? chaseIntentReason(item.title, groups.get(record.index)!)
          : item.title,
        // Problem-derived (OD-4 A), stored verbatim (an explicit key wins over
        // the sha256 derivation in intentService), which is what makes the
        // suppression read above possible. First surviving id's key.
        idempotencyKey: keyOf(deviceId, patchIds[0]!),
        scope: { deviceId },
      });
      if (intent.status === 'pending_approval') {
        record.disposition = 'intent_created';
        record.intentId = intent.id;
        record.mintedPatchIds = patchIds;
        intentIds.push(intent.id);
        created += 1;
      } else {
        // P2-1 lesson: never link a cancelled snapshot.
        record.disposition = 'error';
        record.reason = intent.errorCode === 'no_eligible_approvers' ? 'no_eligible_approvers' : 'intent_error';
        console.warn('[patchPlan] install intent was not left pending approval', {
          runId: run.id, itemIndex: record.index, intentId: intent.id, status: intent.status, errorCode: intent.errorCode,
        });
      }
    } catch (error) {
      record.disposition = 'error';
      record.reason = 'intent_error';
      if (error instanceof ZodError) {
        // A malformed trigger is THIS file's defect, not a business denial.
        captureException(error, undefined, {
          service: 'aiAgents', operation: 'patchPlan.createActionIntent', runId: run.id, itemIndex: String(record.index),
        });
      }
      // The message is LOGGED, never persisted (it can echo tool input).
      console.warn('[patchPlan] install intent not created', {
        runId: run.id, itemIndex: record.index, deviceId, error: (error as Error).message,
      });
    }
  }
  return intentIds;
}

/** The distinct device ids a stored plan names — for the run-detail route's
 *  ONE batched, org-pinned hostname read. Defensive against corrupt jsonb. */
export function patchPlanDeviceIds(outcome: Record<string, unknown>): string[] {
  const plan = outcome.patchPlan as { items?: unknown } | undefined;
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  const ids = new Set<string>();
  for (const item of items) {
    const deviceId = (item as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId === 'string') ids.add(deviceId);
  }
  return [...ids];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The SAFE projection for `GET /ai/agents/runs/:runId` — defensive against a
 * maximally corrupt `outcome.patchPlan` (non-array items, numeric summary),
 * `null` when there is no plan object at all, exactly like `projectSweep`.
 * The raw `patchIds`/`jobResultIds` lists never reach the wire — only a count.
 */
export function projectPatch(
  run: { scheduleId: string | null; triggerRef: Record<string, unknown> | null },
  outcome: { patchPlan?: unknown },
  hostnames: ReadonlyMap<string, string>,
): AiAgentRunPatchDto | null {
  const plan = outcome.patchPlan;
  if (!plan || typeof plan !== 'object') return null;
  const p = plan as Partial<PatchPlanOutcome>;
  const items = Array.isArray(p.items) ? p.items : [];
  const byIndex = new Map<number, PatchPlanItemRecord>();
  if (Array.isArray(p.dispositions)) {
    for (const record of p.dispositions) {
      if (record && typeof record.index === 'number') byIndex.set(record.index, record);
    }
  }
  const triggerRef = run.triggerRef ?? {};
  const posture = p.posture && typeof p.posture === 'object'
    && typeof p.posture.compliancePct === 'number' && typeof p.posture.devicesAtRisk === 'number'
    ? {
      compliancePct: p.posture.compliancePct,
      devicesAtRisk: p.posture.devicesAtRisk,
      oldestOutstandingDays: typeof p.posture.oldestOutstandingDays === 'number' ? p.posture.oldestOutstandingDays : null,
    }
    : null;

  const projected = items.map((raw, index): AiAgentRunPatchItemDto => {
    const item = (raw ?? {}) as Partial<PatchPlanItem>;
    const record = byIndex.get(index);
    const deviceId = typeof item.deviceId === 'string' ? item.deviceId : null;
    return {
      index,
      class: item.class ?? 'escalation',
      severity: item.severity ?? 'info',
      deviceId,
      deviceHostname: deviceId ? hostnames.get(deviceId) ?? null : null,
      patchCount: Array.isArray(item.patchIds) ? item.patchIds.length : 0,
      title: str(item.title),
      detail: str(item.detail),
      disposition: record?.disposition ?? null,
      reason: record?.reason ?? null,
      intentId: typeof record?.intentId === 'string' ? record.intentId : null,
      droppedPatchIds: Array.isArray(record?.droppedPatchIds)
        ? record.droppedPatchIds.filter((d) => d && typeof d.patchId === 'string' && typeof d.reason === 'string')
        : [],
      failureClass: typeof item.failureClass === 'string' ? item.failureClass : null,
      attemptCount: typeof item.attemptCount === 'number' ? item.attemptCount : null,
      // W04: the resolved window a reboot_plan names, plus what the persister
      // copied from the evidence for it.
      windowId: typeof item.windowId === 'string' ? item.windowId : null,
      windowStartsAt: typeof record?.windowStartsAt === 'string' ? record.windowStartsAt : null,
      windowEndsAt: typeof record?.windowEndsAt === 'string' ? record.windowEndsAt : null,
      redundancyGroup: typeof record?.redundancyGroup === 'string' ? record.redundancyGroup : null,
    };
  });

  return {
    scheduleId: run.scheduleId,
    occurrenceKey: typeof triggerRef.occurrenceKey === 'string' ? triggerRef.occurrenceKey : null,
    summary: str(p.summary),
    posture,
    items: projected,
    recordedCount: projected.filter((i) => i.disposition === 'recorded').length,
    refusedCount: projected.filter((i) => i.disposition === 'refused').length,
    intentCreatedCount: projected.filter((i) => i.disposition === 'intent_created').length,
    suppressedCount: projected.filter((i) => i.disposition === 'suppressed').length,
    escalationCount: projected.filter((i) => i.class === 'escalation' && i.disposition === 'recorded').length,
    evidenceTruncated: p.evidenceTruncated === true,
  };
}
