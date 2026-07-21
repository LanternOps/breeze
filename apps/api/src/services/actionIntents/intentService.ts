import { randomUUID, createHash } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AssuranceLevel } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { actionIntents, intentOutbox, type ActionIntent, type ActionIntentSource, type ActionIntentStatus } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { type AuthContext, dbAccessContextFromAuth } from '../../middleware/auth';
import { aiTools, resolveWritableToolOrgId } from '../aiTools';
import { checkGuardrails, type GuardrailCheck } from '../aiGuardrails';
import { getUserPermissions, userCanDecideApprovals } from '../permissions';
import { dispatchApprovalPushToTokens, getUserPushTokens } from '../expoPush';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { recordActionIntentEvent } from './metrics';
import { resolveIntentApprovers } from './intentApprovers';

/** Statuses the partial `action_intents_org_idem_uniq` index dedupes on
 * (IMPORTANT-4 — migration 2026-07-18-action-intents.sql). Kept as a single
 * source of truth for both the onConflictDoNothing target predicate and the
 * idempotent-replay re-select below, so the two can never drift apart. */
const LIVE_INTENT_STATUSES: readonly ActionIntentStatus[] = ['pending_approval', 'approved', 'executing'];

// Action intents & durable approval layer — core intent service (spec
// docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
// §4, §7). Creates a digest-bound intent, fans it out to eligible approvers,
// and provides the CAS primitive later tasks (decide handler, release worker,
// reaper) use to move it through its state machine.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ActionIntentError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ActionIntentError';
  }
}

/** Tier <=2 tools aren't an intent path at all; Tier 4 is refused outright. */
export class ActionIntentTierError extends ActionIntentError {
  constructor(message: string, code: 'tool_not_tier3' | 'tool_blocked', public tier?: number) {
    super(message, code);
    this.name = 'ActionIntentTierError';
  }
}

export class ActionIntentNotFoundError extends ActionIntentError {
  constructor(intentId: string) {
    super(`Action intent ${intentId} not found`, 'not_found');
    this.name = 'ActionIntentNotFoundError';
  }
}

