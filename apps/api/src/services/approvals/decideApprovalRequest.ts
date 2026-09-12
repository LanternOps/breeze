import { and, eq, exists, gt, inArray, ne, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { isInteractiveUserSession, type AuthContext } from '../../middleware/auth';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests, elevationAudit } from '../../db/schema/elevations';
import { aiToolExecutions, aiSessions } from '../../db/schema/ai';
import {
  actionIntents,
  intentOutbox,
  type ActionIntent,
  type ActionIntentApprovalScope,
  type ActionIntentStatus,
} from '../../db/schema/actionIntents';
import {
  assertApprovalAssurance,
  assertDecisionConsistent,
  resolveApprovalAssurance,
  StepUpRequiredError,
  ReauthRequiredError,
  type AssuranceDecision,
} from '../authenticatorAssurance';
import {
  isApprovalDecideGrantEligible,
  mintApprovalDecideGrant,
  redeemApprovalDecideGrant,
  type ApprovalDecideScope,
} from './approvalDecideGrant';
import { getUserEpochs } from '../authEpochs';
import { recordActionIntentEvent } from '../actionIntents/metrics';
import { RELEASE_LEASE_MS } from '../actionIntents/intentService';
import {
  resolveIntentApprovers,
  isAgentIntentDecideAuthorized,
} from '../actionIntents/intentApprovers';
import { buildAuthContextForIntent } from '../actionIntents/actorContext';
import {
  effectiveTargetDeviceId,
  resolveIntentTargetDevice,
} from '../actionIntents/intentTargetScope';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import { checkToolPermission } from '../aiGuardrails';
import { loadPartnerPolicy, isEnforcing } from '../authenticatorPolicy';
import { getUserPermissions, hasPermission, userCanDecideApprovals, canAccessOrg } from '../permissions';
import { createPamDecisionIntent } from '../pamActuationLifecycle';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import { requiredAssurance, type RiskTier, type ApprovalProof } from '@breeze/shared';
import { scriptProposals } from '../../db/schema/scriptProposals';
import { loadProposalRow } from '../scriptProposals/queries';
import { resolveStrictAcknowledgement } from './strictAcknowledgement';

/**
 * The approvals DECIDE core (P2-2 #4189), lifted verbatim out of
 * `routes/approvals.ts`'s `decideHandler` so a second caller — the batch
 * decide (`batchDecide.ts`) — drives the exact same gates rather than a
 * parallel re-implementation of them. The route is now a thin adapter over
 * `decideApprovalRequest`; every gate, ordering constraint and comment below
 * came across unchanged.
 *
 * The row DTO (`serialize`) and its two intent projections live here rather
 * than in the route for the same reason: the decide response and the inbox
 * list must keep emitting the identical shape, and the batch path returns the
 * per-row decide bodies straight through.
 */

// #1254: how long a mobile-approved elevation grant stays valid. Matches the
// web respond path's DEFAULT_APPROVAL_DURATION_MINUTES in pam.ts (15) so an
// approve here is bounded identically — an unbounded grant would leave the
// elevation valid indefinitely.
const PAM_ELEVATION_GRANT_MINUTES = 15;

/**
 * Minimal attribution projection of a linked intent (wave 3b Task 6): just
 * enough for `serialize` to say WHO asked — a human, or an AI agent (and
 * which one, via `requestingClientLabel`, stamped with the agent's name at
 * creation so no join is needed). Null when the row has no intent.
 */
export type IntentAttribution = Pick<
  ActionIntent,
  'id' | 'requestingAgentRunId' | 'requestingClientLabel'
> | null;

/**
 * The intent projection `resolveTargetDevices` needs. Every read surface here
 * selects whole `action_intents` rows, so this is a narrowing, not an extra
 * query.
 */
export type IntentTargetRef = Pick<
  ActionIntent,
  'orgId' | 'scopeKind' | 'scopeDeviceId' | 'scopeTicketId' | 'requestingAgentRunId'
>;

/** Target-scope projection for `resolveTargetDevices` — null when there is no
 *  intent. Kept alongside `toIntentAttribution` so both projections are
 *  derived from the same loaded row, never re-read. */
export function toIntentTargetRef(intent: ActionIntent | null): IntentTargetRef | null {
  if (!intent) return null;
  return {
    orgId: intent.orgId,
    scopeKind: intent.scopeKind,
    scopeDeviceId: intent.scopeDeviceId,
    scopeTicketId: intent.scopeTicketId,
    requestingAgentRunId: intent.requestingAgentRunId,
  };
}

/** Attribution projection for `serialize` — null when there is no intent. */
export function toIntentAttribution(
  intent: Pick<ActionIntent, 'id' | 'requestingAgentRunId' | 'requestingClientLabel'> | null,
): IntentAttribution {
  if (!intent) return null;
  return {
    id: intent.id,
    requestingAgentRunId: intent.requestingAgentRunId,
    requestingClientLabel: intent.requestingClientLabel,
  };
}

/**
 * P2-2 (#4189): resolve the target DEVICE for a whole page of intent-linked
 * approval rows in a BOUNDED number of queries — never per row.
 *
 * Two batched reads at most, regardless of page size:
 *   1. `ai_agent_runs` for the agent-originated intents that have NO explicit
 *      scope (their target is still the run's device). Skipped entirely when
 *      every intent on the page is scoped or human-originated.
 *   2. `devices` for the union of resolved device ids, projecting `org_id`
 *      alongside the hostname.
 *
 * A device whose CURRENT `org_id` is not the intent's org is dropped (mapped
 * to no entry, i.e. `targetDevice: null`) rather than rendered — the same
 * fail-closed rule the release path applies to a scoped device that moved
 * tenants, applied here so the inbox never renders another tenant's hostname
 * off a stale `scope_device_id`. A tombstoned scope resolves to no device by
 * construction (`effectiveTargetDeviceId` → null).
 *
 * System-scoped for the same reason the pending join is: `ai_agent_runs` and
 * `devices` are org-scoped tables the caller's ambient request context may not
 * make visible (a partner approver has no `organization_users` row), and the
 * org pin above is the app-layer authorization decision, made explicitly.
 */
export async function resolveTargetDevices(
  entries: Array<{ key: string; intent: IntentTargetRef | null }>,
): Promise<Map<string, { id: string; hostname: string }>> {
  const linked = entries.filter(
    (e): e is { key: string; intent: IntentTargetRef } => e.intent !== null,
  );
  if (linked.length === 0) return new Map();

  const runIds = [
    ...new Set(
      linked
        .filter((e) => e.intent.scopeKind !== 'device' && e.intent.requestingAgentRunId)
        .map((e) => e.intent.requestingAgentRunId as string),
    ),
  ];

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const runDeviceById = new Map<string, string | null>();
      if (runIds.length > 0) {
        const runRows = await db
          .select({ id: aiAgentRuns.id, deviceId: aiAgentRuns.deviceId })
          .from(aiAgentRuns)
          .where(inArray(aiAgentRuns.id, runIds));
        for (const row of runRows) runDeviceById.set(row.id, row.deviceId);
      }

      const targetByKey = new Map<string, string>();
      for (const { key, intent } of linked) {
        const run = intent.requestingAgentRunId
          ? { deviceId: runDeviceById.get(intent.requestingAgentRunId) ?? null }
          : null;
        const deviceId = effectiveTargetDeviceId(resolveIntentTargetDevice(intent, run));
        if (deviceId) targetByKey.set(key, deviceId);
      }
      const deviceIds = [...new Set(targetByKey.values())];
      if (deviceIds.length === 0) return new Map<string, { id: string; hostname: string }>();

      const deviceRows = await db
        .select({ id: devices.id, orgId: devices.orgId, hostname: devices.hostname })
        .from(devices)
        .where(inArray(devices.id, deviceIds));
      const deviceById = new Map(deviceRows.map((row) => [row.id, row]));

      const out = new Map<string, { id: string; hostname: string }>();
      for (const { key, intent } of linked) {
        const deviceId = targetByKey.get(key);
        if (!deviceId) continue;
        const device = deviceById.get(deviceId);
        // Org pin (fail closed): a device that moved tenants since the intent
        // was minted is reported as no target at all, never as a hostname.
        if (!device || device.orgId !== intent.orgId) continue;
        out.set(key, { id: device.id, hostname: device.hostname });
      }
      return out;
    }),
  );
}

