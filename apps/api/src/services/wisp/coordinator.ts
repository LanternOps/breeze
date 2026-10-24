/**
 * Wisp W07 — the coordinator (Wisp design §7.5; w00 "Specialists (W07)").
 *
 * The ONLY code that creates specialist work: runs, Operator tasks, sandbox
 * analysis (`launch_analysis` is this code path, never a model tool) and the
 * pinned bulk ticket reply. It is reached three ways:
 *
 *   - requester `run`      — the `request_specialist` outcome tool recorded a
 *                            request during an assessment; the post-run
 *                            finalizer dispatches it here (specialistDispatch).
 *   - requester `user`     — the Tier-2 chat tool `launch_specialist`, a human
 *                            turn under the grant (W04 stamps auth.wispGrant).
 *   - requester `approval` — the release of a `wisp_specialist_request`
 *                            carrier intent (the approval card), under the
 *                            APPROVER's rebuilt authority.
 *
 * Every path runs the SAME gates, in this order (each is a unit case):
 *    1. wispEnabled() and the AI kill switch       → wisp_disabled
 *    2. the partner's `wisp` entitlement, at claim → not_entitled
 *    3. resolveGrantCeiling(grant, revision)       → grant_inactive
 *    4. the org inside the ceiling                 → org_out_of_ceiling
 *    5. depth one: a requesting run must be Wisp's own depth-0 assessment
 *       under this grant and org (the run path must name one) → depth_exceeded
 *    6. a known kind with params that parse        → unknown_kind / invalid_params
 *       (+ analysis needs the sandbox: aiWorkspaceEnabled())
 *    7. chargeableUnderGrant(estimate)             → budget_exhausted
 *    8. the kind's permissions inside the ceiling — and, on the user/approval
 *       paths, held by that human NOW            → permission_missing /
 *                                                   workspace_execute_required
 *    9. decision: run × asks-first kind → approval card (needsApproval);
 *       every other cell → launch
 *   10. launcher refusal → { refused }; wispMetrics.incSpecialistRequest
 *
 * Authority is structural: the `ai_agent` principal stays, nothing is
 * impersonated, and no prompt text widens anything. The coordinator never
 * bypasses BREEZE_AI_AGENTS_ENABLED (inside wispEnabled), readAiKillState, or
 * aiWorkspaceEnabled — admission re-checks its own gates after it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { aiWorkspaceEnabled, wispEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { isDepthZeroAssessmentRequester } from '../aiAgents/grantDepthGuard';
import { readAiKillState } from '../aiKillState';
import { hasEntitlement } from '../entitlements';
import { getUserPermissions, hasPermission } from '../permissions';
import { incSpecialistRequest } from '../wispMetrics';
import { chargeableUnderGrant } from './budget';
import {
  CeilingViolationError,
  GrantInactiveError,
  assertWithinCeiling,
  resolveGrantCeiling,
  type GrantCeiling,
} from './grantAuthority';
import {
  SPECIALIST_LAUNCHERS,
  parseSpecialistParams,
  type LaunchResult,
  type SpecialistRefusal,
} from './specialistLaunchers';
import { SPECIALIST_KIND_POLICY, isSpecialistKind, type SpecialistKind } from './specialistPolicy';
import { bulkReplyDigest } from './specialists/bulkTicketReply';

export type { SpecialistRefusal } from './specialistLaunchers';
export { specialistDedupeKey } from './specialistLaunchers';

export type SpecialistRequester =
  /** Default: an assessment's recorded request; `requestedByRunId` must be set. */
  | { kind: 'run' }
  /** A `launch_specialist` chat turn under the grant. */
  | { kind: 'user'; auth: AuthContext }
  /** The release of an approved carrier intent, under the APPROVER's authority. */
  | { kind: 'approval'; intentId: string; auth: AuthContext; pinnedDigest?: string | null };

export type SpecialistRequestInput = {
  grantId: string;
  grantRevisionId: string;
  orgId: string;
  kind: SpecialistKind;
  params: Record<string, unknown>;
  requestedByRunId: string | null;
};

export type RequestSpecialistResult =
  | { admitted: true; runId?: string; taskId?: string; report?: unknown }
  | { needsApproval: true; intentId: string }
  | { refused: SpecialistRefusal; detail?: string; report?: unknown };

/** Fixed namespace for `deriveRequestId` (uuid v5). Never change it: ids are durable. */
export const WISP_REQUEST_NS = '6f1c2a3e-7b4d-5c8e-9a0f-1d2e3f4a5b6c';

