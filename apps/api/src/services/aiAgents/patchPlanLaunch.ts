/**
 * Patch-plan "Run now" as ONE shared operation (full-control W16 PR A, #6786
 * Task 2). `POST /ai/patch-plan/runs` and the `run_patch_plan` AI tool both
 * call it, so the tool carries the route's gates: org access with the same
 * not-found, the org's EFFECTIVE `patch` agent (admission re-resolves it and
 * re-checks `enabled` / `mode`), a device-less `profile: 'patch'` run.
 *
 * A patch run executes nothing: `patchLimits()` pins the run loop's
 * `maxActionsPerRun` to 0, and the installs it proposes are minted afterwards as
 * supervised `manage_patches:install` cards. The run still costs AI credits and
 * notifies the agent's recipients.
 *
 * The audit row stays with the caller (route: `writeRouteAudit`; tool:
 * `auditToolWrite`): admission writes none of its own.
 *
 * `replay` is for a caller whose `dedupeKey` names one request across
 * attempts (the tool keys on the action intent). A run already admitted on the
 * key is returned rather than re-admitted, and a `duplicate` raced in by a
 * concurrent attempt resolves to that run: a retried release is one run. A row
 * left `failed`/`enqueue_failed` is not a replay; admission reclaims it. The
 * route keys each press on a fresh uuid and passes no `replay`.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import type { AuthContext } from '../../middleware/auth';
import { resolveEffectiveAgent } from './effectivePolicy';
import { createAndEnqueueAgentRun } from './runService';

export type PatchPlanLaunchResult =
  | { ok: true; runId: string; agentId: string; enqueueFailed: boolean; replayed: boolean }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'NO_PATCH_AGENT' }
  | { ok: false; code: 'SKIPPED'; skipped: string; agentId: string };

export const isEnqueueFailed = (run: { status?: string | null; errorCode?: string | null }) =>
  run.status === 'failed' && run.errorCode === 'enqueue_failed';

/** The run an earlier attempt admitted on this key, read as system (the key is the caller's own). */
export async function admittedRunId(orgId: string, dedupeKey: string): Promise<string | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: aiAgentRuns.id, status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.dedupeKey, dedupeKey)))
    .limit(1)));
  return row && !isEnqueueFailed(row) ? row.id : null;
}

export async function launchPatchPlanRun(
  auth: AuthContext,
  orgId: string,
  dedupeKey: string,
  opts: { replay?: boolean } = {},
): Promise<PatchPlanLaunchResult> {
  // A cross-tenant probe reads identically to a typo'd org id.
  if (!auth.canAccessOrg(orgId)) return { ok: false, code: 'NOT_FOUND' };

  const resolved = await resolveEffectiveAgent(auth, orgId, 'patch');
  if (!resolved) return { ok: false, code: 'NO_PATCH_AGENT' };
  const agentId = resolved.agentId;

  if (opts.replay) {
    const prior = await admittedRunId(orgId, dedupeKey);
    if (prior) return { ok: true, runId: prior, agentId, enqueueFailed: false, replayed: true };
  }

  const result = await createAndEnqueueAgentRun({
    orgId,
    kind: 'patch',
    triggerKind: 'manual',
    deviceId: null,
    profile: 'patch',
    dedupeKey,
    triggerRef: { requestedByUserId: auth.user.id, agentId },
  });

  if (result.created) {
    return { ok: true, runId: result.run.id, agentId, enqueueFailed: isEnqueueFailed(result.run), replayed: false };
  }
  if (opts.replay && result.skipped === 'duplicate') {
    const raced = await admittedRunId(orgId, dedupeKey);
    if (raced) return { ok: true, runId: raced, agentId, enqueueFailed: false, replayed: true };
  }
  return { ok: false, code: 'SKIPPED', skipped: result.skipped, agentId };
}
