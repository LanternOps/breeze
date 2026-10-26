/**
 * Tool Catalog W04 (#5219) — enabling, disabling and pausing a flow.
 *
 * Enabling is the delegation decision (spec §6.5, plan Decisions 2, 3, 7, 10,
 * 12, 13): an interactive user whose access to the owner scope is
 * unrestricted publishes an immutable `flow_versions` row — the definition,
 * the per-step pins drift is measured against, and the rule-4 pre-approval
 * bindings — and names themself as the delegator. Runs pin that publication,
 * so later edits never change a run.
 *
 * Writes run in the CALLER's DB context (the request transaction), like
 * service.ts: RLS (`flows_isolation` / `flow_versions_isolation` FOR ALL)
 * decides which rows an UPDATE can target, and a partner-wide flow
 * additionally requires `canManagePartnerWidePolicies(auth)` — RLS alone
 * would let a selected-access partner user write it. The W03 helpers make
 * their own system reads (owner, slug shadow, owned references, script
 * material). `pauseFlow` and `assertDelegatorAuthority` are system paths for
 * the runner, reconciler and dispatch claim.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  FlowDetailDto,
  FlowDocumentV1,
  FlowEnableRequest,
  FlowPausedReason,
  FlowStatus,
  FlowValidationResult,
  PreApprovalEligibility,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { sqlTimestamptz } from '../../db/sqlValues';
import { actionIntents, flowRuns, flows, flowVersions, users, type FlowRow, type FlowVersionRow } from '../../db/schema';
import { isInteractiveUserSession, type AuthContext } from '../../middleware/auth';
import { checkToolPermissionForResolvedUser, resolveToolPermissionRequirements } from '../aiGuardrails';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import {
  FlowStepPinError,
  isFlowEventDeliveryDurable,
  literalGuardInput,
  stepPinsFor,
  validateFlowDocument,
  type FlowStepPin,
} from '../flowValidator';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { canAccessOrg, getUserPermissions, hasPermission, type UserPermissions } from '../permissions';
import { captureException } from '../sentry';
import { hasSiteCeiling } from '../siteCeilingAccess';
import { latestCronOccurrence } from '../aiAgents/sweepOccurrence';
import { tenantToolPermissionRequirement } from '../toolSources/guardrails';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { createNotification } from '../userNotifications';
import { assessPreApprovals, type FlowPreApprovalBinding } from './preApproval';
import { ownerForFlowRow } from './repository';
import { assertFlowSlugAvailable, lockFlowSlugsForPartner, toDetailDto } from './service';

export type EnableFlowResult =
  | { ok: true; flow: FlowDetailDto; publication: { id: string; publicationSeq: number; definitionVersion: number } }
  | { ok: false; error: 'invalid'; validation: FlowValidationResult }
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> }
  | { ok: false; error: 'pre_approval_not_eligible'; stepId: string; reason: Extract<PreApprovalEligibility, { eligible: false }>['reason'] }
  | {
      ok: false;
      error: 'flow_not_found' | 'version_conflict' | 'already_enabled' | 'event_dispatch_not_durable' | 'foreach_concurrency_not_available'
        | 'slug_unavailable' | 'interactive_session_required' | 'delegation_scope_restricted' | 'partner_wide_forbidden';
    };

export type DisableFlowResult =
  | { ok: true; cancelledRuns: number }
  | { ok: false; error: 'flow_not_found' | 'not_enabled' | 'partner_wide_forbidden' };

const ENABLEABLE_STATUSES: readonly FlowStatus[] = ['draft', 'disabled', 'paused'];
const LIVE_STATUSES: readonly FlowStatus[] = ['enabled', 'paused'];

// ── delegation ceiling (Decision 13) ───────────────────────────────────────

function permissionContextFor(owner: ToolOwnerRef): { partnerId: string; orgId: string | undefined; scope: 'organization' | 'partner' } {
  return { partnerId: owner.partnerId, orgId: owner.orgId ?? undefined, scope: owner.orgId ? 'organization' : 'partner' };
}

/**
 * The delegator's live access to the owner scope is unrestricted: a role in
 * that scope, no site allowlist (`[]` IS a ceiling), reach to the flow's org
 * (a partner user deselected from it no longer reaches it) and, for a
 * partner-wide flow, partner membership with all-orgs access. The flow
 * principal is org-wide; a restricted user must not mint one.
 */
