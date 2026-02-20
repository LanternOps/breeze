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

import { db, withSystemDbAccessContext } from '../db';
import { aiSessions, aiMessages, aiToolExecutions, aiActionPlans, devices, deviceSessions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiPageContext, AiApprovalMode } from '@breeze/shared/types/ai';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { checkBudget, checkAiRateLimit, getRemainingBudgetUsd } from './aiCostTracker';
import { sanitizeUserMessage, sanitizePageContext } from './aiInputSanitizer';
import { getSession, buildSystemPrompt, waitForApproval } from './aiAgent';
import { TOOL_TIERS, type PreToolUseCallback, type PostToolUseCallback } from './aiAgentSdkTools';
import { writeAuditEvent, requestLikeFromSnapshot, type RequestLike } from './auditEvents';
import type { ActiveSession, AuditSnapshot } from './streamingSessionManager';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const MCP_PREFIX = 'mcp__breeze__';

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
        result: 'failure' as const,
        errorMessage: err instanceof Error ? err.message : 'Unknown sanitization error',
      });
    }
  }
  const systemPrompt = sanitizedPageContext
    ? buildSystemPrompt(auth, sanitizedPageContext)
    : (session.systemPrompt ?? buildSystemPrompt(auth));

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
 * makeHandler() in aiAgentSdkTools.ts — unlike canUseTool, it IS invoked
 * for in-process MCP server tools.
 */