export function serialize(
  r: typeof approvalRequests.$inferSelect,
  customerTenant: string | null = null,
  /**
   * The linked intent's approval scope, or null when the row has no intent.
   * Additive (task-8 review finding): without it a client cannot tell a
   * `supervised` row — decided with a plain click — from a `four_eyes` one
   * that may demand a WebAuthn/mobile step-up, so it can't shape the decide
   * affordance ahead of the request.
   */
  approvalScope: ActionIntentApprovalScope | null = null,
  /**
   * Attribution projection of the linked intent (wave 3b Task 6), or null for
   * a row with no intent. Drives `origin`/`agentName` so the inbox can say an
   * AI agent asked — `requestingClientLabel` was stamped with the agent's
   * name at intent creation, so no join is needed. Web Task 9 consumes both.
   */
  attribution: IntentAttribution = null,
  /**
   * P2-2 (#4189): the linked intent's RESOLVED target device — its explicit
   * `scope_device_id` when it has one, the run's device otherwise — with the
   * hostname the inbox renders. Null for a row with no intent, an intent with
   * no resolvable device, or a tombstoned scope. Resolved by the caller
   * (which batches ONE `inArray(devices.id, …)` read per page); this
   * function stays I/O-free.
   */
  targetDevice: { id: string; hostname: string } | null = null,
  /** The linked intent's org, so a partner-scope inbox can group by customer
   *  without a second fetch. Null for a row with no intent. */
  orgId: string | null = null,
  /**
   * The `orgId` organization's display name, resolved server-side (#4187 UI
   * critique) so a client never has to bulk-fetch `/orgs/organizations` and
   * map names itself. Null for a row with no intent (no `orgId` to resolve)
   * or when the org row no longer exists. Resolved by the caller (which
   * batches ONE `inArray(organizations.id, …)` read per page, mirroring
   * `customerTenant`'s batching); this function stays I/O-free.
   */
  orgName: string | null = null,
) {
  const isAgentOriginated = attribution?.requestingAgentRunId != null;
  const actionArguments = r.actionArguments as Record<string, unknown> | null;
  return {
    id: r.id,
    origin: isAgentOriginated ? ('ai_agent' as const) : ('human' as const),
    agentName: isAgentOriginated ? (attribution?.requestingClientLabel ?? null) : null,
    requestingClientLabel: r.requestingClientLabel,
    requestingMachineLabel: r.requestingMachineLabel ?? null,
    actionLabel: r.actionLabel,
    actionToolName: r.actionToolName,
    actionArguments: r.actionArguments,
    // Additive projection of the multiplexed tools' `action` discriminator
    // (manage_services:restart, manage_patches:install, …) — mobile shows it
    // without having to parse actionArguments itself. Null whenever the tool
    // is not action-multiplexed or the value is not a plain string.
    action: typeof actionArguments?.action === 'string' ? actionArguments.action : null,
    orgId,
    orgName,
    targetDevice,
    riskTier: r.riskTier,
    riskSummary: r.riskSummary,
    customerTenant,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason ?? null,
    executionId: r.executionId ?? null,
    intentId: r.intentId ?? null,
    approvalScope,
    isRecursive: r.isRecursive,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * The `release_by` patch for an intent decision (design §4.2), in ONE place so
 * the rule can't drift between call sites.
 *
 * EVERY transition to `approved` gets a fresh, fixed `RELEASE_LEASE_MS` lease —
 * unconditionally, never "only when it isn't already set". The downstream
 * readers (jobs/intentExpiryReaper.ts, jobs/intentReleaseWorker.ts,
 * services/actionIntents/intentService.ts) all evaluate
 * `COALESCE(release_by, expires_at)`; that fallback is the ROLLING-UPGRADE
 * mechanism for rows approved by an older instance that never stamped the
 * column, and must stay — but a row approved by THIS code path should never
 * be relying on it, because `expires_at` is the approval deadline, not an
 * execution lease, and is typically already in the past by then.
 *
 * A rejected intent never executes, so it has no release window to bound.
 */
function stampReleaseLease(intentTargetStatus: ActionIntentStatus): { releaseBy?: Date } {
  if (intentTargetStatus !== 'approved') return {};
  return { releaseBy: new Date(Date.now() + RELEASE_LEASE_MS) };
}

/** The loaded intent a decide is acting on, or null for an unlinked row
 *  (PAM / dev seed). Named so the #5601 grant helpers below read clearly. */
type LinkedIntent = ActionIntent | null;

/**
 * #5601: resolve the conversation/tenancy/severity scope a decide's
 * `approval_decide` grant is pinned to.
 *
 * `aiSessionId` needs a lookup because there is no column for it on the
 * intent: web AI chat stamps `ai_tool_executions.intent_id` onto the execution
 * it created (aiAgentSdk.ts), and that execution carries the conversation's
 * `session_id`. That lookup is what makes the conversation binding real for
 * chat — `requesting_agent_run_id` is populated ONLY for an `ai_agent`
 * principal, and chat creates its intents with the human's auth, so scoping on
 * the run id alone would have bounded nothing for the motivating flow.
 *
 * System-scoped for the same reason the decide write is: `ai_tool_executions`
 * is org-scoped and the caller's ambient context does not guarantee visibility
 * of the org this intent belongs to. Read-only, and a failure degrades to
 * `null` (no grant) rather than failing the decide.
 */
async function resolveGrantScope(
  intent: LinkedIntent,
  riskTier: RiskTier,
): Promise<ApprovalDecideScope | null> {
  if (!intent) return null;
  // SUPERVISED ONLY (Todd, 2026-09-11): four_eyes is the high-trust path and
  // keeps its per-approval passkey, so a four_eyes row neither mints nor
  // redeems. Refused HERE, in the core, before any lookup and independently
  // of `isApprovalDecideGrantEligible` (which refuses it again from the
  // scope's `approvalScope`) — two gates, so a loosening of either alone
  // cannot let a grant reach a four_eyes decide. A presented grant on such a
  // row therefore lands in the redeem branch's fail-closed 403 and the client
  // runs a real ceremony.
  if (intent.approvalScope !== 'supervised') return null;
  let aiSessionId: string | null = null;
  try {
    const [exec] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ sessionId: aiToolExecutions.sessionId })
          .from(aiToolExecutions)
          .where(eq(aiToolExecutions.intentId, intent.id))
          .limit(1),
      ),
    );
    aiSessionId = exec?.sessionId ?? null;
  } catch (err) {
    // Never fatal: no session id simply means a narrower (or ineligible)
    // scope, which costs the operator a ceremony. Logged rather than swallowed
    // so a persistent fault is visible instead of silently disabling reuse.
    console.error('[approvals] grant scope: ai session lookup failed:', err);
  }
  const scope: ApprovalDecideScope = {
    approvalScope: intent.approvalScope,
    agentRunId: intent.requestingAgentRunId ?? null,
    aiSessionId,
    orgId: intent.orgId,
    riskTier,
  };
  return isApprovalDecideGrantEligible(scope) ? scope : null;
}

/** The `{authEpoch, mfaEpoch, sid}` half of a grant binding, or null when the
 *  caller's session cannot supply it (no sid on a non-interactive token, or an
 *  epoch read failure). Null means "no grant", which is always safe. */
async function resolveGrantSession(
  auth: AuthContext,
): Promise<{ authEpoch: number; mfaEpoch: number; sid: string } | null> {
  const sid = auth.token?.sid;
  if (!sid) return null;
  try {
    const epochs = await getUserEpochs(auth.user.id);
    if (!epochs) return null;
    return { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid };
  } catch (err) {
    console.error('[approvals] grant session: epoch read failed:', err);
    return null;
  }
}

/**
 * #5601: redeem a presented grant into the assurance its original ceremony
 * achieved, or `null` (→ the caller's 403) on any failure.
 *
 * The partner floor is RE-EVALUATED here against the CURRENT policy rather
 * than inherited from the minting decide, so a partner who raises their floor
 * mid-window invalidates outstanding grants in effect without anyone touching
 * Redis. Under a non-enforcing policy an under-assured redeem sets
 * `graceDowngrade`, exactly as the ladder would.
 */