function ceilingAllowsDelegation(perms: UserPermissions | null, owner: ToolOwnerRef): perms is UserPermissions {
  if (!perms) return false;
  if (perms.allowedSiteIds !== undefined) return false;
  if (owner.orgId) return canAccessOrg(perms, owner.orgId);
  return perms.scope === 'partner' && perms.orgAccess === 'all';
}

// ── rule 7 ─────────────────────────────────────────────────────────────────

/**
 * Rule 7: every permission a step of `doc` needs that `perms` lacks, listed
 * per step. Used for the delegator at enable and for the triggerer of a
 * manual run (runService.startManualRun) — the same rule for both.
 */
export function missingPermissionsFor(
  doc: FlowDocumentV1,
  pins: FlowStepPin[],
  perms: UserPermissions,
): Array<{ stepId: string; permission: string }> {
  const missing: Array<{ stepId: string; permission: string }> = [];
  const pinById = new Map(pins.map((p) => [p.stepId, p]));
  for (const step of doc.steps) {
    const pin = pinById.get(step.id);
    if (!pin || pin.source === 'builtin') continue;
    if (pin.source === 'tenant') {
      const req = tenantToolPermissionRequirement(pin.tier);
      if (!hasPermission(perms, req.resource, req.action)) missing.push({ stepId: step.id, permission: `${req.resource}.${req.action}` });
      continue;
    }
    const input = literalGuardInput(step.tool, step.input);
    const denial = checkToolPermissionForResolvedUser(step.tool, input, perms);
    if (!denial) continue;
    const resolution = resolveToolPermissionRequirements(step.tool, input);
    const unmet = resolution.ok
      ? resolution.requirements.filter((r) => !hasPermission(perms, r.resource, r.action)).map((r) => `${r.resource}.${r.action}`)
      : [];
    if (unmet.length === 0) missing.push({ stepId: step.id, permission: denial });
    for (const permission of unmet) missing.push({ stepId: step.id, permission });
  }
  return missing;
}

// ── audit / helpers ────────────────────────────────────────────────────────

function audit(
  action: 'flow.enable' | 'flow.disable' | 'flow.pause',
  row: Pick<FlowRow, 'id' | 'name' | 'orgId' | 'partnerId'>,
  actor: { id: string; email: string } | null,
  details: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      ...(actor ? { actorId: actor.id, actorEmail: actor.email } : { actorType: 'system' as const }),
      action,
      resourceType: 'flow',
      resourceId: row.id,
      resourceName: row.name,
      result: 'success',
      details,
    });
  } catch (err) {
    console.error('[flows] audit write failed', err);
    captureException(err, undefined,
      { ...(row.orgId ? { org_id: row.orgId } : {}), flow_id: row.id, flow_site: 'flows.audit' },
      { fingerprint: ['flow', 'flows.audit'] });
  }
}

/** Joins an ambient SYSTEM context; otherwise opens a fresh one outside whatever is held. */
function inSystemContext<T>(fn: () => Promise<T>, label: string): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** The occurrence a schedule trigger is on right now, so enabling never fires a past one (A9 compares against it). */
function currentOccurrenceKey(doc: FlowDocumentV1, now: Date): string | null {
  if (doc.trigger.type !== 'schedule') return null;
  return latestCronOccurrence(doc.trigger.cron, doc.trigger.timezone, now)?.key ?? null;
}

/** Same answer for "absent" and "an org token looking at a partner-wide row it can read but never write". */
function partnerWideReach(row: FlowRow, auth: AuthContext): 'ok' | 'not_found' | 'forbidden' {
  if (row.orgId) return 'ok';
  if (auth.scope !== 'partner' && auth.scope !== 'system') return 'not_found';
  return canManagePartnerWidePolicies(auth) ? 'ok' : 'forbidden';
}

