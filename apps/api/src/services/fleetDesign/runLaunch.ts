/**
 * Fleet Design "Run now" as ONE shared operation (full-control W16 PR B, #6786 T9).
 * `POST /ai/fleet-design/runs` and `manage_fleet_designs:run` both call it, so the
 * tool carries the route's gates: org access and a site of that org with the same
 * not-found, the org's EFFECTIVE `designer` agent (admission re-resolves it and
 * re-checks `enabled` / `mode`), a device-less `profile: 'design'` run.
 *
 * A design run applies nothing: `maxActionsPerRun` is 0 and apply is its own
 * approval. It still costs AI credits and notifies the agent's recipients.
 *
 * The audit row stays with the caller. `replay` works as in `launchPatchPlanRun`: for
 * a caller whose `dedupeKey` names one request across attempts.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { sites } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { resolveEffectiveAgent } from '../aiAgents/effectivePolicy';
import { admittedRunId, isEnqueueFailed } from '../aiAgents/patchPlanLaunch';
import { createAndEnqueueAgentRun } from '../aiAgents/runService';

export type FleetDesignLaunchResult =
  | { ok: true; runId: string; agentId: string; enqueueFailed: boolean; replayed: boolean }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'NO_DESIGNER_AGENT' }
  | { ok: false; code: 'SKIPPED'; skipped: string; agentId: string };

export async function launchFleetDesignRun(
  auth: AuthContext,
  target: { orgId: string; siteId?: string },
  dedupeKey: string,
  opts: { replay?: boolean } = {},
): Promise<FleetDesignLaunchResult> {
  const { orgId, siteId } = target;
  // A cross-tenant probe reads identically to a typo'd org id (the same posture
  // `loadFleetDesignReport` documents for report ids).
  if (!auth.canAccessOrg(orgId)) return { ok: false, code: 'NOT_FOUND' };

  // Verified before it is trusted into `triggerRef.siteId`, which the run loop reads
  // to scope the design's evidence bundle.
  if (siteId) {
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
      .limit(1);
    if (!site) return { ok: false, code: 'NOT_FOUND' };
  }

  const resolved = await resolveEffectiveAgent(auth, orgId, 'designer');
  if (!resolved) return { ok: false, code: 'NO_DESIGNER_AGENT' };
  const agentId = resolved.agentId;

  if (opts.replay) {
    const prior = await admittedRunId(orgId, dedupeKey);
    if (prior) return { ok: true, runId: prior, agentId, enqueueFailed: false, replayed: true };
  }

  const result = await createAndEnqueueAgentRun({
    orgId,
    kind: 'designer',
    triggerKind: 'manual',
    deviceId: null,
    profile: 'design',
    dedupeKey,
    triggerRef: { requestedByUserId: auth.user.id, agentId, siteId: siteId ?? null },
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