export class ActionIntentAuthorizationError extends ActionIntentError {
  constructor(message: string) {
    super(message, 'forbidden');
    this.name = 'ActionIntentAuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Public types (Tasks 5-8 + Plan 2 depend on these exact shapes)
// ---------------------------------------------------------------------------

export interface CreateActionIntentInput {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  source: 'chat' | 'mcp_api';
  requestingClientLabel?: string;
  /** MCP callers pass this explicitly; derived deterministically for chat. */
  idempotencyKey?: string;
  /** Resolved via resolveWritableToolOrgId when absent. */
  orgId?: string;
}

export type ActionIntentSnapshot = {
  id: string;
  status: ActionIntentStatus;
  actionName: string;
  argumentDigest: string;
  source: ActionIntentSource;
  expiresAt: Date;
  result: unknown;
  errorCode: string | null;
  approvalRequestIds: string[];
  /**
   * The approval_requests row fanned out to the REQUESTER, when one exists —
   * i.e. the sole-operator branch (requester is the only eligible approver).
   * null on a multi-approver fan-out (spec §4: the requester is excluded) and
   * when there are no approvers. The web chat card uses this to offer an
   * inline L3 self-approve (WebAuthn) for exactly this row and no other.
   */
  requesterApprovalRequestId: string | null;
};

export interface ActionIntentTransitionPatch {
  decidedAt?: Date | null;
  decidedByUserId?: string | null;
  decidedAssuranceLevel?: AssuranceLevel | null;
  decidedVia?: string | null;
  executionStartedAt?: Date | null;
  executedAt?: Date | null;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Expiry defaults (spec §3.4): chat matches the existing 5-minute
// waitForApproval UX; mcp_api gets a day since there's no live session
// blocking on it. Constants, not env vars, per the design.
const CHAT_EXPIRY_MS = 5 * 60 * 1000;
const MCP_EXPIRY_MS = 24 * 60 * 60 * 1000;

const MAX_ARG_VALUE_LEN = 80;

// ---------------------------------------------------------------------------
// Summary / digest helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max = MAX_ARG_VALUE_LEN): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stringifyArgValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** target = tool name + top-level arg keys with values truncated to 80 chars (resolved decision). */
function buildTargetSummary(toolName: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return toolName;
  const parts = keys.map((key) => `${key}=${truncate(stringifyArgValue(input[key]))}`);
  return `${toolName}(${parts.join(', ')})`;
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : text).trim();
}

/** impact = first sentence of the tool description (or the guardrail description) — resolved decision. */
function buildImpactSummary(toolName: string, guardrail: GuardrailCheck): string {
  const definitionDescription = aiTools.get(toolName)?.definition.description;
  const description = definitionDescription || guardrail.description || `Execute ${toolName}`;
  return firstSentence(description);
}

function deriveIdempotencyKey(actorId: string, actionName: string, digest: string): string {
  return createHash('sha256').update(`${actorId}:${actionName}:${digest}`).digest('hex');
}

function computeExpiresAt(source: ActionIntentSource): Date {
  return new Date(Date.now() + (source === 'chat' ? CHAT_EXPIRY_MS : MCP_EXPIRY_MS));
}

function toSnapshot(
  intent: ActionIntent,
  approvalRequestIds: string[],
  requesterApprovalRequestId: string | null,
): ActionIntentSnapshot {
  return {
    id: intent.id,
    status: intent.status,
    actionName: intent.actionName,
    argumentDigest: intent.argumentDigest,
    source: intent.source,
    expiresAt: intent.expiresAt,
    result: intent.result,
    errorCode: intent.errorCode,
    approvalRequestIds,
    requesterApprovalRequestId,
  };
}

// ---------------------------------------------------------------------------
// createActionIntent
// ---------------------------------------------------------------------------

interface CreationResult {
  intent: ActionIntent;
  approvalRequestIds: string[];
  requesterApprovalRequestId: string | null;
  /** userIds that received a fanned-out approval row, in the same order as approvalRequestIds — used for the post-commit push fan-out. Empty on an idempotent replay. */
  fanOutUserIds: string[];
  isNew: boolean;
}

export async function createActionIntent(
  auth: AuthContext,
  input: CreateActionIntentInput,
): Promise<ActionIntentSnapshot> {
  const guardrail = checkGuardrails(input.toolName, input.input);
  if (!guardrail.allowed || guardrail.tier >= 4) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is not permitted on the action-intent path: ${guardrail.reason ?? 'blocked'}`,
      'tool_blocked',
      guardrail.tier,
    );
  }
  if (guardrail.tier <= 2) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is tier ${guardrail.tier}; action intents are for Tier-3 approval-required tools only`,
      'tool_not_tier3',
      guardrail.tier,
    );
  }

  const resolvedOrg = resolveWritableToolOrgId(auth, input.orgId);
  if (!resolvedOrg.orgId) {
    throw new ActionIntentError(resolvedOrg.error ?? 'Organization context required', 'org_resolution_failed');
  }
  const orgId = resolvedOrg.orgId;
  const requesterId = auth.user.id;

  const canonical = canonicalizeArguments(input.input);
  const argumentDigest = computeArgumentDigest(canonical);
  const idempotencyKey = input.idempotencyKey ?? deriveIdempotencyKey(requesterId, input.toolName, argumentDigest);
  const targetSummary = buildTargetSummary(input.toolName, input.input);
  const impactSummary = buildImpactSummary(input.toolName, guardrail);
  const expiresAt = computeExpiresAt(input.source);
  const requestingClientLabel = input.requestingClientLabel
    ?? (input.source === 'chat' ? 'Breeze AI' : 'MCP API client');
  // Tier → riskTier mapping mirrors aiAgentSdk.ts's mobile-approval bridge.
  // Tier is always 3 by the time we reach here (T4 refused, T<=2 rejected
  // above), but computed generically for forward-compat.
  const riskTier: 'medium' | 'high' | 'critical' =
    guardrail.tier >= 4 ? 'critical' : guardrail.tier >= 3 ? 'high' : 'medium';

  const dbContext: DbAccessContext = {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    userId: requesterId,
  };