export function createSessionPreToolUse(session: ActiveSession): PreToolUseCallback {
  return async (toolName, input) => {
    // Reject unknown tools (defense-in-depth — SDK whitelist should already filter)
    if (!TOOL_TIERS[toolName]) {
      return { allowed: false, error: `Unknown tool: ${toolName}` };
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
    // wrapped in withSystemDbAccessContext to set the correct PostgreSQL GUCs.
    if (guardrailCheck.tier >= 2) {
      // Determine effective approval mode (pause overrides to per_step)
      const effectiveMode: AiApprovalMode = session.isPaused ? 'per_step' : session.approvalMode;

      // Auto-approve mode: skip approval dialog, just create audit record
      if (effectiveMode === 'auto_approve') {
        try {
          await withSystemDbAccessContext(() =>
            db.insert(aiToolExecutions).values({
              sessionId: session.breezeSessionId,
              toolName,
              toolInput: input,
              status: 'executing',
            })
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to create auto-approve audit record:', toolName, err);
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
            await withSystemDbAccessContext(() =>
              db.insert(aiToolExecutions).values({
                sessionId: session.breezeSessionId,
                toolName,
                toolInput: input,
                status: 'executing',
              })
            );
          } catch (err) {
            console.error('[AI-SDK] Failed to create plan-step audit record:', toolName, err);
          }
          session.currentPlanStepIndex = match.stepIndex + 1;
          return { allowed: true };
        }
        // Deviation from plan — fall through to per-step approval
      }

      // Per-step approval flow (default behavior)
      let approvalExec: { id: string } | undefined;
      try {
        const [row] = await withSystemDbAccessContext(() =>
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
          const [[dev], sessions] = await withSystemDbAccessContext(() =>
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

      // Emit approval_required event via session event bus → UI shows Approve/Reject
      session.eventBus.publish({
        type: 'approval_required',
        executionId: approvalExec.id,
        toolName,
        input,
        description: guardrailCheck.description ?? `Execute ${toolName}`,
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
        await withSystemDbAccessContext(() =>
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
    const parsedOutput = safeParseJson(output);
    const sessionId = session.breezeSessionId;
    const orgId = session.auth.orgId ?? undefined;

    // 1. Save tool_result to aiMessages
    // NOTE: Runs in background processor (outside request DB context).
    // Wrap in withSystemDbAccessContext for RLS compliance.
    try {
      await withSystemDbAccessContext(() =>
        db.insert(aiMessages).values({
          sessionId,
          role: 'tool_result',
          toolName,
          toolOutput: parsedOutput,
          toolUseId: toolUseId ?? null,
        })
      );
    } catch (err) {
      console.error('[AI-SDK] Failed to save tool_result message:', err);
    }

    // 2. Create/update aiToolExecutions record
    const guardrailCheck = checkGuardrails(toolName, input);
    if (guardrailCheck.tier < 2) {
      try {
        await withSystemDbAccessContext(() =>
          db.insert(aiToolExecutions).values({
            sessionId,
            toolName,
            toolInput: input,
            toolOutput: parsedOutput,
            status: isError ? 'failed' : 'completed',
            errorMessage: isError ? (typeof parsedOutput.error === 'string' ? parsedOutput.error : output.slice(0, 1000)) : undefined,
            durationMs,
            completedAt: new Date(),
          })
        );
      } catch (err) {
        console.error('[AI-SDK] Failed to save tool execution record:', err);
      }
    } else {
      try {
        await withSystemDbAccessContext(() =>
          db.update(aiToolExecutions)
            .set({
              status: isError ? 'failed' : 'completed',
              toolOutput: parsedOutput,
              errorMessage: isError ? (typeof parsedOutput.error === 'string' ? parsedOutput.error : output.slice(0, 1000)) : undefined,
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
        console.error('[AI-SDK] Failed to update approval execution record:', err);
      }
    }

    // 3. Emit tool_result SSE event via session event bus
    session.eventBus.publish({
      type: 'tool_result',
      toolUseId: toolUseId ?? '',
      output: parsedOutput,
      isError,
    });

    // 4. Plan step tracking (action_plan and hybrid_plan modes)
    if (session.activePlanId) {
      const effectiveMode = session.isPaused ? 'per_step' : session.approvalMode;
      const planStepIdx = session.currentPlanStepIndex - 1; // currentPlanStepIndex was already incremented in preToolUse

      // Emit plan_step_complete event
      if (planStepIdx >= 0) {
        session.eventBus.publish({
          type: 'plan_step_complete',
          planId: session.activePlanId,
          stepIndex: planStepIdx,
          toolName,
          isError,
        });
      }

      // For hybrid_plan mode: emit screenshot if tool result contains imageBase64
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

      // Check if plan is fully executed
      if (session.currentPlanStepIndex >= session.approvedPlanSteps.size) {
        const planId = session.activePlanId;
        try {
          await withSystemDbAccessContext(() =>
            db.update(aiActionPlans)
              .set({ status: 'completed', completedAt: new Date() })
              .where(eq(aiActionPlans.id, planId))
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to mark plan as completed:', planId, err);
        }

        session.eventBus.publish({
          type: 'plan_complete',
          planId,
          status: 'completed',
        });

        // Clear session plan state
        session.activePlanId = null;
        session.approvedPlanSteps.clear();
        session.currentPlanStepIndex = 0;
      }
    }

    // 5. Write audit event
    if (session.auditSnapshot) {
      writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), {
        orgId,
        action: `ai.tool.${toolName}`,
        resourceType: 'ai_session',
        resourceId: sessionId,
        actorId: session.auth.user.id,
        actorEmail: session.auth.user.email,
        ...(isError ? { result: 'failure' as const, errorMessage: typeof parsedOutput.error === 'string' ? parsedOutput.error : output.slice(0, 500) } : {}),
        details: {
          sessionId,
          toolInput: input,
          durationMs,
          tier: guardrailCheck.tier,
          ...(guardrailCheck.tier >= 2 ? { approved: true } : {}),
        },
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

  // Match key identifiers if present in the plan step
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
    await withSystemDbAccessContext(() =>
      db.update(aiActionPlans)
        .set({ status: 'aborted', completedAt: new Date() })
        .where(eq(aiActionPlans.id, planId))
    );
  } catch (err) {
    console.error('[AI-SDK] Failed to abort plan in DB:', planId, err);
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