async function redeemGrantForDecide(input: {
  grantId: string;
  auth: AuthContext;
  userId: string;
  riskTier: RiskTier;
  intent: LinkedIntent;
  decision: 'approved' | 'denied';
}): Promise<AssuranceDecision | null> {
  const scope = await resolveGrantScope(input.intent, input.riskTier);
  if (!scope) return null;
  const session = await resolveGrantSession(input.auth);
  if (!session) return null;

  const redeemed = await redeemApprovalDecideGrant({
    grantId: input.grantId,
    userId: input.userId,
    ...session,
    scope,
  });
  if (!redeemed) return null;

  const isApprove = input.decision === 'approved';
  const policy = isApprove ? await loadPartnerPolicy(input.auth.partnerId ?? null) : null;
  const decision: AssuranceDecision = {
    requiredLevel: requiredAssurance(input.riskTier, policy?.floorOverrides ?? null),
    decidedAssuranceLevel: redeemed.context.decidedAssuranceLevel,
    decidedVia: redeemed.context.decidedVia,
    authenticatorDeviceId: redeemed.context.authenticatorDeviceId,
    stepUpGrantReuse: true,
  };
  if (isApprove && decision.decidedAssuranceLevel < decision.requiredLevel) {
    // An ENFORCING partner whose floor now outranks what the grant proves:
    // refuse, so the operator runs a ceremony that can actually clear it.
    if (isEnforcing(policy, new Date())) return null;
    decision.graceDowngrade = true;
  }
  return decision;
}

/** Everything the decide core needs from the request. `auth` replaces the
 *  route's `c.get('auth')`; `id` replaces `c.req.param('id')`. */
export interface DecideApprovalInput {
  auth: AuthContext;
  id: string;
  status: 'approved' | 'denied';
  reason?: string;
  proof?: ApprovalProof;
  reauthVerified?: boolean;
  /**
   * W03 (#5612, spec §4.5): STRICT pattern descriptions the approver ticked on
   * the script-proposal card. Only meaningful when the intent is a
   * `run_script { proposalId }` whose proposal has `strict_hits`; ignored for
   * every other approval. Resolved server-side as (submitted ∩ strict_hits).
   */
  acknowledgedPatterns?: string[];
  /**
   * P2-2 batch decide (#4189): an `AssuranceDecision` already established for
   * this decider by ONE ceremony covering the whole batch
   * (`services/approvals/batchDecide.ts`). Its ONLY effect is to skip the
   * assurance-ladder block below — the proof verification, the partner-policy
   * floor read and the sole-operator step-up gate all ran once at batch level
   * against `batchAssertionKey(...)`, and re-running them per row would try to
   * consume a single-use challenge N times.
   *
   * Every OTHER gate still runs per row, unchanged: the human-principal
   * assertion, the row pre-fetch (pending/expiry), the linked-intent load, the
   * digest binding, `isAgentIntentDecideAuthorized`, the approval CAS, the
   * release lease, the intent fan-in, the outbox event and the audit
   * projection. The batch is a shortcut through the CEREMONY, never through
   * authorization.
   */
  preverifiedAssurance?: AssuranceDecision;
  /**
   * #5601: an `approval_decide` step-up grant minted by an EARLIER decide in
   * this same window, presented in place of running another ceremony. See
   * services/approvals/approvalDecideGrant.ts. Honoured for SUPERVISED rows
   * only (an enforcing partner's step-up floor); a four_eyes row refuses it
   * with 403 step_up_required and always takes a fresh proof.
   *
   * Presenting one disables `skipAssuranceLadder` exactly as presenting a
   * `proof` does — otherwise a supervised row under a non-enforcing partner
   * could present a BAD grant, take the shortcut, and succeed at L1, silently
   * ignoring the very credential the redeem path promises to reject.
   *
   * A request carrying BOTH a proof and a grant runs the real ladder and
   * ignores the grant: a presented proof is always verified.
   */
  stepUpGrantId?: string;
}

/** The route adapter re-emits this as `c.json(body, httpStatus)`; the batch
 *  path collects it per row. */
export type DecideApprovalResult = { httpStatus: number; body: Record<string, unknown> };