  // Resolve eligible approvers (org + partner axis, filtered by
  // approvals:decide, excluding the requester — spec §4 step 4 / CRITICAL-2)
  // BEFORE opening the creation transaction below. resolveIntentApprovers
  // manages its own system-scoped context internally (it must: partner_users
  // is Shape-3 partner-axis RLS, invisible under the requester's org-scoped
  // context — the exact gap CRITICAL-2 exists to close), so resolving it here
  // avoids holding a pooled connection open across the round-trip (the #1105
  // connection-hold class — see apps/api/src/db/index.ts). On a genuine
  // idempotency conflict below, this resolved set is simply discarded —
  // cheap relative to the round-trip savings on the common (non-conflicting)
  // path.
  const eligibleAll = await resolveIntentApprovers(orgId);
  const eligibleApprovers = eligibleAll.filter((userId) => userId !== requesterId);
  const requesterEligible = eligibleAll.includes(requesterId);

  // ONE system-scoped transaction (durability): insert the intent row (or
  // detect an idempotent replay) AND, in the SAME transaction, fan out the
  // cross-user approval_requests and write the intent_created outbox row. The
  // child→parent FKs (approval_requests.intent_id, intent_outbox.intent_id →
  // action_intents.id) are satisfied within one transaction because a
  // transaction sees its own uncommitted parent row — so the historical
  // TX1(org)/TX2(system) split is gone. That split existed ONLY because the two
  // stages ran on separate pooled connections at different scopes (a genuinely
  // separate TX2 connection could not see TX1's uncommitted intent row, and
  // Postgres's FK check fails fast rather than waiting). Collapsing them means a
  // crash or fault anywhere between the insert and the outbox rolls the WHOLE
  // thing back: there is no longer a window where a committed pending_approval
  // intent is stranded with no approvers and no outbox row (the release worker
  // would never see it and no approver could ever decide it).
  //
  // Scope tradeoff (defense-in-depth): collapsing forces the intent INSERT out
  // of the caller's org-scoped RLS context and into system scope — you cannot
  // re-scope mid-transaction, and the approval_requests fan-out REQUIRES system
  // scope (Shape-6 user-scoped RLS: a row for an approver OTHER than the
  // requester denies with 42501 under the requester's org context; migration
  // 2026-05-16-approval-shape6-system-bypass.sql). This trades one layer of
  // defense-in-depth (org-access RLS re-checking the intent insert) for
  // atomicity. Mitigations: (a) app-layer authz (tier gating +
  // resolveWritableToolOrgId) is already complete above; (b) org_id comes from
  // the authenticated `auth`, never user input; (c) the release/decide paths
  // re-validate org access before anything executes; (d) intent_outbox and the
  // fan-out were already system-only, so the whole operation being
  // system-scoped is internally consistent. Cross-tenant READS remain denied —
  // RLS filters reads by org_id regardless of which scope inserted the row
  // (proven by createIntentAtomicity.integration.test.ts).
  let creation: CreationResult;
  try {
    creation = await withSystemDbAccessContext(async (): Promise<CreationResult> => {
      const [inserted] = await db
        .insert(actionIntents)
        .values({
          orgId,
          partnerId: auth.partnerId ?? null,
          requestedByUserId: requesterId,
          source: input.source,
          requestingClientLabel,
          actionName: input.toolName,
          arguments: input.input,
          argumentDigest,
          targetSummary,
          impactSummary,
          reason: input.reason ?? null,
          riskTier: guardrail.tier,
          idempotencyKey,
          correlationId: randomUUID(),
          expiresAt,
        })
        // IMPORTANT-4: action_intents_org_idem_uniq is now a PARTIAL unique
        // index (migration 2026-07-18-action-intents.sql) covering only LIVE
        // statuses — a terminal intent must not block a legitimate future
        // identical request. The conflict target's `where` must match the
        // index predicate exactly (LIVE_INTENT_STATUSES) or Postgres can't
        // infer which index to use and raises "no unique or exclusion
        // constraint matching the ON CONFLICT specification".
        .onConflictDoNothing({
          target: [actionIntents.orgId, actionIntents.idempotencyKey],
          where: inArray(actionIntents.status, LIVE_INTENT_STATUSES),
        })
        .returning();

      if (!inserted) {
        // Idempotent replay: converge on the existing LIVE row instead of
        // creating a duplicate (spec §4 step 3 / §13). No new fan-out, no new
        // outbox row — the retry is a no-op beyond returning what already
        // exists. The approver set resolved above is simply unused on this path.
        // Filtered to LIVE_INTENT_STATUSES (not just org_id+idempotency_key)
        // because IMPORTANT-4 means multiple rows can now share the same key —
        // at most one LIVE at a time (which is exactly what the conflict fired
        // against) plus any number of prior terminal ones; an unfiltered select
        // with no ORDER BY could nondeterministically return a stale terminal
        // row instead.
        const [existing] = await db
          .select()
          .from(actionIntents)
          .where(
            and(
              eq(actionIntents.orgId, orgId),
              eq(actionIntents.idempotencyKey, idempotencyKey),
              inArray(actionIntents.status, LIVE_INTENT_STATUSES),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new ActionIntentError(
            'Insert conflicted on (org_id, idempotency_key) but no existing live row was found',
            'idempotency_race',
          );
        }
        const approvalRows = await db
          .select({ id: approvalRequests.id, userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, existing.id));
        return {
          intent: existing,
          approvalRequestIds: approvalRows.map((r) => r.id),
          requesterApprovalRequestId:
            approvalRows.find((r) => r.userId === requesterId)?.id ?? null,
          fanOutUserIds: [],
          isNew: false,
        };
      }

      // New intent: fan out the cross-user approval_requests and write the
      // intent_created outbox row, all in this same transaction.
      let approvalRequestIds: string[] = [];
      let requesterApprovalRequestId: string | null = null;
      let fanOutUserIds: string[] = [];

      const approvalRowFor = (userId: string) => ({
        userId,
        requestingClientLabel,
        actionLabel: targetSummary,
        actionToolName: input.toolName,
        actionArguments: input.input,
        riskTier,
        riskSummary: impactSummary,
        status: 'pending' as const,
        expiresAt,
        intentId: inserted.id,
        boundArgumentDigest: argumentDigest,
        isRecursive: false,
      });

      if (eligibleApprovers.length > 0) {
        const rows = await db
          .insert(approvalRequests)
          .values(eligibleApprovers.map(approvalRowFor))
          .returning({ id: approvalRequests.id });
        approvalRequestIds = rows.map((r) => r.id);
        fanOutUserIds = eligibleApprovers;
      } else if (requesterEligible) {
        // Sole-operator branch: the only eligible approver is the requester.
        // Create one row carrying the digest; the assurance-level >= 3 gate is
        // enforced later, in the decide handler (Task 5), not here.
        const rows = await db
          .insert(approvalRequests)
          .values([approvalRowFor(requesterId)])
          .returning({ id: approvalRequests.id });
        if (rows[0]) {
          approvalRequestIds = [rows[0].id];
          requesterApprovalRequestId = rows[0].id;
          fanOutUserIds = [requesterId];
        }
      }

      let finalIntent: ActionIntent = inserted;
      if (approvalRequestIds.length === 0) {
        // No eligible approvers and the requester isn't one either — fail
        // closed: create then immediately cancel, visible in audit (spec §4
        // step 4 / §8).
        const [cancelled] = await db
          .update(actionIntents)
          .set({ status: 'cancelled', errorCode: 'no_eligible_approvers', decidedAt: new Date() })
          .where(eq(actionIntents.id, inserted.id))
          .returning();
        finalIntent = cancelled ?? {
          ...inserted,
          status: 'cancelled',
          errorCode: 'no_eligible_approvers',
        };
      }

      await db.insert(intentOutbox).values({
        intentId: inserted.id,
        eventType: 'intent_created',
        // Ids only, no argument content (spec §3.2).
        payload: { intentId: inserted.id, orgId },
      });

      return { intent: finalIntent, approvalRequestIds, requesterApprovalRequestId, fanOutUserIds, isNew: true };
    });
  } catch (err) {
    // One transaction ⇒ any throw already rolled the intent insert back with
    // the fan-out/outbox; there is no committed row to mark 'failed' (the
    // pre-collapse best-effort transitionIntent(...,'failed') is gone with the
    // split). Preserve a deliberate ActionIntentError (e.g. the idempotency_race
    // edge) verbatim so its distinct code survives; wrap anything else (a real
    // DB/RLS fault in the insert, fan-out, or outbox) as fanout_failed so the
    // caller (chat SDK / MCP) sees a real failure, never a false success.
    if (err instanceof ActionIntentError) throw err;
    console.error('[intentService] action intent creation transaction failed (rolled back):', err);
    throw new ActionIntentError(
      'Failed to create action intent (approval fan-out / outbox)',
      'fanout_failed',
    );
  }

  // A replay returns the existing snapshot without push/audit (both gated on
  // isNew below); the final `return toSnapshot(...)` covers it identically to
  // the new-intent path.

  // Best-effort push AFTER the creation transaction commits (#1105) — never
  // hold a DB transaction open across the push network round-trip. Token
  // reads happen inside a fresh context per approver; the sends happen after.
  if (creation.isNew && creation.intent.status === 'pending_approval') {
    for (let i = 0; i < creation.approvalRequestIds.length; i++) {
      const approvalId = creation.approvalRequestIds[i];
      const userId = creation.fanOutUserIds[i];
      if (!approvalId || !userId) continue;
      try {
        const tokens = await withDbAccessContext(dbContext, () => getUserPushTokens(userId));
        await dispatchApprovalPushToTokens(tokens, {
          approvalId,
          actionLabel: targetSummary,
          requestingClientLabel,
        });
      } catch (err) {
        console.error('[intentService] approval push dispatch failed', approvalId, err);
      }
    }
  }

  if (creation.isNew) {
    const cancelledForNoApprovers = creation.intent.status === 'cancelled';
    recordActionIntentEvent({
      orgId,
      intentId: creation.intent.id,
      actionName: input.toolName,
      argumentDigest,
      source: input.source,
      outcome: cancelledForNoApprovers ? 'cancelled' : 'created',
      actorId: requesterId,
      details: cancelledForNoApprovers
        ? { errorCode: creation.intent.errorCode ?? 'no_eligible_approvers' }
        : {
          approverCount: creation.approvalRequestIds.length,
          soleOperator: creation.fanOutUserIds.length === 1 && creation.fanOutUserIds[0] === requesterId,
        },
    });
  }

  return toSnapshot(creation.intent, creation.approvalRequestIds, creation.requesterApprovalRequestId);
}

// ---------------------------------------------------------------------------
// getActionIntent
// ---------------------------------------------------------------------------

export async function getActionIntent(auth: AuthContext, intentId: string): Promise<ActionIntentSnapshot | null> {
  const dbContext = dbAccessContextFromAuth(auth);
  return withDbAccessContext(dbContext, async () => {
    const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    if (!intent) return null;
    const approvalRows = await db
      .select({ id: approvalRequests.id, userId: approvalRequests.userId })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intent.id));
    // Caller-derived, matching the sibling derivation in the idempotent-replay
    // path (`r.userId === requesterId`). The field's contract is "the approval
    // row YOU may self-approve", so it must key on the caller — keying on
    // intent.requestedByUserId would hand an approver looking at somebody
    // else's intent a row id that is not theirs to decide.
    const callerId = auth.user.id;
    return toSnapshot(
      intent,
      approvalRows.map((r) => r.id),
      approvalRows.find((r) => r.userId === callerId)?.id ?? null,
    );
  });
}

