import { randomUUID, createHash } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { AssuranceLevel } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { actionIntents, intentOutbox, type ActionIntent, type ActionIntentSource, type ActionIntentStatus } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { organizationUsers } from '../../db/schema/users';
import { type AuthContext, dbAccessContextFromAuth } from '../../middleware/auth';
import { aiTools, resolveWritableToolOrgId } from '../aiTools';
import { checkGuardrails, type GuardrailCheck } from '../aiGuardrails';
import { getUserPermissions, userCanDecideApprovals } from '../permissions';
import { dispatchApprovalPushToTokens, getUserPushTokens } from '../expoPush';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { recordActionIntentEvent } from './metrics';

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
};

export interface ActionIntentTransitionPatch {
  decidedAt?: Date | null;
  decidedByUserId?: string | null;
  decidedAssuranceLevel?: AssuranceLevel | null;
  decidedVia?: string | null;
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

function toSnapshot(intent: ActionIntent, approvalRequestIds: string[]): ActionIntentSnapshot {
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
  };
}

// ---------------------------------------------------------------------------
// createActionIntent
// ---------------------------------------------------------------------------

interface CreationResult {
  intent: ActionIntent;
  approvalRequestIds: string[];
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

  const creation = await withDbAccessContext(dbContext, async (): Promise<CreationResult> => {
    const [inserted] = await db
      .insert(actionIntents)
      .values({
        orgId,
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
      .onConflictDoNothing({ target: [actionIntents.orgId, actionIntents.idempotencyKey] })
      .returning();

    if (!inserted) {
      // Idempotent replay: converge on the existing row instead of creating a
      // duplicate (spec §4 step 3 / §13). No new fan-out, no new outbox row —
      // the retry is a no-op beyond returning what already exists.
      const [existing] = await db
        .select()
        .from(actionIntents)
        .where(and(eq(actionIntents.orgId, orgId), eq(actionIntents.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (!existing) {
        throw new ActionIntentError(
          'Insert conflicted on (org_id, idempotency_key) but no existing row was found',
          'idempotency_race',
        );
      }
      const approvalRows = await db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, existing.id));
      return {
        intent: existing,
        approvalRequestIds: approvalRows.map((r) => r.id),
        fanOutUserIds: [],
        isNew: false,
      };
    }

    // Resolve eligible approvers: org members with approvals:decide, excluding
    // the requester (spec §4 step 4).
    const members = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(eq(organizationUsers.orgId, orgId));

    const eligibleApprovers: string[] = [];
    let requesterEligible = false;
    for (const member of members) {
      const perms = await getUserPermissions(member.userId, { orgId });
      if (!perms || !userCanDecideApprovals(perms)) continue;
      if (member.userId === requesterId) {
        requesterEligible = true;
        continue;
      }
      eligibleApprovers.push(member.userId);
    }

    let approvalRequestIds: string[] = [];
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

    return { intent: finalIntent, approvalRequestIds, fanOutUserIds, isNew: true };
  });

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

  return toSnapshot(creation.intent, creation.approvalRequestIds);
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
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intent.id));
    return toSnapshot(intent, approvalRows.map((r) => r.id));
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
): Promise<boolean> {
  const fromList = Array.isArray(from) ? from : [from];
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .update(actionIntents)
      .set({ status: to, ...patch })
      .where(and(eq(actionIntents.id, intentId), inArray(actionIntents.status, fromList)))
      .returning({ id: actionIntents.id });
    return rows.length > 0;
  });
}