// ── enable ─────────────────────────────────────────────────────────────────

/**
 * Publish the flow and make it live. Order (plan Task A6): interactive user
 * session; row visible and writable, expected version, enableable status;
 * partner-wide gate; delegation ceiling; zero validation errors; durable
 * event delivery; no concurrent for-each; rule 7 (every miss listed); rule 4
 * for each requested step; slug re-check under the partner lock; publication
 * insert and status flip. Every refusal returns before the first write.
 */
export async function enableFlow(auth: AuthContext, flowId: string, req: FlowEnableRequest): Promise<EnableFlowResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };

  // FOR UPDATE: serializes concurrent enables of one flow (publication_seq is
  // max + 1) and, under RLS, only matches a row the caller may UPDATE.
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).for('update').limit(1);
  if (!row) return { ok: false, error: 'flow_not_found' };
  const reach = partnerWideReach(row, auth);
  if (reach === 'not_found') return { ok: false, error: 'flow_not_found' };
  if (req.expectedVersion !== row.definitionVersion) return { ok: false, error: 'version_conflict' };
  if (row.status === 'enabled') return { ok: false, error: 'already_enabled' };
  if (!ENABLEABLE_STATUSES.includes(row.status)) return { ok: false, error: 'version_conflict' };
  if (reach === 'forbidden') return { ok: false, error: 'partner_wide_forbidden' };

  const owner = await ownerForFlowRow(row);
  if (!owner) return { ok: false, error: 'flow_not_found' };

  // Decision 13, on the LIVE membership (rule 7 below uses the same perms).
  // The token's own ceiling is checked too: it can only be narrower than the
  // membership it was issued from.
  const perms = await getUserPermissions(auth.user.id, permissionContextFor(owner));
  if (
    !ceilingAllowsDelegation(perms, owner)
    || hasSiteCeiling(auth)
    || (!owner.orgId && auth.partnerOrgAccess !== 'all')
  ) {
    return { ok: false, error: 'delegation_scope_restricted' };
  }

  const validated = await validateFlowDocument(row.definition, { owner });
  const { document, ...validation } = validated;
  if (!validation.valid || !document) return { ok: false, error: 'invalid', validation };

  if (document.trigger.type === 'event' && !isFlowEventDeliveryDurable()) return { ok: false, error: 'event_dispatch_not_durable' };
  if (document.steps.some((s) => (s.forEach?.concurrency ?? 1) > 1)) return { ok: false, error: 'foreach_concurrency_not_available' };

  let pins: FlowStepPin[];
  try {
    pins = await stepPinsFor(document, { owner });
  } catch (err) {
    // The catalog changed between the two reads (a tenant tool disabled a
    // moment ago): report it like validation would have.
    if (!(err instanceof FlowStepPinError)) throw err;
    return {
      ok: false,
      error: 'invalid',
      validation: {
        ...validation,
        valid: false,
        issues: [...validation.issues, { code: 'tool_not_found', severity: 'error', stepId: err.stepId, message: 'This step\'s tool is not available to the flow\'s owner.' }],
      },
    };
  }
  const missing = missingPermissionsFor(document, pins, perms);
  if (missing.length > 0) return { ok: false, error: 'permission_missing', missing };

  const requested = [...new Set(req.preApprovedStepIds ?? [])];
  const stepIds = new Set(document.steps.map((s) => s.id));
  const unknown = requested.filter((id) => !stepIds.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: 'invalid',
      validation: {
        ...validation,
        valid: false,
        issues: [
          ...validation.issues,
          ...unknown.map((stepId) => ({
            code: 'pre_approval_not_eligible' as const, severity: 'error' as const, stepId,
            message: `Step '${stepId}' is not in this flow.`,
          })),
        ],
      },
    };
  }
  const assessment = await assessPreApprovals(document, pins, owner, requested);
  const bindings: FlowPreApprovalBinding[] = [];
  for (const stepId of requested) {
    const e = assessment.eligibility[stepId];
    const binding = assessment.bindings[stepId];
    if (!e || !e.eligible || !binding) {
      return { ok: false, error: 'pre_approval_not_eligible', stepId, reason: e && !e.eligible ? e.reason : 'tool_not_supported' };
    }
    bindings.push(binding);
  }

  // The shadow rule may have changed since the draft was saved.
  await lockFlowSlugsForPartner(owner.partnerId);
  if (!(await assertFlowSlugAvailable(owner, row.slug, { excludeFlowId: flowId }))) return { ok: false, error: 'slug_unavailable' };

  const [maxRow] = await db
    .select({ max: sql<number | null>`max(${flowVersions.publicationSeq})` })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId));
  // Always a new row, even for unchanged content: delegator, pins and
  // bindings are part of a publication (Decision 2).
  const publicationSeq = Number(maxRow?.max ?? 0) + 1;
  const now = new Date();
  const effectiveTier = validation.effectiveTier ?? 3;

  // Flip first (CAS on what was read): a lost race writes nothing at all.
  const [updated] = await db
    .update(flows)
    .set({
      status: 'enabled',
      enabledPublicationSeq: publicationSeq,
      enabledByUserId: auth.user.id,
      enabledAt: now,
      pausedReason: null,
      scheduleLastOccurrenceKey: currentOccurrenceKey(document, now),
      updatedAt: now,
    })
    .where(and(
      eq(flows.id, flowId),
      eq(flows.definitionVersion, row.definitionVersion),
      inArray(flows.status, [...ENABLEABLE_STATUSES]),
    ))
    .returning();
  if (!updated) return { ok: false, error: 'version_conflict' };

  const [publication] = await db
    .insert(flowVersions)
    .values({
      flowId,
      orgId: row.orgId,
      partnerId: row.orgId ? null : row.partnerId,
      publicationSeq,
      definitionVersion: row.definitionVersion,
      definition: document as unknown as Record<string, unknown>,
      effectiveTier,
      stepPins: pins as unknown as Record<string, unknown>[],
      preApprovals: bindings as unknown as Record<string, unknown>[],
      enabledByUserId: auth.user.id,
    })
    .returning({ id: flowVersions.id, publicationSeq: flowVersions.publicationSeq, definitionVersion: flowVersions.definitionVersion });
  if (!publication) throw new Error('Failed to publish flow');

  audit('flow.enable', updated, auth.user, { publicationSeq, definitionVersion: row.definitionVersion, preApprovedStepIds: requested, effectiveTier });

  return {
    ok: true,
    flow: toDetailDto(updated, { preApprovalEligibility: assessment.eligibility, preApprovedStepIds: bindings.map((b) => b.stepId) }),
    publication: { id: publication.id, publicationSeq: publication.publicationSeq, definitionVersion: publication.definitionVersion },
  };
}

