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

import { db, withDbAccessContext } from '../db';
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
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from './expoPush';
import { loadSession, loadConnection } from './m365Helpers';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

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

      // Action plan / hybrid plan mode: check if tool matches an approved plan step
      if ((effectiveMode === 'action_plan' || effectiveMode === 'hybrid_plan') && session.activePlanId) {
        const match = matchPlanStep(session, toolName, input);
        if (match.matches) {
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
        // Deviation from plan — fall through to per-step approval
      }

      // Per-step approval flow (default behavior)
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
        return { allowed: false, error: 'Failed to create approval record' };
      }

      if (!approvalExec) {
        return { allowed: false, error: 'Failed to create approval record' };
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

      // Bridge to mobile-readable approval_requests row.
      // Mobile clients read from /api/v1/mobile/approvals/* (NEVER from
      // ai_tool_executions). The approve/deny route handlers resolve the
      // execution_id back to the SDK's waitForApproval() poll.
      //
      // Tier → riskTier mapping (documented in the spec):
      //   Tier 2 → 'medium' (auto-approve still mutates; per_step shows mobile)
      //   Tier 3 → 'high'   (destructive — execute_command, run_script, …)
      //   Tier 4 → 'critical' (blocked at guardrail layer; never reaches here)
      // We don't have a separate "destructive" tier today, so Tier 3 is the
      // ceiling that actually fires. Pick 'high' as the safe default for
      // anything unexpected.
      const description = guardrailCheck.description ?? `Execute ${toolName}`;
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
          const tokens = await withDbAccessContext(
            {
              scope: 'organization',
              orgId: session.orgId,
              accessibleOrgIds: [session.orgId],
              userId: session.auth.user.id,
            },
            () => getUserPushTokens(session.auth.user.id),
          );
          if (tokens.length > 0) {
            await sendExpoPush(
              tokens.map((to) => ({
                to,
                ...buildApprovalPush({
                  approvalId: approvalRequestId!,
                  actionLabel,
                  requestingClientLabel: 'Breeze AI',
                }),
              })),
            );
          }
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
        return { allowed: false, error: 'Tool execution was rejected or timed out' };
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

    return { allowed: true };
  };
}

// ============================================
// Session-scoped postToolUse factory
// ============================================

/**
 * Creates a postToolUse callback that reads auth/auditSnapshot from the active
 * session and publishes tool_result events to the session's event bus.
 */
export function createSessionPostToolUse(session: ActiveSession): PostToolUseCallback {
  return async (toolName, input, output, isError, durationMs) => {
    const toolUseId = session.toolUseIdQueue.shift();
    if (!toolUseId) {
      console.warn(`[AI-SDK] postToolUse: toolUseIdQueue empty for ${toolName} — tool_result will have no toolUseId`);
    }
    const safeOutput = compactToolResultForChat(toolName, output);
    const parsedOutput = safeParseJson(safeOutput);
    const sessionId = session.breezeSessionId;
    const orgId = session.auth.orgId ?? undefined;
    const guardrailCheck = checkGuardrails(toolName, input);

    // 1. Emit SSE events FIRST — these are synchronous and must not be blocked by DB writes.
    //    This ensures the UI always receives tool results even if persistence fails.
    session.eventBus.publish({
      type: 'tool_result',
      toolUseId: toolUseId ?? '',
      output: parsedOutput,
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
 * Check if the current tool call matches the next expected step in an approved plan.
 * Matches by toolName (exact) + key identifiers (deviceId, action). Allows
 * flexibility in other params since AI may refine based on prior step results.
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

  // Only compare when BOTH sides have the field — if AI omits a field the plan
  // specifies, still match.
  const keyFields = ['deviceId', 'action', 'scriptId', 'policyId'];
  for (const key of keyFields) {
    if (step.input[key] !== undefined && input[key] !== undefined) {
      if (step.input[key] !== input[key]) {
        return { matches: false, stepIndex: idx };
      }
    }
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