/** uuid v5 over `${runId}:${ordinal}` — the same request id on every retry of one finalizer. */
export function deriveRequestId(runId: string, ordinal: number): string {
  const ns = Buffer.from(WISP_REQUEST_NS.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(`${runId}:${ordinal}`, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * The human on the user / approval path must hold `permission` NOW, in this
 * org — the same resolution the guardrails use for a chat turn. Wildcards
 * match through `hasPermission` (Partner Admin is `*:*`).
 */
async function humanHolds(auth: AuthContext, orgId: string, permissions: readonly string[]): Promise<string | null> {
  if (!auth.user?.id || !auth.canAccessOrg(orgId)) return permissions[0] ?? 'ai_agents:write';
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
  });
  for (const key of permissions) {
    const [resource, action] = key.split(':') as [string, string];
    if (!userPerms || !hasPermission(userPerms, resource, action)) return key;
  }
  return null;
}

const missingToRefusal = (key: string): SpecialistRefusal =>
  key === 'ai_workspace:execute' ? 'workspace_execute_required' : 'permission_missing';

export async function requestSpecialist(
  input: SpecialistRequestInput,
  opts: { requester?: SpecialistRequester; requestId?: string; reason?: string } = {},
): Promise<RequestSpecialistResult> {
  const result = await decide(input, opts);
  if (isSpecialistKind(input.kind)) {
    incSpecialistRequest(input.kind, 'admitted' in result ? 'admitted' : 'needsApproval' in result ? 'needs_approval' : 'refused');
  }
  return result;
}

async function decide(
  input: SpecialistRequestInput,
  opts: { requester?: SpecialistRequester; requestId?: string; reason?: string },
): Promise<RequestSpecialistResult> {
  const requester: SpecialistRequester = opts.requester ?? { kind: 'run' };
  const requestId = opts.requestId ?? randomUUID();

  // 1. Dark by default; the kill switch is never bypassed.
  if (!wispEnabled()) return { refused: 'wisp_disabled' };
  if ((await readAiKillState()).killed) return { refused: 'wisp_disabled', detail: 'ai_kill_switch' };

  // 2. Entitlement at claim time (spec §10), from the grant row's partner.
  const [grantRow] = await systemRead(() => db
    .select({ partnerId: wispGrants.partnerId })
    .from(wispGrants)
    .where(eq(wispGrants.id, input.grantId))
    .limit(1));
  if (!grantRow) return { refused: 'grant_inactive' };
  if (!(await hasEntitlement(grantRow.partnerId, 'wisp'))) return { refused: 'not_entitled' };

  // 3. The live ceiling: pinned revision ∩ the grantor's authority NOW.
  let ceiling: GrantCeiling;
  try {
    ceiling = await resolveGrantCeiling(input.grantId, input.grantRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return { refused: 'grant_inactive' };
    throw err;
  }

  // 4. The org, through the single comparator. A site-restricted ceiling
  //    refuses too: a specialist is org-wide work.
  try {
    assertWithinCeiling(ceiling, { orgId: input.orgId });
  } catch (err) {
    if (err instanceof CeilingViolationError) {
      return err.code === 'site' ? { refused: 'org_out_of_ceiling', detail: 'site_restricted' } : { refused: 'org_out_of_ceiling' };
    }
    throw err;
  }

  // 5. Depth one. The run path must name Wisp's own assessment; any path that
  //    names a requesting run (an approval card raised by one) is held to the
  //    same predicate admission enforces.
  if (requester.kind === 'run' && !input.requestedByRunId) return { refused: 'depth_exceeded' };
  if (input.requestedByRunId) {
    const runId = input.requestedByRunId;
    const [run] = await systemRead(() => db
      .select({ grantId: aiAgentRuns.grantId, orgId: aiAgentRuns.orgId, depth: aiAgentRuns.depth, profile: aiAgentRuns.profile })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, runId))
      .limit(1));
    if (!isDepthZeroAssessmentRequester(run, input.grantId, input.orgId)) return { refused: 'depth_exceeded' };
  }

  // 6. Kind + params.
  if (!isSpecialistKind(input.kind)) return { refused: 'unknown_kind' };
  const policy = SPECIALIST_KIND_POLICY[input.kind];
  const params = parseSpecialistParams(input.kind, input.params);
  if (!params) return { refused: 'invalid_params' };
  if (input.kind === 'analysis' && !aiWorkspaceEnabled()) {
    return { refused: 'admission_skipped', detail: 'analysis_not_available' };
  }

  // 7. The grant's daily budget — even for auto-admit kinds.
  const budget = await chargeableUnderGrant(input.grantId, policy.estimateCents);
  if (!budget.ok) return { refused: 'budget_exhausted' };

  // 8. The kind's permissions, inside the ceiling (org-term aware) …
  for (const permission of policy.requiredPermissions) {
    try {
      assertWithinCeiling(ceiling, { orgId: input.orgId, permission });
    } catch (err) {
      if (err instanceof CeilingViolationError) return { refused: missingToRefusal(permission) };
      throw err;
    }
  }
  // … and held by the human acting now (never the grantor's on their behalf).
  if (requester.kind !== 'run') {
    const missing = await humanHolds(requester.auth, input.orgId, policy.requiredPermissions);
    if (missing) return { refused: missingToRefusal(missing) };
  }

  // 9. Decision. A run asks first for every kind the policy does not auto-admit.
  if (requester.kind === 'run' && !policy.autoAdmit) {
    // Lazy: keeps the intent graph off the chat/approval paths' import closure.
    const { raiseSpecialistIntent } = await import('./specialistIntent');
    const { intentId } = await raiseSpecialistIntent({
      requestedByRunId: input.requestedByRunId!,
      requestId,
      kind: input.kind,
      orgId: input.orgId,
      grantId: input.grantId,
      grantRevisionId: input.grantRevisionId,
      params,
      reason: opts.reason ?? '',
    });
    return { needsApproval: true, intentId };
  }

  // 10. Launch.
  const pinnedDigest = input.kind !== 'bulk_ticket_reply'
    ? null
    : requester.kind === 'approval'
      ? requester.pinnedDigest ?? null
      : bulkReplyDigest(params as { ticketIds: string[]; message: string });
  const launched: LaunchResult = await SPECIALIST_LAUNCHERS[input.kind]({
    orgId: input.orgId,
    partnerId: ceiling.partnerId,
    grantorUserId: ceiling.grantorUserId,
    grant: { grantId: input.grantId, grantRevisionId: input.grantRevisionId, requestedByRunId: input.requestedByRunId },
    requestId,
    params,
    ceiling,
    actorAuth: requester.kind === 'run' ? null : requester.auth,
    pinnedDigest,
  });
  return launched;
}