// ── disable ────────────────────────────────────────────────────────────────

/**
 * Stop the flow and its runs. Queued and waiting runs end `cancelled`
 * (`flow_disabled`) now; awaiting-approval runs get `cancel_requested_at`
 * and then their open intents are cancelled the way `cancelActionIntent`
 * cancels one (CAS `pending_approval|approved → cancelled` plus the
 * `intent_cancelled` outbox row, whose consumer wakes the run); running runs
 * get `cancel_requested_at` and stop at their next checkpoint. One
 * transaction, the caller's.
 */
export async function disableFlow(auth: AuthContext, flowId: string): Promise<DisableFlowResult> {
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!row) return { ok: false, error: 'flow_not_found' };
  const reach = partnerWideReach(row, auth);
  if (reach === 'not_found') return { ok: false, error: 'flow_not_found' };
  if (!LIVE_STATUSES.includes(row.status)) return { ok: false, error: 'not_enabled' };
  if (reach === 'forbidden') return { ok: false, error: 'partner_wide_forbidden' };

  const now = new Date();
  const [flipped] = await db
    .update(flows)
    .set({ status: 'disabled', enabledPublicationSeq: null, pausedReason: null, updatedAt: now })
    .where(and(eq(flows.id, flowId), inArray(flows.status, [...LIVE_STATUSES])))
    .returning({ id: flows.id });
  if (!flipped) return { ok: false, error: 'not_enabled' };

  const cancelled = await db
    .update(flowRuns)
    .set({
      status: 'cancelled',
      errorCode: 'flow_disabled',
      error: 'The flow was disabled.',
      finishedAt: now,
      wakeAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      cancelRequestedAt: now,
      updatedAt: now,
    })
    .where(and(eq(flowRuns.flowId, flowId), inArray(flowRuns.status, ['queued', 'waiting'])))
    .returning({ id: flowRuns.id });

  // cancel_requested_at FIRST, so the wake that the intent cancel triggers
  // finds the run already marked and ends it cancelled.
  const parked = await db
    .update(flowRuns)
    .set({ cancelRequestedAt: sql`COALESCE(${flowRuns.cancelRequestedAt}, ${sqlTimestamptz(now)})`, updatedAt: now })
    .where(and(eq(flowRuns.flowId, flowId), eq(flowRuns.status, 'awaiting_approval')))
    .returning({ id: flowRuns.id });

  const cancelledIntents = await cancelOpenFlowRunIntents(parked.map((r) => r.id));

  const running = await db
    .update(flowRuns)
    .set({ cancelRequestedAt: sql`COALESCE(${flowRuns.cancelRequestedAt}, ${sqlTimestamptz(now)})`, updatedAt: now })
    .where(and(eq(flowRuns.flowId, flowId), eq(flowRuns.status, 'running')))
    .returning({ id: flowRuns.id });

  audit('flow.disable', row, auth.user, {
    previousStatus: row.status,
    publicationSeq: row.enabledPublicationSeq,
    cancelledRuns: cancelled.length,
    cancelRequestedRuns: parked.length + running.length,
    cancelledIntents,
  });
  return { ok: true, cancelledRuns: cancelled.length };
}