export async function decideApprovalRequest(
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const { id, status, reason, proof, reauthVerified = false } = input;

  // Wave 3b (parent plan §1.2): approval decisions are made by HUMANS,
  // structurally — asserted here on the principal discriminator rather than
  // relying on routing topology (no non-human route mounts this handler
  // today, but nothing else guarantees that stays true). An allowlist of
  // one: api_key, oauth_grant, ai_agent, system — none of them decide.
  if (!isInteractiveUserSession(input.auth)) {
    return { httpStatus: 403, body: { error: 'human_decision_required' } };
  }

  const userId = input.auth.user.id;
  if (!id) return { httpStatus: 400, body: { error: 'Bad request' } };

  // Pre-fetch so we can resolve the required assurance from the row's risk tier
  // before deciding (see the assertApprovalAssurance call below for the full
  // verify + enforcement behavior).
  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!existing) return { httpStatus: 404, body: { error: 'Not found' } };
  if (existing.status !== 'pending') {
    return {
      httpStatus: 409,
      body: { error: `Already ${existing.status}`, finalStatus: existing.status },
    };
  }
  if (existing.expiresAt <= new Date()) {
    return { httpStatus: 410, body: { error: 'Expired', finalStatus: 'expired' } };
  }

  // §6C (fix/pam-dedicated-permissions): the PAM mobile-bridge elevation
  // branch (elevationRequestId set — approval_requests_one_source_chk makes
  // this mutually exclusive with intentId) used to carry NO live permission
  // check at all — it fell straight through to the assurance ladder and CAS
  // write below. A row is fanned out to every eligible approver at REQUEST
  // time (services/pamApprovers.ts); nothing re-checked that the decider
  // STILL held PAM authority at DECIDE time, so a demoted technician (or one
  // who never should have been eligible) could approve or deny it. Checked
  // for BOTH approve and deny — unlike the four_eyes/action-intents gates
  // below (which only re-check on 'approved', because a deny there is
  // harmless), denying a PAM elevation is itself a PAM decision and requires
  // the same authority as approving one. Resolved the same way
  // `routes/approvals.ts`'s `makeOrgDecideAuthorizer` does: a bare
  // `withSystemDbAccessContext` from inside the ambient request context is a
  // no-op passthrough (db/index.ts), so `runOutsideDbContext` is required to
  // actually elevate.
  if (existing.elevationRequestId && !existing.intentId) {
    const elevationOrgId = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [row] = await db
          .select({ orgId: elevationRequests.orgId })
          .from(elevationRequests)
          .where(eq(elevationRequests.id, existing.elevationRequestId as string));
        return row?.orgId ?? null;
      }),
    );
    if (!elevationOrgId) {
      // Should be unreachable (ON DELETE SET NULL leaves elevationRequestId
      // null rather than dangling), but fail closed rather than proceed blind.
      return { httpStatus: 404, body: { error: 'elevation_not_found' } };
    }

    const deciderPerms = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        getUserPermissions(userId, {
          partnerId: input.auth.partnerId ?? undefined,
          orgId: elevationOrgId,
        }),
      ),
    );
    // hasPermission alone doesn't establish that the permission reaches THIS
    // org: getUserPermissions falls back to the partner axis when the decider
    // has no organization_users row for elevationOrgId, so a partner-scope
    // decider with org_access='selected' that doesn't cover elevationOrgId
    // would otherwise still pass. canAccessOrg closes that, mirroring the
    // intentId/four_eyes branch's `canAccessOrg(deciderPerms, linkedIntent.orgId)`
    // check below.
    if (
      !deciderPerms ||
      !canAccessOrg(deciderPerms, elevationOrgId) ||
      !hasPermission(deciderPerms, 'pam', 'approve')
    ) {
      return { httpStatus: 403, body: { error: 'pam_approve_required' } };
    }
  }

  // Action intents (spec docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
  // §4, §3.4): load the linked intent early so the digest-binding and
  // sole-operator checks below can run BEFORE the approval CAS. System
  // context, mirroring the elevation mirror's cross-row visibility need —
  // action_intents is org-scoped (Shape 1) and we want this read to succeed
  // regardless of the ambient request scope.
  let linkedIntent: ActionIntent | null = null;
  // Set true only for a supervised intent's requester-owned decide (Task 6).
  // Read below to skip the whole assertion/assurance ladder — supervised
  // decides no WebAuthn/step-up ceremony, only the live-RBAC re-check above.
  let isSupervisedSelfDecide = false;
  if (existing.intentId) {
    linkedIntent = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [row] = await db
          .select()
          .from(actionIntents)
          .where(eq(actionIntents.id, existing.intentId as string));
        return row ?? null;
      }),
    );

    if (!linkedIntent) {
      // Should be unreachable (ON DELETE CASCADE removes this approval row
      // along with its intent), but fail closed rather than proceed blind.
      return { httpStatus: 404, body: { error: 'intent_not_found' } };
    }

    // Digest binding (defense-in-depth, spec §3.3): refuse the decision if
    // the intent's content changed since this row was fanned out.
    if (
      existing.boundArgumentDigest &&
      existing.boundArgumentDigest !== linkedIntent.argumentDigest
    ) {
      // Tamper-detection tripwire: content changed after fan-out. Audit
      // this refusal — the release worker audits the same condition
      // (jobs/intentReleaseWorker.ts's `digest_mismatch` errorCode), and
      // this decide-time refusal is equally security-relevant. Ids/digests
      // only, never raw arguments (spec §3.2/§7).
      recordActionIntentEvent({
        orgId: linkedIntent.orgId,
        intentId: linkedIntent.id,
        actionName: linkedIntent.actionName,
        argumentDigest: linkedIntent.argumentDigest,
        source: linkedIntent.source,
        outcome: 'digest_mismatch',
        actorId: userId,
        details: {
          approvalId: existing.id,
          boundArgumentDigest: existing.boundArgumentDigest,
        },
      });
      return { httpStatus: 409, body: { error: 'digest_mismatch' } };
    }

    // Tier-3 supervised/four_eyes split (spec
    // docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
    // §4.2). Supervised intents fan out exactly ONE approval row, always owned
    // by the requester (services/actionIntents/intentService.ts) — no other
    // approvals:decide holder is ever eligible, and none of the four_eyes
    // machinery below (live approvals:decide re-check, sole-operator
    // re-derivation, the WebAuthn/step-up ladder) applies to it. Branching
    // here, BEFORE any of that runs, is what lets a supervised requester who
    // holds no approvals:decide permission at all still decide their own row.
    //
    // Wave 3b Task 6 (review blocker 2): a supervised AGENT-originated intent
    // (`requestingAgentRunId` set, requester NULL) takes a COMPLETELY separate
    // branch — swapping only the `not_requester` 403 would not be enough:
    //
    //  - Authority is the live action-and-target re-check
    //    (`isAgentIntentDecideAuthorized`): does THIS decider currently hold
    //    the tool's full RBAC mapping AND reach the intent's concrete target?
    //    Exactly the predicate creation fanned out on, re-derived at decide
    //    time the way four_eyes re-derives approvals:decide.
    //  - The human branch's requester-RBAC re-check (buildAuthContextForIntent
    //    + checkToolPermission) must be SKIPPED: Task 7 reconstructs an
    //    `ai_agent` principal for this intent, and checkToolPermission's first
    //    statement denies that kind — left in place, EVERY supervised agent
    //    approval would 403. The decider's own action RBAC was just verified
    //    above; the agent-policy re-check happens at release (Task 7).
    //  - `isSupervisedSelfDecide` stays FALSE: agent intents never skip the
    //    assurance ladder — a headless proposal gets the same ceremony a
    //    four_eyes decision would.
    //
    // Unconditional (approve AND deny), like the human identity gate: rows are
    // only ever fanned out to eligible users, so an ineligible decider here is
    // a lost permission or a tampered row — fail closed either way. (The
    // requester-less cancel contract for `approvals:decide` holders is the
    // cancel endpoint, Task 8 — not this handler.)
    if (linkedIntent.approvalScope === 'supervised' && linkedIntent.requestingAgentRunId != null) {
      if (!(await isAgentIntentDecideAuthorized(userId, linkedIntent))) {
        recordActionIntentEvent({
          orgId: linkedIntent.orgId,
          intentId: linkedIntent.id,
          actionName: linkedIntent.actionName,
          argumentDigest: linkedIntent.argumentDigest,
          source: linkedIntent.source,
          outcome: 'approver_unauthorized',
          actorId: userId,
          details: { approvalId: existing.id, errorCode: 'not_authorized_for_agent_intent' },
        });
        return { httpStatus: 403, body: { error: 'not_authorized_for_agent_intent' } };
      }
    } else if (linkedIntent.approvalScope === 'supervised') {
      isSupervisedSelfDecide = true;

      // Identity gate: even if a non-requester somehow reached this row (a
      // future bug, manual DB tampering, or an admin-decide-any-row surface
      // added later), a supervised row's whole trust model rests on "the
      // requester is deciding their own action" — holding approvals:decide
      // must NEVER substitute for that identity check, since supervised
      // decides skip the assertion ladder entirely below. Unconditional
      // (both approve and deny): nobody but the requester is ever a
      // legitimate decider for this row.
      if (linkedIntent.requestedByUserId !== userId) {
        recordActionIntentEvent({
          orgId: linkedIntent.orgId,
          intentId: linkedIntent.id,
          actionName: linkedIntent.actionName,
          argumentDigest: linkedIntent.argumentDigest,
          source: linkedIntent.source,
          outcome: 'approver_unauthorized',
          actorId: userId,
          details: { approvalId: existing.id, errorCode: 'not_requester' },
        });
        return { httpStatus: 403, body: { error: 'not_requester' } };
      }

      // Live RBAC re-check for the underlying TOOL action (spec §4.2) — NOT
      // approvals:decide, which supervised intents never require. Mirrors the
      // release worker's revalidation (services/actionIntents/revalidateRelease.ts)
      // so the decide-time and release-time gates can never diverge: same
      // `buildAuthContextForIntent` + `checkToolPermission(actionName,
      // arguments, auth)` pair. Gated to `approved` only — a deny only cancels
      // the action and must stay available even to a requester who lost the
      // underlying permission. System-scoped: buildAuthContextForIntent reads
      // the requester's role from organization_users/partner_users, which the
      // caller's own ambient request context may not make visible (partner
      // approvers have no organization_users row) — and a bare (non-exited)
      // withSystemDbAccessContext call from inside the ambient request context
      // is a no-op passthrough (db/index.ts), so this must go through
      // runOutsideDbContext to actually elevate.
      if (status === 'approved') {
        const revalidation = await runOutsideDbContext(() =>
          withSystemDbAccessContext(async () => {
            const auth = await buildAuthContextForIntent(linkedIntent!);
            if (!auth) return { ok: false as const, errorCode: 'actor_invalid' };
            const denial = await checkToolPermission(
              linkedIntent!.actionName,
              linkedIntent!.arguments,
              auth,
            );
            if (denial) return { ok: false as const, errorCode: 'rbac_denied', reason: denial };
            return { ok: true as const };
          }),
        );
        if (!revalidation.ok) {
          recordActionIntentEvent({
            orgId: linkedIntent.orgId,
            intentId: linkedIntent.id,
            actionName: linkedIntent.actionName,
            argumentDigest: linkedIntent.argumentDigest,
            source: linkedIntent.source,
            outcome: 'approver_unauthorized',
            actorId: userId,
            details: { approvalId: existing.id, errorCode: revalidation.errorCode },
          });
          return { httpStatus: 403, body: { error: 'forbidden' } };
        }
      }
    } else {
      // four_eyes (unchanged): re-check the DECIDER's live authorization before
      // an intent-backed APPROVE (spec §4). The fanned-out approval_requests row
      // (Shape-6, user-id-scoped) is otherwise a durable bearer capability: it
      // was created for a user who held approvals:decide over the intent's org
      // at fan-out time (services/actionIntents/intentApprovers.ts), but nothing
      // re-checks that they STILL hold it. An Org Admin demoted to a role
      // without approvals:decide (while keeping org membership, so the row
      // stays visible) could otherwise still approve and drive a release.
      // Resolve current perms for the intent's org and fail closed. Gated to
      // `approved` only: a deny is harmless (it cancels the action) and must
      // stay available even to a demoted approver. Checked BEFORE the
      // assurance proof below so a stale approver never even consumes a
      // WebAuthn challenge. Uses system context so the org membership/role
      // reads resolve regardless of ambient request scope (partner approvers
      // have no organization_users row).
      if (status === 'approved') {
        const deciderPerms = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            getUserPermissions(userId, {
              partnerId: input.auth.partnerId ?? undefined,
              orgId: linkedIntent!.orgId,
            }),
          ),
        );
        if (
          !deciderPerms ||
          !canAccessOrg(deciderPerms, linkedIntent.orgId) ||
          !userCanDecideApprovals(deciderPerms)
        ) {
          recordActionIntentEvent({
            orgId: linkedIntent.orgId,
            intentId: linkedIntent.id,
            actionName: linkedIntent.actionName,
            argumentDigest: linkedIntent.argumentDigest,
            source: linkedIntent.source,
            outcome: 'approver_unauthorized',
            actorId: userId,
            details: { approvalId: existing.id },
          });
          return { httpStatus: 403, body: { error: 'forbidden' } };
        }

        // Sole-operator RE-DERIVATION (#2685). Four-eyes for a Tier-3 intent is
        // otherwise decided exactly once, at fan-out
        // (services/actionIntents/intentService.ts), by branch mutual exclusion:
        // the multi-approver branch fans rows out to OTHER users, and only the
        // sole-operator branch ever creates a requester-owned row. Nothing
        // downstream re-establishes that — this handler used to infer "you were
        // the only eligible approver" purely from "a row exists that you own".
        // Since release is first-wins CAS, any future fan-out regression that
        // leaked a requester-owned row into a multi-approver intent would let the
        // requester unilaterally release it with no server-side check catching
        // it. So re-derive the eligible set here and require the self-approver to
        // STILL be the only eligible approver for the intent's org.
        //
        // This is deliberately a re-derivation, not a persisted `sole_operator`
        // flag (issue #2685 option 2 over option 1): it fails closed, and "you
        // are no longer the only approver, so you no longer get to self-approve"
        // is what the four-eyes model implies. An intent created while solo and
        // decided after the org gained a second approver is REFUSED — intended.
        // A persisted flag would still let that self-approve through.
        //
        // Only runs on a self-approve (requester === decider), so the common
        // cross-user approve pays nothing. `resolveIntentApprovers` opens its own
        // system context internally (partner_users is Shape-3 partner-axis RLS,
        // invisible from an org-scoped request context), so it must be called
        // with runOutsideDbContext — a nested withDbAccessContext RETAINS the
        // ambient context rather than elevating (db/index.ts) — and calling it
        // outside any context also avoids holding a pooled connection across the
        // round-trip (the #1105 connection-hold class).
        //
        // Ordered with the stale-approver check ABOVE the assurance proof for the
        // same reason that one is: a refused decision must never consume a
        // WebAuthn challenge. Gated to `approved` only — a deny stays available
        // in every case, since denying only cancels the action.
        if (linkedIntent.requestedByUserId === userId) {
          const eligibleNow = await runOutsideDbContext(() =>
            resolveIntentApprovers(linkedIntent!.orgId),
          );
          const othersEligible = eligibleNow.filter((candidate) => candidate !== userId);
          // "ONLY eligible approver" is both halves: nobody else is eligible AND
          // the self-approver still is. The second half is belt-and-braces over
          // the live-authorization re-check above (which asks the permissions
          // service rather than this resolver) — if the two ever disagree, refuse.
          if (othersEligible.length > 0 || !eligibleNow.includes(userId)) {
            recordActionIntentEvent({
              orgId: linkedIntent.orgId,
              intentId: linkedIntent.id,
              actionName: linkedIntent.actionName,
              argumentDigest: linkedIntent.argumentDigest,
              source: linkedIntent.source,
              outcome: 'approver_unauthorized',
              actorId: userId,
              details: {
                approvalId: existing.id,
                errorCode: 'not_sole_approver',
                // Count only — never the approver ids (spec §7: ids of the
                // event's own subjects, not a roster of other users).
                eligibleApproverCount: eligibleNow.length,
              },
            });
            return { httpStatus: 403, body: { error: 'not_sole_approver' } };
          }
        }
      }
    }
  }

  // ── W03 (#5612): STRICT acknowledgement ceremony (spec §4.5) ─────────────
  // Only on APPROVE, only for an intent whose run_script arguments name a
  // proposal, only when that proposal has strict hits. Everything else
  // short-circuits before any extra DB read. Placed AFTER the supervised /
  // four-eyes authority checks (an unauthorised decider is refused first, with
  // the existing 403s) and BEFORE the assurance ladder, so a refused
  // acknowledgement never consumes a WebAuthn challenge.
  let acknowledgedPatterns: string[] = [];
  let proposalIdForDecision: string | null = null;
  if (status === 'approved' && linkedIntent?.actionName === 'run_script') {
    const proposalId = (linkedIntent.arguments as { proposalId?: unknown } | null)?.proposalId;
    if (typeof proposalId === 'string' && proposalId.length > 0) {
      const proposal = await loadProposalRow(proposalId);
      if (proposal && (proposal.strictHits?.length ?? 0) > 0) {
        const resolved = await resolveStrictAcknowledgement({
          auth: input.auth,
          proposal: { strictHits: proposal.strictHits, orgId: proposal.orgId },
          submitted: input.acknowledgedPatterns ?? [],
        });
        if (!resolved.ok) {
          recordActionIntentEvent({
            orgId: linkedIntent.orgId,
            intentId: linkedIntent.id,
            actionName: linkedIntent.actionName,
            argumentDigest: linkedIntent.argumentDigest,
            source: linkedIntent.source,
            outcome: 'approver_unauthorized',
            actorId: userId,
            details: { approvalId: existing.id, errorCode: resolved.error, proposalId },
          });
          const { ok: _ok, ...body } = resolved;
          return { httpStatus: 422, body: body as Record<string, unknown> };
        }
        acknowledgedPatterns = resolved.acknowledged;
        proposalIdForDecision = proposalId;
      }
    }
  }

  // Phase 2/3: verify an optional assertion proof. No proof → L1 session tap. A
  // presented-but-invalid proof throws → 401 (never silently L1). The L3 recency
  // clock is derived server-side from the consumed challenge (no param here);
  // `reauthVerified` is the only decide-surface factor, supplied by the approve
  // handler after a fresh password re-auth (required only for critical/L4).
  // Phase 4: an ENFORCING partner policy may reject an under-assured APPROVE
  // (StepUpRequiredError → 403). A deny is passed through with decision:'denied'
  // so it is never blocked.
  //
  // Supervised self-decide (Task 6): skip the WHOLE assertion/assurance ladder
  // — no WebAuthn challenge, no partner-policy step-up floor, no
  // ReauthRequiredError ceremony — but ONLY when both of the following hold.
  //
  //  1. The partner's authenticator policy is not actively ENFORCING (fix
  //     round 1, finding 5 — adjudicated requirement). An enforcing partner's
  //     step-up floor must not be silently bypassed just because an intent
  //     classified as supervised: the requester can still satisfy it with a
  //     WebAuthn L3 proof, exactly like the four_eyes sole-operator
  //     self-approve does.
  //  2. NO proof was presented (fix round 2, finding 1). `skipAssuranceLadder`
  //     used to ignore `proof` entirely, so a mobile approver device that
  //     signed the decision in its Secure Enclave had that signature silently
  //     DISCARDED: never verified, anti-clone signature counter never bumped,
  //     challenge left unconsumed, and the audit row recorded L1 /
  //     'session_tap' / device_id NULL. Worse, a FORGED or REPLAYED proof was
  //     ignored rather than rejected, so the approve succeeded at L1 instead
  //     of 401ing — contradicting this handler's own "a presented-but-invalid
  //     proof throws → 401 (never silently L1)" invariant and the mobile
  //     client's contract. An optional proof therefore always goes through the
  //     real ladder; the sole-operator gate below is what keeps it from
  //     turning into a NEW blocking requirement.
  //
  // Only checked for an approve (deny is never blocked by assurance, so
  // there's no reason to spend a partner-policy read on it) —
  // `resolveApprovalAssurance` is the same synchronous "no proof presented"
  // L1/session_tap default `proof===undefined` resolves to today; reusing it
  // (rather than hand-rolling the literal) keeps the recorded factor
  // byte-for-byte identical to that existing no-proof shape and impossible to
  // drift from `assertDecisionConsistent`'s invariants.
  //
  // P2-2 batch decide: `preverifiedAssurance` short-circuits this ENTIRE block
  // (proof verification, partner-policy floor, sole-operator step-up) because
  // the batch already ran it ONCE against `batchAssertionKey(...)` — the
  // single-use WebAuthn challenge / mobile nonce cannot be consumed again per
  // row. Nothing else about this handler changes; see `preverifiedAssurance`
  // on `DecideApprovalInput` for the full list of gates that still run.
  const isPartnerEnforcingForSupervised =
    !input.preverifiedAssurance && isSupervisedSelfDecide && status === 'approved'
      ? isEnforcing(await loadPartnerPolicy(input.auth.partnerId ?? null), new Date())
      : false;
  // #5601: a presented grant suppresses the shortcut for the same reason a
  // presented proof does — a credential the caller offered must be ADJUDICATED
  // (accepted, or refused with 403), never silently dropped on the floor while
  // the decide succeeds at L1.
  const presentedGrantId = input.preverifiedAssurance ? undefined : input.stepUpGrantId;
  const skipAssuranceLadder =
    isSupervisedSelfDecide
    && !isPartnerEnforcingForSupervised
    && proof === undefined
    && presentedGrantId === undefined;

  let assurance: AssuranceDecision;
  if (input.preverifiedAssurance) {
    assurance = input.preverifiedAssurance;
  } else if (skipAssuranceLadder) {
    assurance = resolveApprovalAssurance(existing.riskTier as RiskTier);
  } else if (presentedGrantId !== undefined && proof === undefined && status === 'approved') {
    // #5601 REDEEM PATH. Replaces the ceremony, never the authorization: every
    // other gate in this handler (human principal, row pending/expiry, live
    // authorization, digest binding, isAgentIntentDecideAuthorized,
    // sole-operator re-derivation below, CAS) still runs per row, unchanged.
    //
    // Supervised rows only: `resolveGrantScope` (inside redeemGrantForDecide)
    // returns null for any other approval scope, so a four_eyes decide that
    // presents a grant is refused below with 403 and must bring a fresh
    // proof — the four_eyes sole-operator >= L3 gate is untouched.
    //
    // `status === 'approved'` is a FAIL-SAFE, not a redundancy. Neither /deny
    // nor the batch populates `stepUpGrantId` today, so a deny cannot reach
    // here — but this branch's whole contract is "refuse with 403 when the
    // credential is no good", and spec §12 says a technician must NEVER be
    // unable to REFUSE. Without this guard, the day someone plumbs the field
    // through the deny route, a stale grant would start blocking denials. A
    // deny instead falls through to the ladder with no proof, i.e. today's L1
    // session tap, which is exactly right.
    const redeemed = await redeemGrantForDecide({
      grantId: presentedGrantId,
      auth: input.auth,
      userId,
      riskTier: existing.riskTier as RiskTier,
      intent: linkedIntent,
      decision: status,
    });
    if (!redeemed) {
      // FAIL CLOSED. Expired / wrong binding / wrong scope / revoked approver
      // device / Redis down all land here, and none of them may fall through
      // to an L1 session tap — letting an expired credential become a session
      // tap is the exact silent downgrade this design exists to prevent. The
      // client re-runs a fresh ceremony on this token.
      return {
        httpStatus: 403,
        body: { error: 'step_up_required', requiredLevel: requiredAssurance(existing.riskTier as RiskTier) },
      };
    }
    // Same invariant backstop the fresh-ladder path gets inside
    // `assertApprovalAssurance`. `parseGrantContext` already enforces the same
    // factor/level/device-id invariants independently, so this cannot fire
    // today — but a reconstructed decision is written verbatim to the audit
    // columns, and the two paths that build one should be guarded alike rather
    // than relying on a reader to notice only one of them is.
    assertDecisionConsistent(redeemed);
    assurance = redeemed;
  } else {
    try {
      assurance = await assertApprovalAssurance({
        approvalId: id,
        userId,
        riskTier: existing.riskTier as RiskTier,
        proof,
        partnerId: input.auth.partnerId ?? null,
        decision: status,
        reauthVerified,
      });
    } catch (err) {
      if (err instanceof StepUpRequiredError) {
        return { httpStatus: 403, body: { error: 'step_up_required', requiredLevel: err.requiredLevel } };
      }
      if (err instanceof ReauthRequiredError) {
        // Critical (L4) approve with a valid signature but no fresh re-auth — tell
        // the client to re-collect the password and retry, not a generic failure.
        return { httpStatus: 401, body: { error: 'reauth_required' } };
      }
      console.error('[approvals] assertion verification failed:', err);
      return { httpStatus: 401, body: { error: 'assertion_failed' } };
    }
  }

  // #5601: the sole-operator gate is SHARED by the fresh-proof path and the
  // grant-redeem path, which is why it sits here rather than inside the ladder
  // branch where it used to live. A redeem branch that sat beside the ladder
  // and skipped this gate would route an enforcing-partner supervised
  // self-decide around its own >= L3 requirement — the exact regression this
  // placement prevents. (four_eyes never reaches the redeem branch at all.)
  //
  // Still skipped for the two branches that were never gated: the batch's
  // `preverifiedAssurance` (the gate already ran once at batch level against
  // batchAssertionKey) and `skipAssuranceLadder` (a plain supervised click
  // under a non-enforcing partner, which must keep passing).
  if (!input.preverifiedAssurance && !skipAssuranceLadder) {
    // Sole-operator step-up (spec §1 / §4): a requester approving their OWN
    // intent (the four_eyes sole-operator single-row fan-out case, OR a
    // supervised row under an enforcing partner policy) must present >= L3
    // assurance (webauthn_platform or mobile_hw_key). Checked BEFORE the CAS
    // so an under-assured self-approval never flips the row. Deny is
    // unaffected — only an approve of one's own intent is gated.
    //
    // `requestedByUserId === userId` is UNCONDITIONALLY true for a supervised
    // row (its sole approval row is always the requester's), so the gate must
    // additionally exclude the non-enforcing supervised case — otherwise
    // routing an OPTIONAL proof through the ladder (fix round 2, finding 1)
    // would turn a proof that only reaches L2 (say, a stale challenge) into a
    // 403 on a decide that a plain click passes. Under a non-enforcing partner
    // policy an optional proof on a supervised decide can therefore only ever
    // RAISE the recorded assurance, never block it. Under an ENFORCING policy
    // the gate applies exactly as before, and four_eyes is untouched.
    if (
      linkedIntent &&
      status === 'approved' &&
      linkedIntent.requestedByUserId === userId &&
      (!isSupervisedSelfDecide || isPartnerEnforcingForSupervised)
    ) {
      const level = assurance.decidedAssuranceLevel ?? 0;
      if (level < 3) {
        return { httpStatus: 403, body: { error: 'step_up_required', requiredLevel: 3 } };
      }
    }
  }

  // Task 6: the ENTIRE decision write — approval-row CAS, the ai_tool_executions
  // mirror, and the action-intents fan-in (intent CAS + release_by stamp +
  // sibling expiry + intent_approved outbox insert) — commits as ONE
  // transaction. Before this, the intent fan-in ran in its own,
  // independently-committing transaction: a fault there left the approval row
  // decided with NO intent/outbox follow-through (or vice versa on other
  // fault points), a state no retry could repair. Now any throw here rolls
  // EVERYTHING back and the caller gets a retryable 500 instead of a
  // half-applied decision.
  //
  // System-scoped (runOutsideDbContext + withSystemDbAccessContext, exactly
  // like the fan-in already was): the sibling approval_requests rows belong to
  // OTHER approvers and are invisible under the caller's own Shape-6
  // user-id-scoped ambient context, and action_intents/ai_tool_executions need
  // org-scoped visibility the caller's ambient scope doesn't guarantee either.
  // System scope is safe here because authorization was already fully decided
  // by the checks above — this is purely a write, not a fresh access decision.
  // Push dispatch and any other network I/O stay OUTSIDE this transaction
  // (#1105 — never hold a txn across network I/O); there is none in this path.
  type DecideWriteResult =
    | { lostRace: true }
    | {
        lostRace: false;
        updated: typeof approvalRequests.$inferSelect;
        wonIntent: boolean;
        enforcementStatus: 'pending_dispatch' | 'cleanup_pending' | null;
      };

  let writeResult: DecideWriteResult;
  try {
    writeResult = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx): Promise<DecideWriteResult> => {
          // Fix round 1, finding 2 (lock-order inversion): report-suspicious
          // and intentExpiryReaper both lock action_intents BEFORE touching
          // approval_requests. This transaction used to lock its OWN
          // approval_requests row first and the intent second — the opposite
          // order — so a concurrent report-suspicious/reaper transaction
          // (intent held, waiting on a sibling approval_requests row this
          // transaction already holds) and this transaction (approval_requests
          // row held, waiting on the intent report-suspicious/reaper already
          // holds) could deadlock (Postgres 40P01 → a user-visible 500).
          // Taking the SAME intent-first lock here makes every writer agree on
          // one global order, so concurrent transactions serialize instead of
          // cycling. `existing.intentId` is read from the pre-fetch outside
          // this transaction, before any lock is held.
          if (existing.intentId) {
            await tx
              .select({ id: actionIntents.id })
              .from(actionIntents)
              .where(eq(actionIntents.id, existing.intentId))
              .for('update');
          }

          if (proposalIdForDecision && acknowledgedPatterns.length > 0) {
            // W03: persisted on the PROPOSAL, not on the approval row — dispatch
            // reads the proposal (ScriptDispatchSource { kind: 'proposal' }) and
            // the release worker projects only (id, status, bound_argument_digest)
            // off the approval. Same transaction as the CAS below so a lost
            // decision race cannot leave an acknowledgement behind.
            await tx
              .update(scriptProposals)
              .set({ acknowledgedPatterns })
              .where(eq(scriptProposals.id, proposalIdForDecision));
          }

          const casRows = await tx
            .update(approvalRequests)
            .set({
              status,
              decidedAt: new Date(),
              decisionReason: reason ?? null,
              decidedAssuranceLevel: assurance.decidedAssuranceLevel,
              decidedVia: assurance.decidedVia,
              authenticatorDeviceId: assurance.authenticatorDeviceId,
              // #5601: in the SAME transaction as the assurance columns above,
              // so a reused-grant decision can never commit looking like a
              // fresh ceremony (the equivalent audit event is post-commit and
              // droppable).
              decidedViaStepUpGrant: assurance.stepUpGrantReuse === true,
            })
            .where(
              and(
                eq(approvalRequests.id, id),
                eq(approvalRequests.userId, userId),
                eq(approvalRequests.status, 'pending'),
                gt(approvalRequests.expiresAt, new Date()),
              )
            )
            .returning();

          if (casRows.length === 0) {
            // Lost a concurrent decide/expiry race between the pre-fetch and
            // the CAS. Not a failure — the transaction still commits (nothing
            // was written), and the caller gets a plain 409 below.
            return { lostRace: true };
          }
          const updated = casRows[0]!;

          let enforcementStatus: 'pending_dispatch' | 'cleanup_pending' | null = null;
          if (updated.elevationRequestId) {
            const now = new Date();
            const expiresAt = status === 'approved'
              ? new Date(now.getTime() + PAM_ELEVATION_GRANT_MINUTES * 60_000)
              : null;
            const elevationRows = await tx
              .update(elevationRequests)
              .set(
                status === 'approved'
                  ? {
                      status: 'approved',
                      approvedByUserId: userId,
                      approvedAt: now,
                      expiresAt,
                      updatedAt: now,
                      decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                      decidedVia: assurance.decidedVia,
                      authenticatorDeviceId: assurance.authenticatorDeviceId,
                    }
                  : {
                      status: 'denied',
                      deniedByUserId: userId,
                      denialReason: reason ?? null,
                      updatedAt: now,
                      decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                      decidedVia: assurance.decidedVia,
                      authenticatorDeviceId: assurance.authenticatorDeviceId,
                    },
              )
              .where(and(
                eq(elevationRequests.id, updated.elevationRequestId),
                eq(elevationRequests.status, 'pending'),
              ))
              .returning({
                id: elevationRequests.id,
                orgId: elevationRequests.orgId,
                deviceId: elevationRequests.deviceId,
                revision: elevationRequests.revision,
                targetExecutablePath: elevationRequests.targetExecutablePath,
                targetExecutableHash: elevationRequests.targetExecutableHash,
                subjectUsername: elevationRequests.subjectUsername,
              });

            if (elevationRows.length > 0) {
              const elevation = elevationRows[0]!;
              await tx.insert(elevationAudit).values({
                orgId: elevation.orgId,
                elevationRequestId: elevation.id,
                eventType: status === 'approved' ? 'approved' : 'denied',
                actor: 'technician',
                actorUserId: userId,
                details: {
                  source: 'mobile_approval',
                  approval_request_id: updated.id,
                  ...(status === 'denied' && reason ? { reason } : {}),
                },
                occurredAt: now,
              });
              const actuation = await createPamDecisionIntent(tx, {
                request: {
                  id: elevation.id,
                  orgId: elevation.orgId,
                  deviceId: elevation.deviceId,
                  targetExecutablePath: elevation.targetExecutablePath ?? '',
                  targetExecutableHash: elevation.targetExecutableHash,
                  subjectUsername: elevation.subjectUsername,
                },
                requestRevision: elevation.revision,
                decision: status,
                expiresAt,
              });
              enforcementStatus = actuation.desiredState === 'active'
                ? 'pending_dispatch'
                : 'cleanup_pending';

              await tx
                .update(approvalRequests)
                .set({ status: 'expired', decidedAt: now })
                .where(and(
                  eq(approvalRequests.elevationRequestId, elevation.id),
                  eq(approvalRequests.status, 'pending'),
                  ne(approvalRequests.id, updated.id),
                ));
            }
          }

          // If this approval row was created by the AI agent SDK (Breeze AI /
          // chat), it carries an `executionId` linking back to the
          // ai_tool_executions row that the SDK is blocked on via
          // waitForApproval(). Flip that row's status so the SDK's poll
          // unblocks and the tool either executes or returns "rejected or
          // timed out". For non-AI sources (helper, dev seed) execution_id is
          // null and this is a no-op.
          if (updated.executionId) {
            const aiStatus = status === 'approved' ? 'approved' : 'rejected';
            const mirrored = await tx
              .update(aiToolExecutions)
              .set({ status: aiStatus, approvedBy: userId, approvedAt: new Date() })
              // Guarded on 'pending' (#3089): a settled approval wait marks the
              // execution row 'rejected' without touching this approval_requests
              // row first in every failure mode, so a decide that squeaked past
              // the approval_requests CAS must not resurrect a closed execution
              // row as a stranded 'approved' that the legacy bridge (no durable
              // worker) would never run.
              //
              // Fix round 1, finding 3 (tenant/linkage guard): this UPDATE runs
              // under system scope (no RLS), and `ai_tool_executions` has no
              // org_id column of its own — it's scoped via its `ai_sessions`
              // row. Matching on `updated.executionId` alone relies entirely on
              // that FK having been populated correctly at insert time (an
              // app-layer guarantee, not a DB-enforced one), which the repo's
              // tenancy contract treats as insufficient for a system-scoped
              // write. This executionId-linked flow (services/aiAgentSdk.ts's
              // mobile waitForApproval path) is ALWAYS a self-approval — the
              // approval_requests row's own userId (== `userId` here, already
              // proven equal by the CAS's WHERE clause above) must own the
              // session the execution belongs to. Carrying that check inside
              // the UPDATE's WHERE (not as a separate app-layer assertion)
              // means a wrong/stale executionId fails closed (0 rows) instead
              // of silently mutating another tenant's execution row.
              .where(and(
                eq(aiToolExecutions.id, updated.executionId),
                eq(aiToolExecutions.status, 'pending'),
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(aiSessions)
                    .where(and(
                      eq(aiSessions.id, aiToolExecutions.sessionId),
                      eq(aiSessions.userId, userId),
                    )),
                ),
              ))
              .returning({ id: aiToolExecutions.id });
            if (mirrored.length === 0) {
              // Lost the race, not a query failure: the execution row was
              // already closed out (settled/timed out) between the
              // approval_requests CAS above and this mirror — same
              // first-wins posture as the elevation and intent mirrors below.
              // approval_requests is still the source of truth for the
              // mobile UI and correctly records this approver's decision,
              // but the underlying tool call is already gone and will NOT
              // run despite the 'approved' response below — worth a distinct
              // log line so this isn't mistaken for the mirror failing.
              console.warn('[approvals] ai_tool_executions mirror lost the race (execution already settled):', updated.executionId);
            }
          }

          // Action intents (spec §4 / §3.4): mirror the decision onto the
          // linked action_intents row. First-wins inline CAS — a lost race
          // (another approver, the reaper, or a retry already decided the
          // intent) is a clean no-op: this row's own decision still commits
          // (with the rest of this transaction), so the user's decide call
          // still succeeds either way.
          let wonIntent = false;
          if (updated.intentId && linkedIntent) {
            const intentId = updated.intentId;
            const intentTargetStatus: ActionIntentStatus = status === 'approved' ? 'approved' : 'rejected';

            const intentCas = await tx
              .update(actionIntents)
              .set({
                status: intentTargetStatus,
                decidedAt: new Date(),
                decidedByUserId: userId,
                decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                decidedVia: assurance.decidedVia,
                ...stampReleaseLease(intentTargetStatus),
              })
              .where(
                and(
                  eq(actionIntents.id, intentId),
                  eq(actionIntents.status, 'pending_approval'),
                ),
              )
              .returning({ id: actionIntents.id });

            if (intentCas.length > 0) {
              wonIntent = true;

              // MUST run in the same system-scoped transaction: approval_requests
              // is Shape-6 (user-id-scoped), so the sibling rows belong to OTHER
              // approvers and are invisible to this approver's own ambient
              // context — a context-scoped UPDATE would silently match zero rows.
              await tx
                .update(approvalRequests)
                .set({ status: 'expired', decidedAt: new Date() })
                .where(
                  and(
                    eq(approvalRequests.intentId, intentId),
                    eq(approvalRequests.status, 'pending'),
                    ne(approvalRequests.id, updated.id),
                  ),
                );

              // Both outcomes are recorded. Before wave 2 only 'approved' was
              // written, so a DENIED intent produced no outbox row at all and a
              // requester whose chat turn had already ended could never be told
              // what happened to it. In the same transaction as the status
              // change, so the record cannot disagree with the decision.
              if (status === 'approved') {
                await tx.insert(intentOutbox).values({
                  intentId,
                  eventType: 'intent_approved',
                  // Ids only, no argument content (spec §3.2).
                  payload: { intentId, orgId: linkedIntent.orgId },
                });
              } else {
                // #5205 W05 (#5210): same intentOutbox row this always wrote,
                // plus (when task-linked) the task_outbox leg —
                // `linkedIntent.taskId` is the pre-transaction snapshot,
                // which is safe because task linkage is immutable.
                await publishIntentTerminalOutbox(
                  tx,
                  { id: intentId, orgId: linkedIntent.orgId, taskId: linkedIntent.taskId },
                  'intent_rejected',
                );
              }
            }
          }

          return { lostRace: false, updated, wonIntent, enforcementStatus };
        }),
      ),
    );
  } catch (err) {
    console.error('[approvals] decide transaction failed (rolled back):', err);
    return { httpStatus: 500, body: { error: 'decide_failed', retryable: true } };
  }

  if (writeResult.lostRace) {
    return { httpStatus: 409, body: { error: 'Already decided', finalStatus: 'expired' } };
  }

  const { updated, wonIntent, enforcementStatus } = writeResult;

  // Action intents (spec §4 / §3.4): post-commit audit/metrics projection for
  // the intent fan-in that already committed (or rolled back) as part of the
  // ONE decide transaction above. `wonIntent` reflects whether THIS decide's
  // CAS actually transitioned the intent (a lost race — another approver, the
  // reaper, or a retry already decided it — is a clean no-op: no event here,
  // but this row's own decision still committed above either way).
  if (wonIntent && updated.intentId && linkedIntent) {
    // Gated on four_eyes: a supervised intent's sole approval row is ALWAYS
    // owned by the requester (the supervised short-circuit above, enforced
    // by the identity gate at the top of this handler), so "requester ===
    // decider" is true for EVERY supervised approve, not just the four_eyes
    // "only eligible approver happened to be the requester" case. Letting
    // that through here would mean `self_approved_sole_operator` — and the
    // audit signal built on it — fires on ordinary supervised approves,
    // burying the four_eyes L3 self-approval signal it exists to isolate.
    const isSelfApprove = status === 'approved' && linkedIntent.requestedByUserId === userId;
    const soleOperatorApproval = isSelfApprove && linkedIntent.approvalScope === 'four_eyes';
    const supervisedSelfApproval = isSelfApprove && linkedIntent.approvalScope === 'supervised';
    recordActionIntentEvent({
      orgId: linkedIntent.orgId,
      intentId: updated.intentId,
      actionName: linkedIntent.actionName,
      argumentDigest: linkedIntent.argumentDigest,
      source: linkedIntent.source,
      outcome: soleOperatorApproval
        ? 'self_approved_sole_operator'
        : status === 'approved'
          ? 'approved'
          : 'rejected',
      actorId: userId,
      details: {
        approvalRequestId: updated.id,
        decidedAssuranceLevel: assurance.decidedAssuranceLevel,
        decidedVia: assurance.decidedVia,
        ...(supervisedSelfApproval ? { approvalMethod: 'supervised_self' as const } : {}),
        // #5601: a redeemed row keeps the honest level/factor above (they
        // describe a real ceremony), so THIS is the only thing that says a
        // second ceremony did not happen. Emitted only on reuse, so a fresh
        // ceremony's rows and any dashboard built on them are unchanged and
        // "reused" is never the default reading of a missing field. The
        // durable statement is approval_requests.decided_via_step_up_grant —
        // this event is post-commit and droppable.
        ...(assurance.stepUpGrantReuse ? { assuranceSource: 'step_up_grant' as const } : {}),
      },
    });
  }

  // #5601: mint the reusable "recent ceremony" credential — HERE, after the
  // whole decide transaction resolved and after the `lostRace` return above,
  // never at the CAS itself (which is still inside the surrounding
  // system-context transaction and can roll back). A decide that lost a race,
  // 403'd, or rolled back must never leave a reusable credential behind.
  //
  // `wonIntent` is required as well as a committed row: the approval row can
  // commit while the linked-intent CAS loses to another approver, and this
  // core deliberately returns success in that case. Without it, "a decide that
  // lost a race never mints" would not actually be true. The cost of the
  // stricter rule is one extra ceremony in a rare race.
  //
  // Best effort throughout: a mint failure (Redis down, ineligible scope,
  // no sid) only costs the operator another ceremony and must NEVER fail an
  // approval that has already committed.
  let mintedGrantId: string | null = null;
  if (
    status === 'approved'
    && wonIntent
    && linkedIntent
    && !input.preverifiedAssurance
    && !assurance.stepUpGrantReuse
  ) {
    try {
      const scope = await resolveGrantScope(linkedIntent, existing.riskTier as RiskTier);
      const session = scope ? await resolveGrantSession(input.auth) : null;
      if (scope && session) {
        mintedGrantId = await mintApprovalDecideGrant({
          userId,
          ...session,
          scope,
          assurance,
        });
      }
    } catch (err) {
      console.error('[approvals] step-up grant mint failed (decision already committed):', err);
    }
  }

  // P2-2: the decide response carries the SAME target projection the inbox
  // list does — a client that re-renders the card from this response must not
  // watch `targetDevice` blank out just because the row was just decided.
  const decidedTargetRef = toIntentTargetRef(linkedIntent);
  const decidedTargetDevices = await resolveTargetDevices([
    { key: updated.id, intent: decidedTargetRef },
  ]);
  return {
    httpStatus: 200,
    body: {
      approval: serialize(
        updated,
        null,
        linkedIntent?.approvalScope ?? null,
        toIntentAttribution(linkedIntent),
        decidedTargetDevices.get(updated.id) ?? null,
        decidedTargetRef?.orgId ?? null,
      ),
      ...(enforcementStatus ? { enforcementStatus } : {}),
      // #5601: present only when a genuine ceremony just minted one. The
      // client caches it and presents it on the next approve in this window
      // instead of prompting for another passkey scan.
      ...(mintedGrantId ? { stepUpGrantId: mintedGrantId } : {}),
    },
  };
}
