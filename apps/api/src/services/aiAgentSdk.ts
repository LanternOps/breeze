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
import {
  assertNoPlaintextSecret,
  isSecretBearingTool,
  SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE,
  MAX_RESULT_BYTES as MAX_INLINE_RESULT_BYTES,
} from './actionIntents/secretBearingTools';
import { TEMP_PASSWORD_ENC_KEY } from './actionIntents/resultSecrets';
import { captureException } from './sentry';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

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

function stripMcpPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const separatorIndex = toolName.indexOf('__', 'mcp__'.length);
  return separatorIndex === -1 ? toolName : toolName.slice(separatorIndex + 2);
}

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

function isAllowedForSession(toolName: string, allowedTools: readonly string[]): boolean {
  const bareToolName = stripMcpPrefix(toolName);
  return allowedTools.some((allowedTool) => stripMcpPrefix(allowedTool) === bareToolName);
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
} | {
  ok: false;
  error: string;
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
    const budgetError = await checkBudget(orgId);
    if (budgetError) return { ok: false, error: budgetError };
  } catch (err) {
    console.error('[AI-SDK] Budget check failed:', err);
    return { ok: false, error: 'Unable to verify budget. Please try again.' };
  }

  if (session.status !== 'active') {
    return { ok: false, error: 'Session is not active' };
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

  return { ok: true, session, sanitizedContent, systemPrompt, maxBudgetUsd };
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
  return async (toolName, input) => {
    // Set only by the tier-3 branch below when it creates a durable intent;
    // carried on the terminal `return` so postToolUse can seal against the
    // right intent without relying solely on pendingIntentBySession.
    let createdIntentId: string | undefined;

    // Reject unknown tools (defense-in-depth — SDK whitelist should already filter)
    if (!TOOL_TIERS[toolName]) {
      return { allowed: false, error: `Unknown tool: ${toolName}` };
    }

    if (session.allowedTools && !isAllowedForSession(toolName, session.allowedTools)) {
      return { allowed: false, error: `Tool '${toolName}' is not allowed for this session` };
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
        // flipped the row, so this returns on the first poll).
        const approved = await waitForApproval(
          helperExec.id,
          300_000,
          session.abortController.signal,
        );
        if (!approved) {
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
        return { allowed: true };
      }

      // Determine effective approval mode (pause overrides to per_step)
      const effectiveMode: AiApprovalMode = session.isPaused ? 'per_step' : session.approvalMode;

      // Auto-approve mode only skips approval for Tier 2 tools. Tier 3+
      // tools still require an explicit per-step approval.
      if (effectiveMode === 'auto_approve' && guardrailCheck.tier === 2) {
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

          // Block until an approver decides, OR the chat wait window (still 300s
          // — matches the intent's own 5-minute chat expiry) elapses. Unlike the
          // old waitForApproval, this NEVER mutates the intent on timeout: giving
          // up here leaves it pending_approval so an approver can still decide it
          // — and the durable release worker (jobs/intentReleaseWorker.ts) will
          // execute it — after this session has moved on or died. This is the
          // new durable capability the design adds (spec §6.1).
          const decisionStatus = await waitForIntentDecision(
            intent.id,
            300_000,
            session.abortController.signal,
          );

          if (decisionStatus === 'pending_approval') {
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
            { requireNotExpired: true },
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
        const expiresAt = new Date(Date.now() + 300_000); // matches waitForApproval timeout

        let approvalRequestId: string | undefined;
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

        // Block until user clicks Approve/Reject or 5-min timeout
        const approved = await waitForApproval(
          approvalExec.id,
          300_000,
          session.abortController.signal,
        );

        if (!approved) {
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

    return { allowed: true, intentId: createdIntentId };
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
    const toolUseId = session.toolUseIdQueue.shift();
    if (!toolUseId) {
      console.warn(`[AI-SDK] postToolUse: toolUseIdQueue empty for ${toolName} — tool_result will have no toolUseId`);
    }
    const safeOutput = compactToolResultForChat(toolName, output);
    const parsedOutput = safeParseJson(safeOutput);
    const sessionId = session.breezeSessionId;
    const orgId = session.auth.orgId ?? undefined;
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
          ...(guardrailCheck.tier >= 2 ? { approved: true } : {}),
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
