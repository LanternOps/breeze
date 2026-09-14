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
 * **W01 mints nothing.** This module does not import the action-intent
 * service; `run.intentIds` stays empty for every patch run. W02 adds the
 * minting branch after these gates.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type {
  AiAgentRunPatchDto,
  AiAgentRunPatchItemDto,
  PatchPlanItem,
  PatchPlanItemRecord,
  PatchPlanOutcome,
  PatchPlanOutcomeRefs,
  PatchPlanRefusalReason,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
// Direct module import, not the schema barrel — same note as runService.
import { devices } from '../../db/schema/devices';

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

/**
 * Re-validate every item against the run's evidence and org, and return one
 * record per item. Throws only if the batched membership read itself fails
 * (the finalizer maps that to `patch_plan_persist_failed`).
 */
export async function persistPatchPlan(
  run: { id: string; orgId: string },
  plan: PatchPlanOutcome,
  refs: PatchPlanOutcomeRefs,
): Promise<{ dispositions: PatchPlanItemRecord[] }> {
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
  return { dispositions };
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
    evidenceTruncated: p.evidenceTruncated === true,
  };
}
