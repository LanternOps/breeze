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

import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiPageContext } from '@breeze/shared/types/ai';
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

    // Tier 3: Requires user approval
    if (guardrailCheck.requiresApproval) {
      let approvalExec: { id: string } | undefined;
      try {
        const [row] = await db
          .insert(aiToolExecutions)
          .values({
            sessionId: session.breezeSessionId,
            toolName,
            toolInput: input,
            status: 'pending',
          })
          .returning();
        approvalExec = row;
      } catch (err) {
        console.error('[AI-SDK] Failed to create approval record:', toolName, err);
        return { allowed: false, error: 'Failed to create approval record' };
      }

      if (!approvalExec) {
        return { allowed: false, error: 'Failed to create approval record' };
      }

      // Emit approval_required event via session event bus → UI shows Approve/Reject
      session.eventBus.publish({
        type: 'approval_required',
        executionId: approvalExec.id,
        toolName,
        input,
        description: guardrailCheck.description ?? `Execute ${toolName}`,
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
        await db
          .update(aiToolExecutions)
          .set({ status: 'executing' })
          .where(eq(aiToolExecutions.id, approvalExec.id));
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
    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'tool_result',
        toolName,
        toolOutput: parsedOutput,
        toolUseId: toolUseId ?? null,
      });
    } catch (err) {
      console.error('[AI-SDK] Failed to save tool_result message:', err);
    }

    // 2. Create/update aiToolExecutions record
    const guardrailCheck = checkGuardrails(toolName, input);
    if (!guardrailCheck.requiresApproval) {
      try {
        await db.insert(aiToolExecutions).values({
          sessionId,
          toolName,
          toolInput: input,
          toolOutput: parsedOutput,
          status: isError ? 'failed' : 'completed',
          errorMessage: isError ? (typeof parsedOutput.error === 'string' ? parsedOutput.error : output.slice(0, 1000)) : undefined,
          durationMs,
          completedAt: new Date(),
        });
      } catch (err) {
        console.error('[AI-SDK] Failed to save tool execution record:', err);
      }
    } else {
      try {
        await db.update(aiToolExecutions)
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
          ));
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

    // 4. Write audit event
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
          ...(guardrailCheck.requiresApproval ? { approved: true } : {}),
        },
      });
    }
  };
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