// ── parked-run intent cancellation ─────────────────────────────────────────

/**
 * Cancel the open intents of parked runs the way `cancelActionIntent` cancels
 * one: CAS `pending_approval | approved → cancelled` plus the
 * `intent_cancelled` terminal outbox row, whose consumer wakes the run. The
 * caller sets `cancel_requested_at` on the runs FIRST (same transaction), so
 * the wake ends each run `cancelled`, never `drift`. Runs on the ambient
 * `db` — the caller's transaction (disableFlow, runService.cancelFlowRun).
 * Returns how many intents were cancelled.
 */
export async function cancelOpenFlowRunIntents(runIds: readonly string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  // Flow intents are never task-linked; the predicate keeps it that way, so
  // the aiOperator operation lock order never applies here.
  const intents = await db
    .update(actionIntents)
    .set({ status: 'cancelled' })
    .where(and(
      inArray(actionIntents.requestingFlowRunId, [...runIds]),
      inArray(actionIntents.status, ['pending_approval', 'approved']),
      isNull(actionIntents.taskId),
    ))
    .returning({ id: actionIntents.id, orgId: actionIntents.orgId, requestingFlowRunId: actionIntents.requestingFlowRunId });
  for (const intent of intents) {
    await publishIntentTerminalOutbox(
      db,
      { id: intent.id, orgId: intent.orgId, taskId: null, requestingFlowRunId: intent.requestingFlowRunId },
      'intent_cancelled',
    );
  }
  return intents.length;
}

// ── pause (system) ─────────────────────────────────────────────────────────

const PAUSE_REASON_TEXT: Readonly<Record<FlowPausedReason, string>> = {
  drift: 'a step no longer matches what was approved when the flow was enabled',
  binding_drift: 'a pre-approved script changed since the flow was enabled',
  delegator_inactive: 'the person who enabled it no longer has the access it delegates',
  org_merged: 'its organization was merged',
  event_dispatch_not_durable: 'this deployment no longer delivers events durably',
};

/**
 * System-set pause (drift, binding drift, inactive delegator, org merge,
 * non-durable events). Keeps `enabled_publication_seq` so a re-enable shows
 * what was live. Idempotent: only an `enabled` flow moves, so a second pause
 * neither overwrites the first reason nor notifies twice. The delegator gets
 * an in-app notification after commit (per-flow channels are W05).
 *
 * Joins an ambient system context; from any other context it commits in its
 * own transaction, so never call it while holding a lock on this flows row
 * outside system scope.
 */
