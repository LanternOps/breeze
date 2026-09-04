/**
 * AI Agent Service (Claude Agent SDK)
 *
 * Provides:
 * - runPreFlightChecks(): validates rate limits, budget, session status, and
 *   sanitizes input before handing off to the streaming session manager
 * - createSessionPreToolUse(): session-scoped pre-execution guardrails callback
 * - createSessionPostToolUse(): session-scoped postToolUse callback factory
 * - safeParseJson(): utility for parsing tool output
 */

import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { aiSessions, aiMessages, aiToolExecutions, aiActionPlans, devices, deviceSessions, approvalRequests } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiPageContext, AiApprovalMode } from '@breeze/shared/types/ai';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { checkBudget, checkAiRateLimit, getRemainingBudgetUsd } from './aiCostTracker';
import { sanitizeUserMessage, sanitizePageContext } from './aiInputSanitizer';
import { getSession, buildSystemPrompt, waitForApproval } from './aiAgent';
import { TOOL_TIERS, type PreToolUseCallback, type PostToolUseCallback } from './aiAgentSdkTools';
import { isAllowedForSession, stripMcpPrefix } from './mcpToolNames';
import { writeAuditEvent, requestLikeFromSnapshot, type RequestLike } from './auditEvents';
import type { ActiveSession, AuditSnapshot } from './streamingSessionManager';
import { compactToolResultForChat } from './aiToolOutput';
import { dispatchApprovalPushToTokens, getUserPushTokens } from './expoPush';
import { decideHelperToolAction } from './pamToolActionGovernance';
import { loadSession, loadConnection } from './m365Helpers';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';
import { createActionIntent, waitForIntentDecision, transitionIntent } from './actionIntents/intentService';
import { revalidateApprovedIntentForRelease } from './actionIntents/revalidateRelease';
import { requiresDurableRelease } from './actionIntents/durableRelease';
import { computeEffectDigestForRelease, hasPinnedDigest } from './actionIntents/effectDigest';
import type { ToolExecutionContext } from './toolExecutionContext';
import {
  assertNoPlaintextSecret,
  isSecretBearingTool,
  SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE,
  MAX_RESULT_BYTES as MAX_INLINE_RESULT_BYTES,
} from './actionIntents/secretBearingTools';
import { TEMP_PASSWORD_ENC_KEY } from './actionIntents/resultSecrets';
import { captureException } from './sentry';
import { resolveLlmConfigForOrg, type UsableLlmConfig } from './llm/llmConfigResolver';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Total time a single assistant cycle (one assistant message's batch of tool
 * calls) may spend blocked on approval waits, SHARED across every approval
 * wait in that cycle (#3089). Matches the action-intent chat expiry (5 min).
 *
 * Why shared, not per-wait: the SDK executes sibling tool calls sequentially
 * inside the same turn, so two pending approvals used to stack their 5-minute
 * waits (10 min total) past the 6-minute turn timeout
 * (streamingSessionManager.SDK_TURN_TIMEOUT_MS). The turn timeout then fired
 * first, publishing error+done to the UI — and the model's eventual closing
 * message was published into a turn the client had already ended, so sessions
 * ended with raw approval-pending error rows and no closing assistant message.
 * With one shared budget, cumulative approval blocking per cycle is <= 5 min,
 * which always leaves the model headroom to conclude the turn gracefully.
 * A wait that gives up leaves its tier-3 intent pending_approval — an approver
 * can still decide it and the durable release worker executes it (spec §6.1).
 */
export const APPROVAL_WAIT_BUDGET_MS = 300_000;

/**
 * Begin an approval wait for this session's current assistant cycle.
 *
 * Returns the remaining shared budget as `timeoutMs` (0 when a sibling wait
 * already exhausted it — callers pass it straight to waitForApproval /
 * waitForIntentDecision, both of which return immediately on 0), plus a
 * combined AbortSignal that settles the wait when EITHER the session is torn
 * down OR settleApprovalWaits() fires (new user message / interrupt). Callers
 * MUST invoke `end()` (in a finally) so the in-flight counter stays accurate.
 *
 * The per-cycle state lives on ActiveSession and is reset by
 * StreamingSessionManager.startTurnTimeout() at each message_start — the same
 * point the 6-minute turn timeout resets — preserving the invariant that a
 * cycle's approval waits always end before the turn timeout fires.
 */
function beginApprovalWait(session: ActiveSession): {
  timeoutMs: number;
  signal: AbortSignal;
  end: () => void;
} {
  const now = Date.now();
  if (session.approvalWaitDeadline == null) {
    session.approvalWaitDeadline = now + APPROVAL_WAIT_BUDGET_MS;
  }
  const timeoutMs = Math.max(0, session.approvalWaitDeadline - now);
  if (!session.approvalWaitAbort) {
    session.approvalWaitAbort = new AbortController();
  }
  const signal = AbortSignal.any([
    session.abortController.signal,
    session.approvalWaitAbort.signal,
  ]);
  session.pendingApprovalWaits = (session.pendingApprovalWaits ?? 0) + 1;
  let ended = false;
  return {
    timeoutMs,
    signal,
    end: () => {
      if (ended) return;
      ended = true;
      session.pendingApprovalWaits = Math.max(0, (session.pendingApprovalWaits ?? 1) - 1);
    },
  };
}

/**
 * Settle every in-flight approval wait on this session so the current turn can
 * conclude (#3089). The blocked preToolUse calls return promptly with their
 * "approval still pending" tool error, the model gets to respond (and address
 * whatever prompted the settle), and any tier-3 intent stays pending_approval
 * for the durable release worker to execute once an approver decides.
 *
 * Also exhausts the cycle's remaining wait budget so a sibling tool call later
 * in the SAME cycle cannot immediately re-block the turn — the budget resets
 * at the next assistant cycle (startTurnTimeout).
 *
 * Returns false (and does nothing) when no approval wait is in flight — the
 * session is busy for some other reason and callers should fall back to their
 * existing behavior.
 */
export function settleApprovalWaits(session: ActiveSession): boolean {
  if ((session.pendingApprovalWaits ?? 0) === 0) return false;
  session.approvalWaitDeadline = Date.now();
  session.approvalWaitAbort?.abort();
  session.approvalWaitAbort = null;
  return true;
}

/**
 * Wait (bounded) for a session's current turn to conclude after
 * settleApprovalWaits(). Resolves true once the session leaves 'processing'
 * (the model emitted its closing message and the SDK published result/done);
 * false if it is still processing when the timeout elapses.
 */
export async function waitForTurnToSettle(session: ActiveSession, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (session.state !== 'processing') return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return session.state !== 'processing';
}

/**
 * How long the shared route helper below waits for a settled turn to conclude
 * (covers the model emitting its closing message) before giving up.
 *
 * KNOWN GAP (#1105-class, flagged in review): all four callers below run
 * inside the request's ambient withDbAccessContext transaction (set up by
 * authMiddleware / clientAiAuthMiddleware / helperAuth), and none of the four
 * routes is registered in middleware/selfManagedDbContextRoutes.ts. This wait
 * does no DB work itself, but it still pins that transaction's pooled
 * connection idle-in-transaction for its full duration — runOutsideDbContext
 * cannot release it (it only re-routes NEW queries to the pool; the
 * connection itself stays checked out by the outer `baseDb.transaction(...)`
 * callback until the whole handler returns). A client that keeps resending
 * a message while a session sits blocked on approval can hold one pooled
 * connection per in-flight request for up to this long — against the prod
 * 25-connection ceiling, that's a real amplification risk under the same
 * class this codebase already fixed for the OIDC/SFTP/notification-test
 * routes (see selfManagedDbContextRoutes.ts). The correct fix is the same
 * one: register these four routes as self-managed and have each wrap its own
 * DB calls in short-lived withDbAccessContext blocks around this wait — out
 * of scope for this change (touches auth/RLS context on four hot routes,
 * needs its own dedicated PR + tests). Kept intentionally short here as an
 * interim bound on the worst case; do not raise this back toward the
 * original 15s without doing that conversion first.
 */
export const TURN_SETTLE_WAIT_MS = 3_000;

export type BlockedTurnSettleResult =
  /** Waits were settled and the turn concluded — retry tryTransitionToProcessing. */
  | 'concluded'
  /** No approval wait was in flight — the session is busy doing real work. */
  | 'not_blocked_on_approvals'
  /** Waits were settled but the turn is still concluding — retry shortly. */
  | 'still_processing';

/**
 * Shared handler for every chat surface's concurrent-message 409 guard
 * (#3089): when tryTransitionToProcessing fails, call this to settle a turn
 * that is blocked only on approval waits and give it a moment to conclude, so
 * the assistant can answer the new message instead of going mute behind the
 * approval. Used by routes/ai.ts, routes/clientAi/sessions.ts,
 * routes/scriptAi.ts, and routes/helper/index.ts — keep them in sync through
 * this helper, not four hand-rolled copies.
 */
export async function settleBlockedTurnForNewMessage(
  session: ActiveSession,
  timeoutMs = TURN_SETTLE_WAIT_MS,
): Promise<BlockedTurnSettleResult> {
  if (!settleApprovalWaits(session)) return 'not_blocked_on_approvals';
  return (await waitForTurnToSettle(session, timeoutMs)) ? 'concluded' : 'still_processing';
}

/**
 * Tracks the action_intents.id an inline Tier-3 execution is running under,
 * so createSessionPostToolUse can CAS it `executing -> completed|failed` once
 * the tool actually finishes (see the coordination invariant in the T3 block
 * of createSessionPreToolUse below). Keyed by the ActiveSession object itself
 * rather than added as a field on the ActiveSession type — this keeps the
 * action-intents integration local to this module. At most one Tier-3 tool
 * is ever "executing" for a given session at a time (the same assumption
 * createSessionPostToolUse's existing sessionId+toolName+status='executing'
 * match already makes), so a single pending id per session is sufficient.
 * WeakMap so an evicted/closed session's entry is GC'd with it.
 */
const pendingIntentBySession = new WeakMap<ActiveSession, string>();

/**
 * How the most recent tier>=2 call for a session was authorized, so the
 * postToolUse audit event can record `approved` honestly — true only when a
 * human (or an explicit policy ceremony) decided THIS call — plus the concrete
 * path taken. Before #3130 the audit detail hard-coded `approved: true` for
 * every tier>=2 execution, which was already wrong for auto_approve-mode and
 * plan-free auto executions and would have become actively misleading once
 * read-only Tier-2 calls started auto-executing under per_step. Same
 * single-in-flight assumption (and WeakMap rationale) as
 * pendingIntentBySession above.
 */
type ApprovalMethod =
  | 'per_step_user' // human decided the lightweight Tier-2 approval card
  | 'action_intent' // durable Tier-3 four_eyes intent decided via the approvals surface
  | 'supervised_self' // Task 6: durable Tier-3 SUPERVISED intent self-decided by the requester (no external approver, no assertion — tier3-supervised-four-eyes split design §4.2)
  | 'pam' // helper session — PAM elevation policy/approver decision
  | 'plan_step' // pre-authorized step of a human-approved action plan
  | 'auto_approve_mode' // session runs auto_approve; Tier 2 executes unprompted
  | 'read_only_auto'; // #3130 read-only Tier-2 allowlist; auto-executes in any un-paused mode
const lastApprovalBySession = new WeakMap<ActiveSession, { toolName: string; method: ApprovalMethod }>();

// Methods that represent an explicit decision on this specific call (a human
// approver, or the PAM policy ceremony for helper sessions). Plan steps count:
// the user approved exactly this step (digest-matched) when approving the plan.
// `supervised_self` counts too — the requester explicitly decided this call,
// just without an external approver or assertion.
const DECIDED_APPROVAL_METHODS: ReadonlySet<ApprovalMethod> = new Set([
  'per_step_user',
  'action_intent',
  'supervised_self',
  'pam',
  'plan_step',
]);

/** Consume the recorded approval method for the audit event's details. */
function approvalAuditDetails(
  session: ActiveSession,
  toolName: string,
): { approved: boolean; approvalMethod: ApprovalMethod | 'unknown' } {
  const last = lastApprovalBySession.get(session);
  if (last?.toolName === toolName) {
    lastApprovalBySession.delete(session);
    return { approved: DECIDED_APPROVAL_METHODS.has(last.method), approvalMethod: last.method };
  }
  return { approved: false, approvalMethod: 'unknown' };
}

/**
 * Categorized `action_intents.error_code` for the inline (chat-session)
 * completion CAS below, matching the durable release worker's short-code
 * style (`tier_escalated`, `execution_lost`, `digest_mismatch`,
 * `actor_invalid`, `execution_error` — jobs/intentReleaseWorker.ts,
 * jobs/intentExpiryReaper.ts). `error_code` must stay a stable, bounded
 * vocabulary a dashboard can group on; the raw tool error text (unbounded,
 * free-form) goes in `result` instead, never in `error_code`.
 */
const INLINE_TOOL_EXECUTION_FAILED_ERROR_CODE = 'tool_execution_failed';

// SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE and MAX_RESULT_BYTES (aliased
// here as MAX_INLINE_RESULT_BYTES for readability at call sites below) are
// shared with the durable release worker via secretBearingTools.ts, rather
// than declared independently here, so the two paths cannot drift apart —
// see the doc comments at their declaration site.

/**
 * Human-readable verbs for the two M365 mutation tools that hit per-step
 * approval. The three read tools are tier 1 and never create an approval card,
 * so they are intentionally absent.
 */
const M365_VERB: Record<string, string> = {
  m365_reset_password: 'Reset M365 password for',
  m365_disable_user: 'Disable M365 sign-in for',
};

/**
 * Build an enriched approval-card risk summary for M365 mutation tools,
 * surfacing the customer tenant, target user, and the operator's reason.
 * Returns null for non-M365 tools or when no connection is available, so the
 * caller can fall back to the default guardrail description.
 */
export function buildM365RiskSummary(
  toolName: string,
  input: Record<string, unknown>,
  conn: Pick<DelegantM365ConnectionRow, 'customerDisplayName'> | null,
): string | null {
  const verb = M365_VERB[stripMcpPrefix(toolName)] ?? M365_VERB[toolName];
  if (!verb || !conn) return null;
  const user = String(input.userIdentifier ?? 'a user');
  const reason = input.reason ? ` Reason: ${String(input.reason)}.` : '';
  return `${verb} ${user} on ${conn.customerDisplayName}.${reason}`;
}

// ============================================
// Pre-flight checks
// ============================================

export type PreFlightResult = {
  ok: true;
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  sanitizedContent: string;
  systemPrompt: string;
  maxBudgetUsd: number | undefined;
  resolved: UsableLlmConfig;
} | {
  ok: false;
  error: string;
  status?: number;
};

/**
 * Validates rate limits, budget, session status, expiration, and sanitizes input.
 * Returns all values needed to proceed with message processing, or an error.
 */
export async function runPreFlightChecks(
  sessionId: string,
  content: string,
  auth: AuthContext,
  pageContext?: AiPageContext,
  requestContext?: RequestLike,
): Promise<PreFlightResult> {
  const session = await getSession(sessionId, auth);
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }
  const orgId = session.orgId;

  let resolved;
  try {
    resolved = await resolveLlmConfigForOrg(orgId);
  } catch (error) {
    captureException(error, undefined, { service: 'aiAgentSdk', orgId });
    return {
      ok: false,
      error: 'AI configuration could not be loaded. Try again.',
      status: 503,
    };
  }
  if (resolved.source === 'unavailable') {
    return { ok: false, error: 'ai_unavailable', status: 503 };
  }

  // Rate limits
  try {
    const rateLimitError = await checkAiRateLimit(auth.user.id, orgId);
    if (rateLimitError) return { ok: false, error: rateLimitError };
  } catch (err) {
    console.error('[AI-SDK] Rate limit check failed:', err);
    return { ok: false, error: 'Unable to verify rate limits. Please try again.' };
  }

  // Budget
  try {
    const budgetError = await checkBudget(
      orgId,
      resolved.source === 'partner' ? 'partner_key' : 'platform',
    );
    if (budgetError) return { ok: false, error: budgetError };
  } catch (err) {
    console.error('[AI-SDK] Budget check failed:', err);
    return { ok: false, error: 'Unable to verify budget. Please try again.' };
  }

  if (session.status !== 'active') {
    // 'expired' must read as expired to the caller: routes map on the word to
    // return 410, and a session retired eagerly by openaiSessionManager's
    // eviction reaches this branch BEFORE the age checks below would have
    // produced that wording lazily. Without this, the same terminal state
    // surfaced as 410 or 400 depending purely on which path got there first.
    return {
      ok: false,
      error:
        session.status === 'expired'
          ? 'Session has expired. Please start a new session.'
          : 'Session is not active',
    };
  }

  if (session.turnCount >= session.maxTurns) {
    return { ok: false, error: `Session turn limit reached (${session.maxTurns})` };
  }

  // Session expiration
  const now = Date.now();
  const sessionAge = now - new Date(session.createdAt).getTime();
  const idleTime = now - new Date(session.lastActivityAt).getTime();

  if (sessionAge > SESSION_MAX_AGE_MS) {
    await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active')));
    return { ok: false, error: 'Session has expired (24h max age). Please start a new session.' };
  }

  if (idleTime > SESSION_IDLE_TIMEOUT_MS) {
    await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active')));
    return { ok: false, error: 'Session has expired due to inactivity. Please start a new session.' };
  }

  // Sanitize input
  const { sanitized: sanitizedContent, flags: sanitizeFlags } = sanitizeUserMessage(content);
  if (sanitizeFlags.length > 0) {
    console.warn('[AI-SDK] Input sanitization flags:', sanitizeFlags, 'session:', sessionId);
    if (requestContext) {
      writeAuditEvent(requestContext, {
        orgId,
        action: 'ai.security.prompt_injection_detected',
        resourceType: 'ai_session',
        resourceId: sessionId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        initiatedBy: 'ai',
        details: {
          flags: sanitizeFlags,
          originalLength: content.length,
          sanitizedLength: sanitizedContent.length,
          sessionId,
        },
      });
    }
  }

  // Build system prompt
  let sanitizedPageContext: AiPageContext | undefined;
  try {
    sanitizedPageContext = pageContext ? sanitizePageContext(pageContext) : undefined;
  } catch (err) {
    console.error('[AI-SDK] Failed to sanitize page context:', err);
    sanitizedPageContext = undefined;
    if (requestContext) {
      writeAuditEvent(requestContext, {
        orgId,
        action: 'ai.security.page_context_sanitization_failed',
        resourceType: 'ai_session',
        resourceId: sessionId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        initiatedBy: 'ai',
        result: 'failure' as const,
        errorMessage: err instanceof Error ? err.message : 'Unknown sanitization error',
      });
    }
  }
  const systemPrompt = sanitizedPageContext
    ? await buildSystemPrompt(auth, sanitizedPageContext)
    : (session.systemPrompt ?? await buildSystemPrompt(auth));

  // Remaining budget
  let maxBudgetUsd: number | undefined;
  try {
    const remaining = await getRemainingBudgetUsd(orgId);
    if (remaining !== null) maxBudgetUsd = remaining;
  } catch (err) {
    console.error('[AI-SDK] Failed to get remaining budget:', err);
    return { ok: false, error: 'Unable to verify spending budget. Please try again later.' };
  }

  return { ok: true, session, sanitizedContent, systemPrompt, maxBudgetUsd, resolved };
}