// ---------------------------------------------------------------------------
// cancelActionIntent
// ---------------------------------------------------------------------------

export async function cancelActionIntent(
  auth: AuthContext,
  intentId: string,
): Promise<{ ok: boolean; status: ActionIntentStatus }> {
  const dbContext = dbAccessContextFromAuth(auth);
  const intent = await withDbAccessContext(dbContext, async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row ?? null;
  });
  if (!intent) {
    throw new ActionIntentNotFoundError(intentId);
  }

  // Requester-or-approver only (spec §6.2).
  const isRequester = intent.requestedByUserId === auth.user.id;
  let isApprover = false;
  if (!isRequester) {
    const perms = await getUserPermissions(auth.user.id, { orgId: intent.orgId });
    isApprover = !!perms && userCanDecideApprovals(perms);
  }
  if (!isRequester && !isApprover) {
    throw new ActionIntentAuthorizationError(`Not authorized to cancel action intent ${intentId}`);
  }

  const ok = await transitionIntent(intentId, ['pending_approval', 'approved'], 'cancelled');
  if (ok) {
    return { ok: true, status: 'cancelled' };
  }

  const current = await withDbAccessContext(dbContext, async () => {
    const [row] = await db.select({ status: actionIntents.status }).from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row?.status ?? intent.status;
  });
  return { ok: false, status: current };
}

