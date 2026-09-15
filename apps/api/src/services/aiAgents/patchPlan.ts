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
 *     surviving id is recorded in `mintedPatchIds` so the next occurrence's
 *     read still sees them. A multi-patch card therefore has one key, and the
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
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  buildTriggerKey,
  type AiAgentRunPatchDto,
  type AiAgentRunPatchItemDto,
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

/** Gate 1 for one item — pure, evidence-only. `null` = cleared. */
function gateOne(item: PatchPlanItem, refs: PatchPlanOutcomeRefs, allPatchIds: ReadonlySet<string>): PatchPlanRefusalReason | null {
  const deviceId = item.deviceId ?? null;
  if (deviceId !== null && !refs.deviceIds.has(deviceId)) return 'device_not_in_evidence';
  const scope = deviceId !== null ? refs.patchIdsByDevice.get(deviceId) ?? new Set<string>() : allPatchIds;
  if ((item.patchIds ?? []).some((p) => !scope.has(p))) return 'patch_not_in_evidence';
  if (item.windowId != null && !refs.windowIds.has(item.windowId)) return 'window_not_resolved';
  if ((item.jobResultIds ?? []).some((j) => !refs.jobResultIds.has(j))) return 'job_result_not_in_evidence';
  return null;
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
  items.forEach((item, index) => {
    const reason = gateOne(item, refs, allPatchIds);
    if (reason) refusals.set(index, reason);
  });

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
    return {
      index,
      class: item.class,
      deviceId: item.deviceId ?? null,
      disposition: reason ? 'refused' : 'recorded',
      ...(reason ? { reason } : {}),
    };
  });

  const intentIds = await mintInstallIntents(run, items, dispositions, agentAuth);
  return { dispositions, intentIds };
}

/** Gates 3-7 of the header, over the `install` items that cleared 1 and 2. */
async function mintInstallIntents(
  run: PatchPersistRunInput,
  items: PatchPlanItem[],
  dispositions: PatchPlanItemRecord[],
  agentAuth: AuthContext,
): Promise<string[]> {
  const candidates = dispositions.filter((record) =>
    record.disposition === 'recorded' && record.class === 'install' && typeof record.deviceId === 'string');
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
      .map((patchId) => ({ patchId, reason: verdict.reasons.get(patchId) ?? ('not_outstanding' as const) }));
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
        reason: item.title,
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
    evidenceTruncated: p.evidenceTruncated === true,
  };
}