// ============================================
// Session-scoped preToolUse factory
// ============================================

/**
 * Creates a PreToolUseCallback that enforces guardrails, RBAC, rate limits,
 * and the approval gate before MCP tool execution. This runs inside
 * makeHandler() in aiAgentSdkTools.ts and IS invoked for in-process MCP
 * server tools.
 */
export function createSessionPreToolUse(session: ActiveSession): PreToolUseCallback {
  return async (toolName, input, mcpToolName) => {
    // Set only by the tier-3 branch below when it creates a durable intent;
    // carried on the terminal `return` so postToolUse can seal against the
    // right intent without relying solely on pendingIntentBySession.
    let createdIntentId: string | undefined;

    // Material the inline RELEASE below resolved and verified against the
    // intent's pinned effect digest (#3409 PR4c-1). It rides the same terminal
    // `return` as `createdIntentId` — that return value is the ONLY channel
    // between this callback and aiAgentSdkTools.ts's makeHandler, which is
    // where the tool actually runs. Without it the handler re-reads the script
    // row and re-resolves the tenant variables the digest just verified,
    // reopening the check/use window the digest exists to close.
    let verifiedToolContext: ToolExecutionContext | undefined;

    // Reject unknown tools (defense-in-depth — SDK whitelist should already filter)
    if (!TOOL_TIERS[toolName]) {
      return { allowed: false, error: `Unknown tool: ${toolName}` };
    }

    // Allowlist check runs on the EXPOSED name, not the handler name. The two
    // coincide for every tool the `breeze` MCP server registers; script
    // builder's `execute_script_on_device` dispatches to the `run_script`
    // handler, and comparing THAT against an allowlist of
    // `mcp__script_builder__*` names denied every call before tier/approval
    // logic ran (#4883). Once this gate resolves, nothing further in this
    // function reads `exposedToolName` — the capability being gated is the
    // handler's, so tier, RBAC, rate limits, approval and audit all stay on
    // `toolName`.
    const exposedToolName = mcpToolName ?? toolName;
    if (session.allowedTools && !isAllowedForSession(exposedToolName, session.allowedTools)) {
      // The SDK is handed the SAME list as `allowedTools` on `query()`, so it
      // should never offer the model a tool this branch then refuses. Reaching
      // here means the two views disagree — a wiring bug, not a user-permission
      // outcome — and #4883 proves that failure is invisible without a signal:
      // it read as an ordinary tool refusal in chat for weeks while every
      // Script Builder test run was dead.
      const wiringError = new Error(
        `Session allowlist denied '${exposedToolName}' (handler '${toolName}') — `
        + 'the SDK exposed a tool the app-layer guard refuses',
      );
      console.error(`[AI-SDK] ${wiringError.message} (session ${session.breezeSessionId})`);
      // Detail rides in the message, not in tags: the Sentry scrubber's tag
      // allowlist silently voids tag keys it does not know.
      captureException(wiringError, undefined, { service: 'aiAgentSdk', orgId: session.orgId });
      return {
        allowed: false,
        error: `Tool '${stripMcpPrefix(exposedToolName)}' is not allowed for this session`,
      };
    }

    // Guardrails (tier check + action-based escalation)
    const guardrailCheck = checkGuardrails(toolName, input);

    if (!guardrailCheck.allowed) {
      return { allowed: false, error: guardrailCheck.reason ?? 'Blocked by guardrails' };
    }

    // RBAC permission check
    try {
      const permError = await checkToolPermission(toolName, input, session.auth);
      if (permError) {
        return { allowed: false, error: permError };
      }
    } catch (err) {
      console.error('[AI-SDK] Permission check failed for tool:', toolName, err);
      return { allowed: false, error: 'Unable to verify permissions. Please try again.' };
    }

    // Per-tool rate limit
    try {
      const rateLimitErr = await checkToolRateLimit(toolName, session.auth.user.id);
      if (rateLimitErr) {
        return { allowed: false, error: rateLimitErr };
      }
    } catch (err) {
      console.error('[AI-SDK] Tool rate limit check failed for:', toolName, err);
      return { allowed: false, error: 'Unable to verify rate limits. Please try again.' };
    }

    // Tier 2+: Requires user approval (mutating and destructive tools)
    // NOTE: This callback runs inside the background processor which operates
    // outside the request's AsyncLocalStorage DB context (via runOutsideDbContext).
    // All DB operations on RLS-protected tables (those with org_id) must be
    // wrapped in withDbAccessContext({scope:'organization', orgId: session.orgId, ...})
    // to set the correct PostgreSQL GUCs under RLS.
    if (guardrailCheck.tier >= 2) {
      // Helper sessions: PAM governs (Phase 1, security finding A). This
      // branch precedes the auto_approve/plan shortcuts on purpose — a
      // helper token must never self-relax the approval gate. The
      // approval_requests/mobile bridge is skipped: the synthetic helper
      // "user" id is a device id (no users-FK row, no mobile owner).
      // Approval happens via POST /pam/elevation-requests/:id/respond
      // (separate identity), which mirrors onto this execution row.
      if (session.auth.helperDeviceId) {
        const helperDeviceId = session.auth.helperDeviceId;
        let helperExec: { id: string } | undefined;
        try {
          const [row] = await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .insert(aiToolExecutions)
                .values({
                  sessionId: session.breezeSessionId,
                  toolName,
                  toolInput: input,
                  status: 'pending',
                })
                .returning()
          );
          helperExec = row;
        } catch (err) {
          console.error('[AI-SDK] Failed to create helper approval record:', toolName, err);
          return { allowed: false, error: 'Failed to create approval record' };
        }
        if (!helperExec) {
          return { allowed: false, error: 'Failed to create approval record' };
        }

        session.eventBus.publish({
          type: 'approval_required',
          executionId: helperExec.id,
          toolName,
          input,
          description: guardrailCheck.description ?? `Execute ${toolName}`,
          requiresAdminApproval: true,
        });

        const decision = await decideHelperToolAction({
          orgId: session.orgId,
          deviceId: helperDeviceId,
          executionId: helperExec.id,
          toolName: stripMcpPrefix(toolName),
          toolInput: input as Record<string, unknown>,
          riskTier: guardrailCheck.tier,
          subjectUsername: session.auth.user.name ?? 'helper',
        });

        if (decision === 'denied') {
          return { allowed: false, error: 'This action was denied by organization policy' };
        }

        // Block until PAM decides (an auto-approved elevation has already
        // flipped the row, so this returns on the first poll). Draws from the
        // same shared per-cycle approval-wait budget as the tier-2/tier-3
        // flows (#3089) so stacked helper approvals can't outlive the turn
        // timeout, and settleApprovalWaits can conclude a blocked helper turn.
        const helperApprovalWait = beginApprovalWait(session);
        let approved: boolean;
        try {
          approved = await waitForApproval(
            helperExec.id,
            helperApprovalWait.timeoutMs,
            helperApprovalWait.signal,
          );
        } finally {
          helperApprovalWait.end();
        }
        if (!approved) {
          // Mirrors the tier-2/tier-3 close-out below: on an early settle
          // (abort signal), waitForApproval returns WITHOUT marking the row,
          // so a later PAM decision (decideHelperToolAction/pamToolActionGovernance)
          // would otherwise CAS this still-'pending' row to 'approved' with
          // nothing left listening on it — a stranded approval that silently
          // never executes. Guarded on status='pending' so a genuine
          // reject/timeout (already marked) is a no-op.
          try {
            await withDbAccessContext(
              { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
              () =>
                db
                  .update(aiToolExecutions)
                  .set({ status: 'rejected', errorMessage: 'Approval wait ended before a decision was made' })
                  .where(and(
                    eq(aiToolExecutions.id, helperExec!.id),
                    eq(aiToolExecutions.status, 'pending'),
                  ))
            );
          } catch (err) {
            captureException(err instanceof Error ? err : new Error(String(err)));
            console.error('[AI-SDK] Failed to close out settled helper approval record:', helperExec.id, err);
          }
          return {
            allowed: false,
            error: 'Tool execution was rejected or timed out awaiting administrator approval',
          };
        }

        try {
          await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .update(aiToolExecutions)
                .set({ status: 'executing' })
                .where(eq(aiToolExecutions.id, helperExec!.id))
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to update helper approval to executing:', helperExec.id, err);
        }
        lastApprovalBySession.set(session, { toolName, method: 'pam' });
        return { allowed: true };
      }

      // Determine effective approval mode (pause overrides to per_step)
      const effectiveMode: AiApprovalMode = session.isPaused ? 'per_step' : session.approvalMode;

      // Auto-approve mode only skips approval for Tier 2 tools. Tier 3+
      // tools still require an explicit per-step approval.
      // Read-only Tier-2 calls (#3130 — the TIER2_READONLY_* allowlists in
      // aiGuardrails.ts) additionally skip the prompt outside of plan
      // execution: a verified read has nothing to confirm, and per-step
      // prompting per list call is the approval-fatigue scenario #3088
      // measured. Two carve-outs keep existing semantics intact:
      //   - Never on a paused session — pause is the user's hard brake, and
      //     the explicit !isPaused guard is what keeps it one
      //     (effectiveMode === 'auto_approve' already implies !isPaused).
      //   - Never while a plan is actively executing — taking this early
      //     return would skip matchPlanStep, so a read that IS the current
      //     plan step would leave currentPlanStepIndex un-advanced: the next
      //     real step then reads as a deviation, postToolUse mis-attributes
      //     its plan_step_complete SSE to the stale index, and a plan ending
      //     in a read never reaches plan_complete. Plan-matched reads
      //     auto-execute through the plan branch below anyway (tier < 3);
      //     an UNmatched read during a plan is a deviation and deliberately
      //     still prompts, same as before this change.
      const readOnlyAutoExec =
        guardrailCheck.readOnly === true &&
        !session.isPaused &&
        !(session.activePlanId && (effectiveMode === 'action_plan' || effectiveMode === 'hybrid_plan'));
      if (guardrailCheck.tier === 2 && (effectiveMode === 'auto_approve' || readOnlyAutoExec)) {
        try {
          await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db.insert(aiToolExecutions).values({
                sessionId: session.breezeSessionId,
                toolName,
                toolInput: input,
                status: 'executing',
              })
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to create auto-approve audit record:', toolName, err);
          return { allowed: false, error: 'Failed to create audit record. Please try again.' };
        }
        lastApprovalBySession.set(session, {
          toolName,
          method: effectiveMode === 'auto_approve' ? 'auto_approve_mode' : 'read_only_auto',
        });
        return { allowed: true };
      }

      // Action plan / hybrid plan mode: check if tool matches an approved plan step.
      // Tier-3 (effective, post-escalation) and secret-bearing tools never take
      // this shortcut — they must fall through to the tier-3 createActionIntent
      // branch below so the action has a durable, second-approver intent row.

      // Set when this call matches an approved plan step but declines the
      // shortcut (effective tier 3, or secret-bearing). The durable tier-3
      // approval branch below uses it to advance the plan index only once
      // the step is authorized, and to abort the plan on any non-executing
      // exit.
      let matchedPlanStepIndex: number | null = null;

      // Terminate a matched plan step that is NOT going to execute. The plan
      // must not continue past a step nobody authorized, and with the index
      // no longer advanced early there is nothing to unwind — this
      // exists purely to stop the plan. abortActivePlan swallows its own DB
      // error and still clears in-memory plan state, so the tool's result
      // must not depend on it succeeding.
      //
      // `appendIfAborted` (optional): text appended to `result.error` ONLY
      // when this call actually aborts a plan — never unconditionally. A
      // tier-3 call can reach every one of these exits with
      // `matchedPlanStepIndex === null` (a deviation from the plan, or a
      // paused session, which forces per_step and never sets it at all)
      // while `session.activePlanId` is still live — the message must not
      // claim the plan stopped when it did not, because `check.error` is
      // serialized straight into the tool result the model reads
      // (aiAgentSdkTools.ts).
      const failMatchedPlanStep = async <T extends { allowed: false; error: string }>(
        result: T,
        appendIfAborted?: string,
      ): Promise<T> => {
        if (matchedPlanStepIndex !== null && session.activePlanId) {
          await abortActivePlan(session);
          if (appendIfAborted) {
            return { ...result, error: `${result.error}${appendIfAborted}` };
          }
        }
        return result;
      };

      if ((effectiveMode === 'action_plan' || effectiveMode === 'hybrid_plan') && session.activePlanId) {
        const match = matchPlanStep(session, toolName, input);
        if (match.matches && guardrailCheck.tier < 3 && !isSecretBearingTool(toolName)) {
          // Emit plan_step_start event
          session.eventBus.publish({
            type: 'plan_step_start',
            planId: session.activePlanId,
            stepIndex: match.stepIndex,
            toolName,
          });
          try {
            await withDbAccessContext(
              { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
              () =>
                db.insert(aiToolExecutions).values({
                  sessionId: session.breezeSessionId,
                  toolName,
                  toolInput: input,
                  status: 'executing',
                })
            );
          } catch (err) {
            console.error('[AI-SDK] Failed to create plan-step audit record:', toolName, err);
            return { allowed: false, error: 'Failed to create audit record. Please try again.' };
          }
          session.currentPlanStepIndex = match.stepIndex + 1;
          lastApprovalBySession.set(session, { toolName, method: 'plan_step' });
          return { allowed: true };
        }
        if (match.matches) {
          // Matched an approved plan step but declined the shortcut: this
          // call's EFFECTIVE tier is 3 (statically or via action-escalation),
          // or it's a secret-bearing tool — either way it must go through the
          // durable action-intents approval below (second approver, digest
          // binding, immutable record) — the plan's own approval does not
          // cover tier 3.
          //
          // Deliberately do NOT advance session.currentPlanStepIndex here.
          // Advancing before the approval resolves is the defect this change
          // removes: at least eight exits below return allowed:false after
          // this point (denial, timeout, ledger failure, intent-creation
          // failure, lost release CAS, intent-row-vanished, revalidation
          // failure, thrown errors), and a stale index makes postToolUse
          // emit plan_step_complete for a step that never ran and can mark
          // the plan completed. The advance now happens at the authorize
          // point instead, in the durable tier-3 approval branch below.
          //
          // Also deliberately no plan_step_start / aiToolExecutions row here:
          // the tier-3 branch creates its own approval-record row and
          // approval_required event for this same physical call, and emits
          // plan_step_start once the step is actually authorized.
          matchedPlanStepIndex = match.stepIndex;
        }
        // No match at all — deviation from plan — fall through to per-step approval
      }

      // Per-step approval flow (default behavior). ONLY Tier 3 chat tools
      // route through the durable action-intents layer (spec
      // docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
      // §6.1) — createActionIntent throws ActionIntentTierError for anything
      // below tier 3 (services/actionIntents/intentService.ts), so Tier 2
      // under per_step keeps the legacy lightweight bridge below (regression
      // fix: a prior revision routed both tiers through createActionIntent,
      // which silently failed every Tier-2 per_step approval — reverted so
      // Tier 2 uses the lightweight bridge and only Tier 3 uses the durable
      // intents path).
      // ai_tool_executions is still created here as the execution-ledger row
      // the SSE approval_required event references and the inline-completion
      // path below (via createSessionPostToolUse) updates to completed/
      // failed — but for Tier 3 the actual approval binding (approver
      // fan-out + push) lives on the action_intents row createActionIntent
      // creates.
      let approvalExec: { id: string } | undefined;
      try {
        const [row] = await withDbAccessContext(
          { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
          () =>
            db
              .insert(aiToolExecutions)
              .values({
                sessionId: session.breezeSessionId,
                toolName,
                toolInput: input,
                status: 'pending',
              })
              .returning()
        );
        approvalExec = row;
      } catch (err) {
        console.error('[AI-SDK] Failed to create approval record:', toolName, err);
        return await failMatchedPlanStep({ allowed: false, error: 'Failed to create approval record' });
      }

      if (!approvalExec) {
        return await failMatchedPlanStep({ allowed: false, error: 'Failed to create approval record' });
      }

      // Look up device + active user sessions for the approval UI
      let deviceContext: {
        hostname: string;
        displayName?: string;
        status: string;
        lastSeenAt?: string;
        activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }>;
      } | undefined;
      const deviceId = input.deviceId as string | undefined;
      if (deviceId) {
        try {
          const [[dev], sessions] = await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              Promise.all([
                db.select({
                  hostname: devices.hostname,
                  displayName: devices.displayName,
                  status: devices.status,
                  lastSeenAt: devices.lastSeenAt,
                })
                .from(devices)
                .where(eq(devices.id, deviceId))
                .limit(1),
                db.select({
                  username: deviceSessions.username,
                  activityState: deviceSessions.activityState,
                  idleMinutes: deviceSessions.idleMinutes,
                  sessionType: deviceSessions.sessionType,
                })
                .from(deviceSessions)
                .where(and(eq(deviceSessions.deviceId, deviceId), eq(deviceSessions.isActive, true))),
              ])
          );
          if (dev) {
            deviceContext = {
              hostname: dev.hostname,
              displayName: dev.displayName ?? undefined,
              status: dev.status,
              lastSeenAt: dev.lastSeenAt?.toISOString(),
              activeSessions: sessions.length > 0
                ? sessions.map((s) => ({
                    username: s.username,
                    activityState: s.activityState ?? undefined,
                    idleMinutes: s.idleMinutes ?? undefined,
                    sessionType: s.sessionType,
                  }))
                : undefined,
            };
          }
        } catch (err) {
          console.error('[AI-SDK] Failed to look up device for approval context:', err);
        }
      }

      const description = guardrailCheck.description ?? `Execute ${toolName}`;

      if (guardrailCheck.tier >= 3) {
        // Hoisted above the try below (unlike `intent`, which stays
        // block-scoped inside it): several statements after the
        // approved -> executing CAS win (the system-context select,
        // revalidateApprovedIntentForRelease, the plan_step_start publish)
        // can still throw, and the catch below needs the intent id to
        // self-heal the row back to `failed` — `intent` itself would already
        // be out of scope by the time the catch runs.
        let wonIntentId: string | undefined;
        // Wrapped so an uncaught throw anywhere in this flow (e.g.
        // waitForIntentDecision, transitionIntent, the system-context
        // select, or revalidateApprovedIntentForRelease — none of which are
        // individually try/caught) still funnels through
        // failMatchedPlanStep instead of propagating straight out of
        // createSessionPreToolUse, where it would be converted to a generic
        // tool error further up the stack (aiAgentSdkTools.ts) WITHOUT ever
        // stopping a plan a matched step belonged to.
        try {
          // ---- Tier 3+: durable action-intents flow (spec §6.1) ----
          // For M365 mutation tools, enrich the approval card with the customer
          // tenant + target user + reason. Non-fatal: any DB hiccup falls back to
          // the default description rather than throwing into the approval path.
          let m365Summary: string | null = null;
          try {
            const sessRow = await loadSession(session.breezeSessionId);
            if (sessRow?.delegantM365ConnectionId) {
              const conn = await loadConnection(sessRow.delegantM365ConnectionId);
              m365Summary = buildM365RiskSummary(toolName, input as Record<string, unknown>, conn);
            }
          } catch { /* non-fatal: fall back to default description */ }
          const riskSummary = m365Summary ?? (description.length > 500 ? `${description.slice(0, 497)}...` : description);

          // Create the durable intent. This fans out to eligible org approvers
          // (or the sole-operator self-approval row), dispatches mobile push, and
          // writes the intent_created outbox row — all internally, in one
          // transaction (services/actionIntents/intentService.ts). Replaces the
          // old direct approval_requests insert + dispatchApprovalPushToTokens
          // call: createActionIntent is now the single place that does both.
          let intent: Awaited<ReturnType<typeof createActionIntent>>;
          try {
            intent = await createActionIntent(session.auth, {
              toolName,
              input: input as Record<string, unknown>,
              source: 'chat',
              reason: riskSummary,
              orgId: session.orgId,
            });
          } catch (err) {
            console.error('[AI-SDK] Failed to create action intent:', toolName, err);
            return await failMatchedPlanStep({ allowed: false, error: 'Failed to create approval record' });
          }

          // Stamp the intent link onto the ledger row so handleApproval (web
          // chat's POST /ai/sessions/:id/approve/:executionId route,
          // services/aiAgent.ts) can detect this is an intent-backed execution
          // and refuse to report a self-approval success for it (whole-branch
          // review CRITICAL-3) — the intents flow is a four-eyes model, decided
          // via the /approvals surface (mobile push or Approvals queue), never
          // this endpoint. Stamped before the SSE event below so the row is
          // already linked by the time the UI could possibly hit approve.
          try {
            await withDbAccessContext(
              { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
              () =>
                db
                  .update(aiToolExecutions)
                  .set({ intentId: intent.id })
                  .where(eq(aiToolExecutions.id, approvalExec!.id))
            );
          } catch (err) {
            console.error('[AI-SDK] Failed to stamp intent id onto execution:', approvalExec.id, err);
          }

          // Emit approval_required event via session event bus. `intentBacked:
          // true` always means the four-eyes waiting state UNLESS
          // selfApprovalRequestId is also set — in that case the sole-operator
          // branch applies and the card offers an inline WebAuthn self-approve
          // for that one row (an L3 proof satisfying, not bypassing, the decide
          // handler's gate).
          session.eventBus.publish({
            type: 'approval_required',
            executionId: approvalExec.id,
            approvalRequestId: intent.approvalRequestIds[0],
            // Set ONLY when the fan-out created a row for the requester (the
            // sole-operator branch) — the web card offers the inline L3
            // WebAuthn self-approve for exactly that row. In a multi-approver
            // org the requester holds no row and this stays undefined; the
            // card keeps its waiting state (four-eyes preserved).
            selfApprovalRequestId: intent.requesterApprovalRequestId ?? undefined,
            // The tier3-supervised-four-eyes split (Task 1's checkGuardrails):
            // 'supervised' means the card's self-approve button is the
            // requester's OWN authorization, no second approver needed;
            // 'four_eyes' preserves the pre-split waiting-for-someone-else
            // semantics even when selfApprovalRequestId also happens to be
            // set (the four_eyes sole-operator branch). The web card
            // (AiApprovalDialog) uses this to decide whether the self-approve
            // button is itself the whole decision or just this user's half of one.
            approvalScope: guardrailCheck.approvalScope,
            // The intent's real server-side deadline, so the self-approve card's
            // countdown reflects actual expiry (created_at + CHAT_EXPIRY_MS)
            // rather than a mount-relative client constant that can silently drift
            // from it.
            intentExpiresAt: intent.expiresAt.toISOString(),
            toolName,
            input,
            description,
            deviceContext,
            intentBacked: true,
          });

          // Block until an approver decides, OR the cycle's SHARED approval-wait
          // budget (up to 300s — matches the intent's own 5-minute chat expiry)
          // elapses, OR the wait is settled early (session teardown, a new user
          // message, or interrupt — see settleApprovalWaits, #3089). Unlike the
          // old waitForApproval, this NEVER mutates the intent on timeout: giving
          // up here leaves it pending_approval so an approver can still decide it
          // — and the durable release worker (jobs/intentReleaseWorker.ts) will
          // execute it — after this session has moved on or died. This is the
          // new durable capability the design adds (spec §6.1).
          const approvalWait = beginApprovalWait(session);
          let decisionStatus: Awaited<ReturnType<typeof waitForIntentDecision>>;
          try {
            decisionStatus = await waitForIntentDecision(
              intent.id,
              approvalWait.timeoutMs,
              approvalWait.signal,
            );
          } finally {
            approvalWait.end();
          }

          if (decisionStatus === 'pending_approval') {
            // KNOWN OBSERVABILITY GAP (four_eyes) — documented deliberately,
            // not an oversight, and NOT something to paper over with an ad-hoc
            // notification here.
            //
            // APPROVAL_WAIT_BUDGET_MS is 300s while a four_eyes CHAT intent
            // now lives for FOUR_EYES_CHAT_EXPIRY_MS (60 min) and an
            // `mcp_api` one for MCP_EXPIRY_MS (24 h) — see
            // services/actionIntents/intentService.ts. Timing out here and
            // having a second human decide later is therefore the NORMAL
            // four_eyes path, not an edge case.
            //
            // The requester is told "Approval still pending…" exactly once,
            // below. After that they are told nothing at all — not when the
            // intent is DENIED, not when it expires at its own deadline, and
            // not when the durable release worker fails it
            // (`content_changed` / `rbac_denied` / `session_required` /
            // `connection_unavailable` — jobs/intentReleaseWorker.ts).
            // `recordActionIntentEvent` (services/actionIntents/metrics.ts)
            // writes an audit row and a Prometheus counter only; the push
            // fan-out in `createActionIntent` targets APPROVERS at creation
            // time, never the requester at outcome time.
            //
            // The real fix is the web approvals inbox, which is Plan 2 and
            // explicitly out of scope for this PR. Until it lands, four_eyes
            // outcomes are unobservable to the requester once this turn ends.
            // Do not add a notification path here — it would become a second,
            // divergent source of truth the inbox then has to reconcile.
            //
            // The row can still READ `pending_approval` here even though the
            // intent's own deadline has already passed: `jobs/intentExpiryReaper.ts`
            // flips it to `expired` on a 30s sweep, and this wait's own local
            // timeout (above) is calibrated to ~the same duration as
            // `intent.expiresAt` — so giving up here routinely races the sweep
            // by up to ~30s. Trust wall-clock time against the intent's own
            // deadline instead of the possibly-stale DB read, so a genuinely
            // expired approval isn't reported as "still pending" (#3090): that
            // was false on both counts — not pending, and never going to
            // complete, since re-approving an expired intent does nothing.
            if (Date.now() >= intent.expiresAt.getTime()) {
              return await failMatchedPlanStep(
                {
                  allowed: false,
                  error:
                    'Approval request expired before a decision was made; the action was not executed. Re-issue the tool call if it is still needed.',
                },
                ' The plan has been stopped.',
              );
            }
            return await failMatchedPlanStep(
              {
                allowed: false,
                error: 'Approval still pending; this action will complete once approved.',
              },
              ' The plan has been stopped.',
            );
          }

          if (decisionStatus === 'rejected' || decisionStatus === 'cancelled' || decisionStatus === 'expired') {
            return await failMatchedPlanStep({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
          }

          // decisionStatus is one of approved/executing/completed/failed here.

          // BEFORE the CAS, not after: some tools must be released only by the
          // durable worker, because their safety guarantees live in the
          // headless/executor transport that this inline path does not use
          // (see DURABLE_RELEASE_ONLY_TOOLS). Winning the CAS here and then
          // discovering that would leave the intent claimed by a releaser that
          // must not run it, and the inline path cannot safely un-claim.
          if (requiresDurableRelease(toolName)) {
            return await failMatchedPlanStep({
              allowed: false,
              error: 'This action was approved and is being completed by the approval worker.',
            });
          }

          // COORDINATION INVARIANT (CRITICAL — prevents double execution): the
          // durable release worker also consumes the intent_approved outbox and
          // may already be executing (or have executed/failed) this same intent.
          // The `approved -> executing` CAS is the SINGLE mutual-exclusion point
          // between this session and the worker — whichever side wins it is the
          // only side allowed to run the tool. transitionIntent re-checks the
          // CURRENT status atomically, so it's correct to attempt it here
          // regardless of which terminal-ish status waitForIntentDecision
          // happened to observe (that read can be stale by the time we get here).
          const wonRelease = await transitionIntent(
            intent.id,
            'approved',
            'executing',
            // Stamp execution_started_at at the claim, symmetric with the durable
            // worker (jobs/intentReleaseWorker.ts) — so the stale-execution reaper
            // keys off a real execution-start time here too, not just the
            // decided_at COALESCE fallback.
            { executedAt: null, executionStartedAt: new Date() },
            { requireNotExpired: 'release' },
          );
          if (!wonRelease) {
            // Lost the race: the release worker (or a duplicate outbox delivery)
            // already claimed this intent for execution. Do NOT run the tool
            // inline — that would double-execute a real side effect. The worker
            // owns the ledger write and the intent's final result/error_code.
            return await failMatchedPlanStep({
              allowed: false,
              error: 'This action is already being completed by the approval worker; it will not run twice.',
            });
          }

          // Won the CAS: record the intent id so the outer catch can
          // self-heal `executing -> failed` if anything below throws before
          // the tool actually runs (see the `wonIntentId` declaration above).
          wonIntentId = intent.id;

          // Won the release: re-prove the requester's CURRENT authorization
          // before executing. The inline path runs the tool under the live
          // `session.auth` captured when the tool call began — which can be up to
          // 5 minutes stale by now — so it MUST run the same fail-closed
          // revalidation the durable worker does (actor still active + still has
          // access to intent.orgId, org still active, tier not escalated, RBAC
          // still held). Without this, winning the CAS was a silent bypass of
          // every durability check the worker enforces. We hold the intent in
          // `executing` (we won the CAS), so on any failure we CAS it straight to
          // `failed` with the same error_code the worker uses and refuse to run.
          const { intentRow, winningApproval } = await runOutsideDbContext(() =>
            withSystemDbAccessContext(async () => {
              const [row] = await db
                .select()
                .from(actionIntents)
                .where(eq(actionIntents.id, intent.id))
                .limit(1);
              const [approvalRow] = await db
                .select({ boundArgumentDigest: approvalRequests.boundArgumentDigest })
                .from(approvalRequests)
                .where(and(eq(approvalRequests.intentId, intent.id), eq(approvalRequests.status, 'approved')))
                .limit(1);
              return { intentRow: row ?? null, winningApproval: approvalRow ?? null };
            }),
          );

          if (!intentRow) {
            console.error(`[AI-SDK] intent ${intent.id} vanished after winning release CAS`);
            return await failMatchedPlanStep({ allowed: false, error: 'Approved action could not be revalidated for execution.' });
          }

          const revalidation = await revalidateApprovedIntentForRelease(intentRow, winningApproval);
          if (!revalidation.ok) {
            await transitionIntent(intent.id, 'executing', 'failed', { errorCode: revalidation.errorCode });
            console.error(
              `[AI-SDK] inline release revalidation failed for intent ${intent.id}: ${revalidation.errorCode}`,
            );
            return await failMatchedPlanStep({
              allowed: false,
              error: 'Authorization for this action could no longer be verified; it was not executed.',
            });
          }

          // Effect-digest revalidation (tier3-supervised-four-eyes design §4.1,
          // services/actionIntents/effectDigest.ts) — mirrors the durable release
          // worker's same-named check (jobs/intentReleaseWorker.ts) so the inline
          // chat-session release path closes the exact same TOCTOU gap: an
          // approver approves a REFERENCE ("run script <id>"), and the referenced
          // content can drift during the approval window while the intent's own
          // arguments/argumentDigest stay byte-identical. `intentRow.effectDigest`
          // is NULL only when the tool/action had no resolver at creation
          // (`not_applicable`) or a resolver existed but couldn't resolve the
          // target (`unresolved`) — approval scope plays no part: pinning is
          // scope-independent (changed 2026-08-06, see effectDigest.ts's
          // header), so a SUPERVISED intent whose tool has a resolver
          // (run_script is the flagship case) IS pinned and DOES run this
          // check, same as a four_eyes intent. It used to be skipped for
          // every supervised intent when pinning was gated on
          // `approvalScope === 'four_eyes'`; that gate is gone. Wrapped in
          // withSystemDbAccessContext (via runOutsideDbContext, same discipline as
          // the intentRow/winningApproval read above) because the resolver needs
          // to read the current target row, which the ambient request context may
          // not make visible.
          // `hasPinnedDigest` is the SHARED predicate with the durable worker
          // (jobs/intentReleaseWorker.ts). The two release paths previously
          // guarded this same invariant with DIFFERENT predicates — truthiness
          // here, `!== null` there — which diverged on `undefined` (a narrower
          // select shape): this path failed OPEN (skipped the check) while the
          // worker failed CLOSED (a recompute never equals `undefined`, so
          // every pinned release would have been content_changed). One
          // predicate, one behavior, in one place.
          if (hasPinnedDigest(intentRow)) {
            const recomputed = await runOutsideDbContext(() =>
              withSystemDbAccessContext(() =>
                computeEffectDigestForRelease(intentRow.actionName, intentRow.arguments, db),
              ),
            );
            if (recomputed.digest !== intentRow.effectDigest) {
              await transitionIntent(intent.id, 'executing', 'failed', {
                errorCode: 'content_changed',
              });
              console.error(
                `[AI-SDK] inline release effect-digest mismatch for intent ${intent.id}: content_changed`,
              );
              return await failMatchedPlanStep({
                allowed: false,
                error: 'The referenced content changed after approval; it was not executed.',
              });
            }
            // Digest matched, so the material the recompute resolved IS what
            // the approver approved — hand it to the handler rather than
            // letting it read the same rows again. Only reached on a match:
            // the mismatch branch above returns.
            verifiedToolContext = recomputed.context;
          }

          // Won the release: track the intent id so createSessionPostToolUse can
          // CAS it executing -> completed|failed once the inline tool call
          // actually finishes (see pendingIntentBySession above).
          pendingIntentBySession.set(session, intent.id);
          createdIntentId = intent.id;

          // The step is now genuinely authorized: the intent was approved, we
          // won the executing CAS, and the requester's authorization was
          // re-proved. Only now is it correct to record plan progress.
          // Advancing any earlier would mark a step complete that may never
          // run (see the plan block above).
          if (matchedPlanStepIndex !== null && session.activePlanId) {
            session.eventBus.publish({
              type: 'plan_step_start',
              planId: session.activePlanId,
              stepIndex: matchedPlanStepIndex,
              toolName,
            });
            session.currentPlanStepIndex = matchedPlanStepIndex + 1;
          }

          // Mark as executing
          try {
            await withDbAccessContext(
              { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
              () =>
                db
                  .update(aiToolExecutions)
                  .set({ status: 'executing' })
                  .where(eq(aiToolExecutions.id, approvalExec!.id))
            );
          } catch (err) {
            console.error('[AI-SDK] Failed to update approval status to executing:', approvalExec.id, err);
          }
        } catch (err) {
          console.error('[AI-SDK] Unexpected error in tier-3 durable-intent flow:', toolName, err);
          captureException(err instanceof Error ? err : new Error(String(err)));
          // Best-effort self-heal: if we already won the approved -> executing
          // CAS above, this row would otherwise be stuck at `executing` until
          // the stale-execution reaper sweeps it (20 min) — CAS it straight to
          // `failed`, mirroring the revalidation branch's pattern just above.
          // Wrapped in its own try/catch so a failure HERE cannot mask the
          // original error being handled.
          if (wonIntentId) {
            try {
              await transitionIntent(wonIntentId, 'executing', 'failed', { errorCode: 'execution_error' });
            } catch (transitionErr) {
              console.error(
                '[AI-SDK] Failed to CAS action intent to failed after unexpected tier-3 error:',
                wonIntentId,
                transitionErr,
              );
            }
          }
          return await failMatchedPlanStep({
            allowed: false,
            error: 'An unexpected error occurred while processing this action; it was not executed.',
          });
        }
      } else {
        // ---- Tier 2 under per_step: legacy lightweight approval bridge ----
        // Restored verbatim (behavior-for-behavior) from the pre-Task-8
        // revision (commit 84f879b2477846d8cda9dbe50ff0aea97b4e356) — this is
        // a per-step "approve each step" chat UX, NOT a durable, org-approver-
        // pool-backed intent. It must NOT call createActionIntent: that
        // throws ActionIntentTierError('tool_not_tier3') for anything below
        // Tier 3 (services/actionIntents/intentService.ts), which is exactly
        // the regression this restores. No entry goes into
        // pendingIntentBySession here, so the postToolUse completion-CAS
        // hook (keyed off that map) stays a no-op for this path.
        //
        // Bridge to mobile-readable approval_requests row.
        // Mobile clients read from /api/v1/mobile/approvals/* (NEVER from
        // ai_tool_executions). The approve/deny route handlers resolve the
        // execution_id back to the SDK's waitForApproval() poll.
        //
        // Tier → riskTier mapping (documented in the spec): Tier 2 → 'medium'.
        const riskTier: 'medium' | 'high' | 'critical' =
          guardrailCheck.tier >= 4 ? 'critical' : guardrailCheck.tier >= 3 ? 'high' : 'medium';
        const actionLabel = description;
        // For M365 mutation tools, enrich the approval card with the customer
        // tenant + target user + reason. Non-fatal: any DB hiccup falls back to
        // the default description rather than throwing into the approval path.
        let m365Summary: string | null = null;
        try {
          const sessRow = await loadSession(session.breezeSessionId);
          if (sessRow?.delegantM365ConnectionId) {
            const conn = await loadConnection(sessRow.delegantM365ConnectionId);
            m365Summary = buildM365RiskSummary(toolName, input as Record<string, unknown>, conn);
          }
        } catch { /* non-fatal: fall back to default description */ }
        const riskSummary = m365Summary ?? (description.length > 500 ? `${description.slice(0, 497)}...` : description);

        // Begin the (shared-budget) approval wait BEFORE the approval
        // ceremony: with zero budget left, this legacy bridge would
        // self-reject instantly (waitForApproval's poll loop never runs on a
        // 0 timeout), so creating the approval_requests row, dispatching the
        // mobile push, and rendering the UI card first would advertise an
        // approval that was already dead on arrival — and unlike tier 3
        // there is no durable worker on this path to honor a late Approve.
        // Close out the ledger row honestly and return instead (#3089).
        const approvalWait = beginApprovalWait(session);
        let approvalRequestId: string | undefined;
        let approved: boolean;
        try {
          if (approvalWait.timeoutMs <= 0) {
            try {
              await withDbAccessContext(
                { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                () =>
                  db
                    .update(aiToolExecutions)
                    .set({
                      status: 'rejected',
                      errorMessage: "Approval not requested — this turn's approval wait budget was already exhausted",
                    })
                    .where(and(
                      eq(aiToolExecutions.id, approvalExec!.id),
                      eq(aiToolExecutions.status, 'pending'),
                    ))
              );
            } catch (err) {
              captureException(err instanceof Error ? err : new Error(String(err)));
              console.error('[AI-SDK] Failed to close out zero-budget approval record:', approvalExec.id, err);
            }
            return await failMatchedPlanStep({
              allowed: false,
              error: 'This action needs approval, but the approval window for this turn has ended; it was not requested. The user can ask again in a new message.',
            });
          }

          // The mobile card's countdown reflects the wait that will actually
          // happen — the REMAINING shared budget, not a flat 5 minutes.
          const expiresAt = new Date(Date.now() + approvalWait.timeoutMs);

          try {
            const [approvalRow] = await withDbAccessContext(
              {
                scope: 'organization',
                orgId: session.orgId,
                accessibleOrgIds: [session.orgId],
                userId: session.auth.user.id,
              },
              () =>
                db
                  .insert(approvalRequests)
                  .values({
                    userId: session.auth.user.id,
                    executionId: approvalExec!.id,
                    requestingClientLabel: 'Breeze AI',
                    requestingMachineLabel: null,
                    actionLabel,
                    actionToolName: stripMcpPrefix(toolName),
                    actionArguments: input as Record<string, unknown>,
                    riskTier,
                    riskSummary,
                    status: 'pending',
                    // The chat session's originating OAuth client is not yet
                    // tracked on aiSessions; until that lands, the AI-agent
                    // path can't be a self-loop with the mobile push target.
                    // (deriveIsRecursive() with a null requestingClientId
                    // returns false — explicit here for documentation.)
                    isRecursive: false,
                    expiresAt,
                  })
                  .returning({ id: approvalRequests.id })
            );
            approvalRequestId = approvalRow?.id;
          } catch (err) {
            console.error('[AI-SDK] Failed to create mobile approval_request row:', err);
            // Non-fatal: SSE approval flow still works for in-app web UI even
            // without the mobile-readable row. The approve/deny handler simply
            // won't have an executionId to resolve back to.
          }

          // Best-effort push notification to the user's mobile device(s).
          if (approvalRequestId) {
            try {
              // Token read happens INSIDE the org DB context; the push network
              // sends run AFTER it closes so we never hold the transaction open
              // across the round-trip (#1105). dispatchApprovalPushToTokens fans
              // out across every provider (Expo relay + native APNs).
              const tokens = await withDbAccessContext(
                {
                  scope: 'organization',
                  orgId: session.orgId,
                  accessibleOrgIds: [session.orgId],
                  userId: session.auth.user.id,
                },
                () => getUserPushTokens(session.auth.user.id),
              );
              await dispatchApprovalPushToTokens(tokens, {
                approvalId: approvalRequestId,
                actionLabel,
                requestingClientLabel: 'Breeze AI',
              });
            } catch (err) {
              console.error('[AI-SDK] Failed to dispatch approval push notification:', err);
            }
          }

          // Emit approval_required event via session event bus → UI shows Approve/Reject
          session.eventBus.publish({
            type: 'approval_required',
            executionId: approvalExec.id,
            approvalRequestId,
            toolName,
            input,
            description,
            deviceContext,
          });

          // Block until user clicks Approve/Reject, the cycle's shared approval
          // wait budget (up to 5 min) elapses, or the wait is settled early
          // (session teardown / new user message / interrupt — #3089).
          approved = await waitForApproval(
            approvalExec.id,
            approvalWait.timeoutMs,
            approvalWait.signal,
          );
        } finally {
          approvalWait.end();
        }

        if (!approved) {
          // The wait may have been settled early (abort signal), in which case
          // waitForApproval returned WITHOUT marking the row — close it out so
          // a later Approve click can't flip it to a stranded 'approved' that
          // nothing will ever execute (this legacy bridge has no durable
          // release worker). Guarded on status='pending' so a genuine reject
          // (row already 'rejected') or timeout (waitForApproval already
          // marked it) is a no-op. The linked mobile approval_requests row is
          // CAS'd out of 'pending' too — the mobile decide handler
          // (routes/approvals.ts) only proceeds from 'pending', so this
          // closes the mobile Approve → stranded-'approved' race at the
          // source. Best-effort, but a failure here re-opens that race, so it
          // is captured to Sentry — and the tool error below must surface
          // regardless.
          try {
            await withDbAccessContext(
              // userId is REQUIRED here, not just orgId: approval_requests is
              // Shape-6 (user-id-scoped RLS — see routes/approvals.ts's
              // system-scope note), so without it breeze_current_user_id()
              // is NULL and the approvalRequests UPDATE below silently
              // matches zero rows under FORCE RLS — leaving the mobile card
              // 'pending' so a late mobile Approve can still race past
              // decideHandler's CAS after this ledger row has already closed.
              { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId], userId: session.auth.user.id },
              async () => {
                await db
                  .update(aiToolExecutions)
                  .set({ status: 'rejected', errorMessage: 'Approval wait ended before a decision was made' })
                  .where(and(
                    eq(aiToolExecutions.id, approvalExec!.id),
                    eq(aiToolExecutions.status, 'pending'),
                  ));
                if (approvalRequestId) {
                  await db
                    .update(approvalRequests)
                    .set({ status: 'expired' })
                    .where(and(
                      eq(approvalRequests.id, approvalRequestId),
                      eq(approvalRequests.status, 'pending'),
                    ));
                }
              }
            );
          } catch (err) {
            captureException(err instanceof Error ? err : new Error(String(err)));
            console.error('[AI-SDK] Failed to close out settled approval record:', approvalExec.id, err);
          }
          // Not reachable with a non-null matchedPlanStepIndex today (both
          // secret-bearing tools are statically tier 3, so the only way to
          // land in this tier<3 legacy branch with a matched-but-declined
          // plan step — a tier-2 secret-bearing tool — is dead code). Wrap
          // anyway: it costs nothing (failMatchedPlanStep no-ops when
          // matchedPlanStepIndex is null) and removes a latent trap that is
          // currently safe only by the coincidence of two other files'
          // static tier assignments.
          return await failMatchedPlanStep({ allowed: false, error: 'Tool execution was rejected or timed out' });
        }

        // Mark as executing
        try {
          await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .update(aiToolExecutions)
                .set({ status: 'executing' })
                .where(eq(aiToolExecutions.id, approvalExec!.id))
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to update approval status to executing:', approvalExec.id, err);
        }
      }
    }

    if (guardrailCheck.tier >= 2) {
      // Reaching here inside the tier>=2 block means the call was explicitly
      // decided: the durable tier-3 intent flow (approver via the approvals
      // surface, or the requester self-deciding a SUPERVISED intent — Task 6)
      // or the tier-2 lightweight card (user clicked Approve).
      lastApprovalBySession.set(session, {
        toolName,
        method:
          guardrailCheck.tier >= 3
            ? guardrailCheck.approvalScope === 'supervised'
              ? 'supervised_self'
              : 'action_intent'
            : 'per_step_user',
      });
    }
    return { allowed: true, intentId: createdIntentId, context: verifiedToolContext };
  };
}

// ============================================
// Session-scoped postToolUse factory
// ============================================

/**
 * Script-builder "apply" tools push their payload to the editor through the
 * SSE tool_result event (see createSessionPostToolUse). Keep in sync with
 * scriptBuilderTools.ts and the frontend scriptAiStore APPLY_TOOL_NAMES.
 */
const SCRIPT_APPLY_TOOL_NAMES = new Set(['apply_script_code', 'apply_script_metadata']);
function isScriptApplyTool(toolName: string): boolean {
  // Tool name may arrive bare or as "mcp__script_builder__apply_script_code".
  const bare = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  return SCRIPT_APPLY_TOOL_NAMES.has(bare);
}

/**
 * Creates a postToolUse callback that reads auth/auditSnapshot from the active
 * session and publishes tool_result events to the session's event bus.
 */
export function createSessionPostToolUse(session: ActiveSession): PostToolUseCallback {
  return async (toolName, input, output, isError, durationMs, sealed) => {
    // Count this tool call toward the turn's tool_execution_count rollup
    // (consumed by streamingSessionManager's `result` handler) regardless of
    // whether the DB writes below succeed — postToolUse only fires for a tool
    // that actually ran, which is the event the counter tracks.
    session.pendingTurnToolExecutionCount += 1;
    const toolUseId = session.toolUseIdQueue.shift();
    if (!toolUseId) {
      console.warn(`[AI-SDK] postToolUse: toolUseIdQueue empty for ${toolName} — tool_result will have no toolUseId`);
    } else {
      // Drop the paired name entry recorded at content_block_start — it exists
      // for the dropped-call fallback (#3094), which must not fire for a call
      // this postToolUse is handling.
      session.toolUseNames?.delete(toolUseId);
    }
    const safeOutput = compactToolResultForChat(toolName, output);
    const parsedOutput = safeParseJson(safeOutput);
    const sessionId = session.breezeSessionId;
    // Canonical session org (always set) — `auth.orgId` is null for partner-
    // scope logins, which left tool audit rows without an org attribution.
    const orgId = session.orgId;
    const guardrailCheck = checkGuardrails(toolName, input);

    // Script-builder "apply" tools deliver their payload (code / metadata) to
    // the editor via this SSE tool_result event, NOT the chat transcript.
    // compactToolResultForChat strips the script body for LLM-context/security
    // reasons (#568), which also emptied the event the editor reads — so the
    // assistant could no longer insert into the page. Re-attach the raw `input`
    // for the UI only; `parsedOutput` (persisted row + LLM content) stays
    // compacted. The editor reads these fields in scriptAiStore.
    const uiOutput =
      !isError && isScriptApplyTool(toolName) && input && typeof input === 'object'
        ? { ...(parsedOutput as Record<string, unknown>), ...(input as Record<string, unknown>) }
        : parsedOutput;

    // 1. Emit SSE events FIRST — these are synchronous and must not be blocked by DB writes.
    //    This ensures the UI always receives tool results even if persistence fails.
    session.eventBus.publish({
      type: 'tool_result',
      toolUseId: toolUseId ?? '',
      output: uiOutput,
      isError,
    });

    // 1b. Plan step SSE events (also synchronous, emit before DB writes)
    if (session.activePlanId) {
      const planStepIdx = session.currentPlanStepIndex - 1;
      if (planStepIdx >= 0) {
        session.eventBus.publish({
          type: 'plan_step_complete',
          planId: session.activePlanId,
          stepIndex: planStepIdx,
          toolName,
          isError,
        });
      }

      const effectiveMode = session.isPaused ? 'per_step' : session.approvalMode;
      if (effectiveMode === 'hybrid_plan' && planStepIdx >= 0) {
        if (parsedOutput.imageBase64 && typeof parsedOutput.imageBase64 === 'string') {
          session.eventBus.publish({
            type: 'plan_screenshot',
            planId: session.activePlanId,
            stepIndex: planStepIdx,
            imageBase64: parsedOutput.imageBase64 as string,
          });
        }
      }
    }

    // 2. Persist to DB — best-effort with individual error handling.
    //    If any write fails, we warn but don't block the conversation.
    let persistenceError = false;

    // 2a. Save tool_result to aiMessages
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () =>
          db.insert(aiMessages).values({
            sessionId,
            role: 'tool_result',
            toolName,
            toolOutput: parsedOutput,
            toolUseId: toolUseId ?? null,
          })
      );
    } catch (err) {
      persistenceError = true;
      console.error(`[AI-SDK] Failed to save tool_result message for ${toolName}:`, err instanceof Error ? err.message : err);
    }

    // 2b. Create/update aiToolExecutions record
    //
    // delegantToolCallId correlates this row to Delegant's own audit ledger.
    // Secret-bearing tools (m365_reset_password) no longer emit it inside
    // parsedOutput's JSON — the handler returns prose llmText and the id
    // travels in the sealed carrier's `meta` instead (sealToolSecrets folds
    // `meta` into `sealedResult`). Fall back to that sealed blob so the
    // column is still populated for those tools; parsedOutput.delegantToolCallId
    // remains the source of truth for every other tool that still emits it
    // as JSON.
    const delegantToolCallId =
      typeof parsedOutput.delegantToolCallId === 'string'
        ? parsedOutput.delegantToolCallId
        : (typeof sealed?.sealedResult.delegantToolCallId === 'string'
          ? sealed.sealedResult.delegantToolCallId
          : undefined);
    if (guardrailCheck.tier < 2) {
      try {
        await withDbAccessContext(
          { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
          () =>
            db.insert(aiToolExecutions).values({
              sessionId,
              toolName,
              toolInput: input,
              toolOutput: parsedOutput,
              status: isError ? 'failed' : 'completed',
              errorMessage: isError ? (typeof parsedOutput.error === 'string' ? parsedOutput.error : safeOutput.slice(0, 1000)) : undefined,
              delegantToolCallId,
              durationMs,
              completedAt: new Date(),
            })
        );
      } catch (err) {
        persistenceError = true;
        console.error(`[AI-SDK] Failed to save tool execution record for ${toolName}:`, err instanceof Error ? err.message : err);
      }
    } else {
      try {
        await withDbAccessContext(
          { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
          () =>
            db.update(aiToolExecutions)
              .set({
                status: isError ? 'failed' : 'completed',
                toolOutput: parsedOutput,
                errorMessage: isError ? (typeof parsedOutput.error === 'string' ? parsedOutput.error : safeOutput.slice(0, 1000)) : undefined,
                delegantToolCallId,
                durationMs,
                completedAt: new Date(),
              })
              .where(and(
                eq(aiToolExecutions.sessionId, sessionId),
                eq(aiToolExecutions.toolName, toolName),
                eq(aiToolExecutions.status, 'executing'),
              ))
        );
      } catch (err) {
        persistenceError = true;
        console.error(`[AI-SDK] Failed to update approval execution record for ${toolName}:`, err instanceof Error ? err.message : err);
      }

      // 2b-i. Complete the durable intent this inline execution won the
      // approved -> executing release CAS for (createSessionPreToolUse, T3
      // block). This is the "real completion hook" the design calls for
      // (spec §6.1): the intent must reflect ACTUAL completion, not just
      // authorization to run — CASing it to completed the moment inline
      // execution is authorized would be wrong, since the tool hasn't run
      // yet at that point. A lost CAS here just means a reaper or the worker
      // already terminalized the intent first; nothing more to do.
      const pendingIntentId = sealed?.intentId ?? pendingIntentBySession.get(session);
      if (pendingIntentId) {
        pendingIntentBySession.delete(session);
        // Secret-bearing tools (Task 1/5) hand back a `sealed` result whose
        // credential is already v3/AAD-sealed for action_intents.result — that
        // MUST be what gets persisted, never the plaintext-bearing parsedOutput
        // the model saw. Non-secret tier-3 tools have no `sealed` and keep
        // persisting parsedOutput as before.
        const intentResult: Record<string, unknown> = sealed
          ? sealed.sealedResult
          : (parsedOutput as Record<string, unknown>);

        // Parity with the worker's MAX_RESULT_BYTES re-check (spec §6.3):
        // ciphertext is larger than plaintext, so the cap must be applied
        // AFTER sealing. Mirrors intentReleaseWorker.ts's warn: dropping a
        // sealed credential for size reasons must leave a forensic trail —
        // the operator was already told "credential available for one-time
        // reveal" and this is the only copy of an irreversibly-reset
        // password, so silently discarding it with no signal is worse than
        // the truncation itself.
        let sizedResult: Record<string, unknown>;
        if (Buffer.byteLength(JSON.stringify(intentResult), 'utf8') > MAX_INLINE_RESULT_BYTES) {
          if (TEMP_PASSWORD_ENC_KEY in intentResult) {
            console.warn(`[AI-SDK] Dropping sealed credential for intent ${pendingIntentId} — result exceeded the size cap`);
          }
          sizedResult = { truncated: true };
        } else {
          sizedResult = intentResult;
        }

        // Post-condition guard (Task 1) on the value actually about to be
        // persisted. If it trips, a plaintext credential almost reached
        // action_intents.result — confidentiality is preserved either way
        // (we refuse to write it), but this must not be a silent abort:
        // mirror the durable worker's failOnPlaintextSecretGuard
        // (jobs/intentReleaseWorker.ts) — log, captureException, and CAS the
        // intent straight to failed with the SAME error_code the worker uses
        // (queryable together) and NO `result` field (the guarded value must
        // never reach the result column). Unlike the worker (which returns
        // immediately after), this function keeps going afterward so steps
        // 2c-2e below (session auto-flag, plan completion, audit event)
        // still run for this postToolUse call instead of being silently
        // skipped by an uncaught throw.
        let plaintextGuardTripped = false;
        try {
          assertNoPlaintextSecret(toolName, sizedResult);
        } catch (err) {
          console.error(
            `[AI-SDK] plaintext-secret guard tripped for intent ${pendingIntentId} — refusing to persist:`,
            err,
          );
          captureException(err instanceof Error ? err : new Error(String(err)));
          plaintextGuardTripped = true;
          try {
            await transitionIntent(pendingIntentId, 'executing', 'failed', {
              executedAt: new Date(),
              errorCode: SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE,
            });
          } catch (transitionErr) {
            console.error(
              `[AI-SDK] Failed to CAS action intent to failed after plaintext-secret guard for ${toolName}:`,
              pendingIntentId,
              transitionErr,
            );
          }
        }

        if (!plaintextGuardTripped) {
          try {
            await transitionIntent(pendingIntentId, 'executing', isError ? 'failed' : 'completed', {
              executedAt: new Date(),
              // error_code is always the stable short code (matches the
              // release worker's vocabulary); the raw tool error text is
              // unbounded free-form and belongs in `result`, not `error_code`.
              ...(isError
                ? { errorCode: INLINE_TOOL_EXECUTION_FAILED_ERROR_CODE, result: sizedResult }
                : { result: sizedResult }),
            });
          } catch (err) {
            console.error(`[AI-SDK] Failed to CAS action intent to ${isError ? 'failed' : 'completed'} for ${toolName}:`, pendingIntentId, err);
          }
        }
      }
    }

    // 2c. Auto-flag session on tool failure (first failure only)
    if (isError) {
      try {
        const errorMsg = (typeof parsedOutput.error === 'string'
          ? parsedOutput.error
          : safeOutput).slice(0, 500);
        await withDbAccessContext(
          { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
          () =>
            db.update(aiSessions)
              .set({
                flaggedAt: new Date(),
                flagReason: `Tool failed: ${toolName} — ${errorMsg}`,
              })
              .where(and(
                eq(aiSessions.id, sessionId),
                isNull(aiSessions.flaggedAt),
              ))
        );
      } catch (err) {
        console.error('[AI-SDK] Failed to auto-flag session:', sessionId, err instanceof Error ? err.message : err);
      }
    }

    // 2d. Plan completion DB update
    if (session.activePlanId && session.currentPlanStepIndex >= session.approvedPlanSteps.size) {
      const planId = session.activePlanId;
      try {
        await withDbAccessContext(
          { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
          () =>
            db.update(aiActionPlans)
              .set({ status: 'completed', completedAt: new Date() })
              .where(eq(aiActionPlans.id, planId))
        );
      } catch (err) {
        persistenceError = true;
        console.error('[AI-SDK] Failed to mark plan as completed:', planId, err instanceof Error ? err.message : err);
      }

      session.eventBus.publish({
        type: 'plan_complete',
        planId,
        status: 'completed',
      });

      session.activePlanId = null;
      session.approvedPlanSteps.clear();
      session.currentPlanStepIndex = 0;
    }

    // 2e. Write audit event (fire-and-forget, non-blocking)
    if (session.auditSnapshot) {
      writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), {
        orgId,
        action: `ai.tool.${toolName}`,
        resourceType: 'ai_session',
        resourceId: sessionId,
        actorId: session.auth.user.id,
        actorEmail: session.auth.user.email,
        initiatedBy: 'ai',
        ...(isError ? { result: 'failure' as const, errorMessage: typeof parsedOutput.error === 'string' ? parsedOutput.error : safeOutput.slice(0, 500) } : {}),
        details: {
          sessionId,
          toolInput: input,
          durationMs,
          tier: guardrailCheck.tier,
          // `approved` is true only when this specific call was explicitly
          // decided (human approver / PAM / an approved plan step);
          // `approvalMethod` records the concrete path. Auto-executions
          // (auto_approve mode, #3130 read-only Tier 2) report approved: false
          // — before #3130 this hard-coded `approved: true` for every
          // tier>=2 execution, which misrepresented auto-approved calls.
          ...(guardrailCheck.tier >= 2 ? approvalAuditDetails(session, toolName) : {}),
        },
      });
    }

    // 3. Warn UI if any DB persistence failed
    if (persistenceError) {
      session.eventBus.publish({
        type: 'warning',
        message: 'Some tool execution data may not have been saved.',
        context: `tool: ${toolName}`,
      });
    }
  };
}

// ============================================
// Plan Step Matching
// ============================================

/**
 * Canonical (stable-key-ordered) serialization used to deep-compare an approved
 * plan step's input against the input the model is about to execute. Object keys
 * are sorted so that key ordering / whitespace can't mask a real argument change.
 * Mirrors the `stableStringify` helper in `routes/agents/changes.ts`.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(String(value));
}

/**
 * Check if the current tool call matches the next expected step in an approved plan.
 *
 * SECURITY (TOCTOU / arg-tampering, fail-closed): the executing tool call must
 * match the approved step by toolName (exact) AND by a canonical deep-equality of
 * the FULL input object. A previous version only compared a hardcoded subset of
 * "key fields" and only when both sides defined them — that let a high-impact call
 * run under a stale approval after its arguments (target/command/scope, or any
 * field outside the subset) had been mutated, or by omitting a key field entirely.
 * Any divergence now returns `matches: false`, so the caller falls through to the
 * per-step approval flow and a fresh approval is required.
 */
function matchPlanStep(
  session: ActiveSession,
  toolName: string,
  input: Record<string, unknown>,
): { matches: boolean; stepIndex: number } {
  const idx = session.currentPlanStepIndex;
  const step = session.approvedPlanSteps.get(idx);

  if (!step) return { matches: false, stepIndex: idx };
  if (step.toolName !== toolName) return { matches: false, stepIndex: idx };

  // Require the executing arguments to match the approved step's arguments
  // exactly (canonical, key-order-independent deep equality). Any added,
  // removed, or changed field is a deviation that requires re-approval.
  if (canonicalStringify(step.input) !== canonicalStringify(input)) {
    return { matches: false, stepIndex: idx };
  }

  return { matches: true, stepIndex: idx };
}

// ============================================
// Plan Abort
// ============================================

/**
 * Abort the active plan for a session. Updates DB status to 'aborted',
 * emits plan_complete event, and clears session plan state.
 */
export async function abortActivePlan(session: ActiveSession): Promise<boolean> {
  const planId = session.activePlanId;
  if (!planId) return false;

  // Update DB
  try {
    await withDbAccessContext(
      { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
      () =>
        db.update(aiActionPlans)
          .set({ status: 'aborted', completedAt: new Date() })
          .where(eq(aiActionPlans.id, planId))
    );
  } catch (err) {
    console.error('[AI-SDK] Failed to abort plan in DB:', planId, err);
    captureException(err);
    // Still proceed with abort — safety takes priority over DB consistency
  }

  // Emit plan_complete event
  session.eventBus.publish({
    type: 'plan_complete',
    planId,
    status: 'aborted',
  });

  // Clear session plan state
  session.activePlanId = null;
  session.approvedPlanSteps.clear();
  session.currentPlanStepIndex = 0;

  return true;
}

// ============================================
// Utility
// ============================================

export function safeParseJson(str: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(str);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: str };
  }
}