// ---------------------------------------------------------------------------
// transitionIntent — the CAS primitive (spec §3.4)
// ---------------------------------------------------------------------------

/**
 * `UPDATE ... WHERE id = $1 AND status IN (...from)`. Zero rows affected
 * (lost race / already-terminal / wrong starting state) returns `false`,
 * never throws — callers re-read on a lost race. Runs under system scope so
 * it works regardless of the caller's ambient context (decide handler,
 * release worker, reaper); `withDbAccessContext` no-ops into an ALREADY
 * active caller context rather than re-scoping it, which is fine here since
 * `breeze_has_org_access` also authorizes system scope.
 */
export async function transitionIntent(
  intentId: string,
  from: ActionIntentStatus | ActionIntentStatus[],
  to: ActionIntentStatus,
  patch?: ActionIntentTransitionPatch,
  opts?: { requireNotExpired?: boolean },
): Promise<boolean> {
  const fromList = Array.isArray(from) ? from : [from];
  return withSystemDbAccessContext(async () => {
    // requireNotExpired folds the deadline into the CAS predicate so a release
    // claim is atomic with the intent still being live. Without it, an intent
    // approved just before expires_at could be claimed approved -> executing in
    // the window before the 30s expiry reaper terminalizes it, executing an
    // action whose authorization window has already closed. Uses the DB clock
    // (now()) rather than a JS timestamp so the comparison is against the same
    // clock that stamped expires_at.
    const conditions = [eq(actionIntents.id, intentId), inArray(actionIntents.status, fromList)];
    if (opts?.requireNotExpired) {
      conditions.push(sql`${actionIntents.expiresAt} > now()`);
    }
    const rows = await db
      .update(actionIntents)
      .set({ status: to, ...patch })
      .where(and(...conditions))
      .returning({ id: actionIntents.id });
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// waitForIntentDecision — chat SDK's blocking poll (spec §6.1)
// ---------------------------------------------------------------------------

/**
 * Mirrors `aiAgent.ts`'s `waitForApproval` poll/backoff loop (500ms initial
 * interval, ×1.5 backoff capped at 3s, abort-signal aware, system-scoped
 * reads) but polls `action_intents.status` instead of
 * `ai_tool_executions.status`, and returns the STATUS itself rather than a
 * boolean.
 *
 * Unlike `waitForApproval`, this function never writes anything — a timeout
 * simply returns the last-read status (almost always still
 * `pending_approval`) and leaves the intent row untouched. That is the whole
 * point of the durable design (spec §6.1): the caller (chat SDK) can give up
 * waiting without cancelling the intent, and an approver can still decide it
 * — and the release worker (`jobs/intentReleaseWorker.ts`) will execute it —
 * after this session has moved on or died.
 *
 * Returns as soon as the status leaves `pending_approval` (any of
 * approved/executing/completed/failed/rejected/expired/cancelled), so a
 * caller only needs to special-case `pending_approval` to detect "still
 * waiting" vs. "a decision (or a worker) already moved this."
 */
export async function waitForIntentDecision(
  intentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionIntentStatus> {
  const startTime = Date.now();
  let pollInterval = 500;
  let lastStatus: ActionIntentStatus = 'pending_approval';

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) return lastStatus;

    try {
      const [row] = await withSystemDbAccessContext(() =>
        db
          .select({ status: actionIntents.status })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId))
          .limit(1),
      );

      if (!row) return lastStatus;
      lastStatus = row.status;
      if (lastStatus !== 'pending_approval') return lastStatus;
    } catch (err) {
      console.error(`[intentService] waitForIntentDecision poll error for intent ${intentId}:`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 3000);
  }

  return lastStatus;
}