export async function pauseFlow(
  flowId: string,
  reason: FlowPausedReason,
  opts: { expectedPublicationSeq?: number } = {},
): Promise<void> {
  await inSystemContext(async () => {
    // `expectedPublicationSeq` fences the pause to the publication the caller
    // judged (round-2 review): a run of an OLD publication — whose delegator
    // was demoted, whose tool drifted — must never pause a flow someone has
    // since re-enabled on a new publication. Without it, any enabled flow is
    // paused (the reconciler's flow-level pauses).
    const [row] = await db
      .update(flows)
      .set({ status: 'paused', pausedReason: reason, updatedAt: new Date() })
      .where(and(
        eq(flows.id, flowId),
        eq(flows.status, 'enabled'),
        ...(opts.expectedPublicationSeq !== undefined ? [eq(flows.enabledPublicationSeq, opts.expectedPublicationSeq)] : []),
      ))
      .returning();
    if (!row) return;
    audit('flow.pause', row, null, { reason, publicationSeq: row.enabledPublicationSeq });

    const delegator = row.enabledByUserId;
    if (!delegator) return;
    runAfterDbContextCommit('flows.pauseFlow.notify', async () => {
      try {
        // Cross-user insert: needs its own system context (see createNotification).
        await runOutsideDbContext(() => withSystemDbAccessContext(() => createNotification({
          userId: delegator,
          orgId: row.orgId,
          type: 'automation',
          priority: 'high',
          title: 'Flow paused',
          message: `${row.name} was paused because ${PAUSE_REASON_TEXT[reason]}. Review it and enable it again.`,
          link: `/flows/${row.id}`,
          metadata: { flowId: row.id, reason },
          dedupeKey: `flow-paused:${row.id}:${row.enabledPublicationSeq ?? 0}:${reason}`,
        }), 'flows.pauseFlow.notify'));
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)), undefined,
          { ...(row.orgId ? { org_id: row.orgId } : {}), flow_id: row.id, flow_site: 'flows.pauseFlow.notify' },
          { fingerprint: ['flow', 'flows.pauseFlow.notify'] });
        console.error(`[flows] pause notification failed (flow=${row.id})`, err);
      }
    });
  }, 'flows.pauseFlow');
}

// ── delegator authority (system, run time) ─────────────────────────────────

/**
 * Decisions 7 + 13 at run time, at every slice start (resume included) and in
 * the approval dispatch claim: the publication's delegator still exists, is
 * active, holds a role in the owner scope, carries no site ceiling, still
 * reaches the flow's org, and — for a partner-wide flow — still has
 * all-orgs partner access. False ⇒ the caller pauses the flow
 * `delegator_inactive`.
 *
 * Rule 7 is re-applied too (review finding 6): the delegator must STILL hold
 * every permission the publication's steps need (`missingPermissionsFor`, the
 * enable-time check). A delegator demoted after enabling — still active and
 * unrestricted, but no longer holding, say, `scripts.execute` — would
 * otherwise keep delegating authority they no longer have. `rule7` is the
 * caller's PARSED publication (definition + pins): jsonb that decides
 * unattended work is parsed by the caller, never trusted here.
 */
export async function assertDelegatorAuthority(
  publication: Pick<FlowVersionRow, 'enabledByUserId'>,
  owner: ToolOwnerRef,
  rule7: { doc: FlowDocumentV1; pins: readonly FlowStepPin[] },
): Promise<boolean> {
  const userId = publication.enabledByUserId;
  if (!userId) return false;
  const [user] = await inSystemContext(
    async () => db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1),
    'flows.assertDelegatorAuthority',
  );
  if (user?.status !== 'active') return false;
  const perms = await getUserPermissions(userId, permissionContextFor(owner));
  if (!ceilingAllowsDelegation(perms, owner)) return false;
  return missingPermissionsFor(rule7.doc, [...rule7.pins], perms).length === 0;
}
