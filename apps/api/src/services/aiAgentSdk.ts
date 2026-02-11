/**
 * AI Agent Service (Claude Agent SDK)
 *
 * Drop-in replacement for the agentic loop in aiAgent.ts using the
 * Claude Agent SDK's managed query() function. Activated via the
 * USE_AGENT_SDK=1 feature flag.
 *
 * Preserves:
 * - All 17 custom MCP tools (via createBreezeMcpServer)
 * - 4-tier guardrail system (via canUseTool callback, requires permissionMode 'default')
 * - Input sanitization (before query)
 * - SSE event contract to frontend (translation layer)
 * - DB persistence (mirrored messages to aiMessages)
 * - Cost tracking (daily/monthly aggregates)
 * - Tier 3 approval flow (DB polling in canUseTool)
 *
 * NOTE: permissionMode must be 'default' (not 'bypassPermissions') so the CLI
 * subprocess sends can_use_tool control requests for MCP tools, ensuring the
 * canUseTool callback is invoked for guardrails, RBAC, and approval checks.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage, PermissionResult, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiPageContext, AiStreamEvent } from '@breeze/shared/types/ai';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { checkBudget, checkAiRateLimit, recordUsageFromSdkResult, getRemainingBudgetUsd } from './aiCostTracker';
import { sanitizeUserMessage, sanitizePageContext } from './aiInputSanitizer';
import { getSession, buildSystemPrompt, waitForApproval, sanitizeErrorForClient } from './aiAgent';
import { createBreezeMcpServer, BREEZE_MCP_TOOL_NAMES, TOOL_TIERS, type PostToolUseCallback } from './aiAgentSdkTools';
import { writeAuditEvent, type RequestLike } from './auditEvents';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SDK_QUERY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max for entire SDK query
const MCP_PREFIX = 'mcp__breeze__';

/**
 * Async queue that decouples event producers (SDK processing loop, postToolUse
 * callback, canUseTool callback) from the SSE consumer (generator yield).
 *
 * Fixes the race condition where tool_result events were stuck in a plain array
 * that only drained when the SDK iterator yielded the next message — which may
 * never happen if the Anthropic API call after tool execution hangs.
 */
class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      }
    };
  }
}

/**
 * Send a message to the AI via the Claude Agent SDK and stream the response.
 * Returns an async generator of SSE events (same contract as sendMessage).
 */
export async function* sendMessageSdk(
  sessionId: string,
  content: string,
  auth: AuthContext,
  pageContext?: AiPageContext,
  requestContext?: RequestLike
): AsyncGenerator<AiStreamEvent> {
  // ===== Pre-flight checks (same as aiAgent.ts) =====
  const session = await getSession(sessionId, auth);
  if (!session) {
    yield { type: 'error', message: 'Session not found' };
    return;
  }
  const orgId = session.orgId;

  // Rate limits
  let rateLimitError: string | null;
  try {
    rateLimitError = await checkAiRateLimit(auth.user.id, orgId);
  } catch (err) {
    console.error('[AI-SDK] Rate limit check failed:', err);
    yield { type: 'error', message: 'Unable to verify rate limits. Please try again.' };
    return;
  }
  if (rateLimitError) {
    yield { type: 'error', message: rateLimitError };
    return;
  }

  // Budget
  let budgetError: string | null;
  try {
    budgetError = await checkBudget(orgId);
  } catch (err) {
    console.error('[AI-SDK] Budget check failed:', err);
    yield { type: 'error', message: 'Unable to verify budget. Please try again.' };
    return;
  }
  if (budgetError) {
    yield { type: 'error', message: budgetError };
    return;
  }

  if (session.status !== 'active') {
    yield { type: 'error', message: 'Session is not active' };
    return;
  }

  if (session.turnCount >= session.maxTurns) {
    yield { type: 'error', message: `Session turn limit reached (${session.maxTurns})` };
    return;
  }

  // Session expiration
  const now = Date.now();
  const sessionAge = now - new Date(session.createdAt).getTime();
  const idleTime = now - new Date(session.lastActivityAt).getTime();

  if (sessionAge > SESSION_MAX_AGE_MS) {
    await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active')));
    yield { type: 'error', message: 'Session has expired (24h max age). Please start a new session.' };
    return;
  }

  if (idleTime > SESSION_IDLE_TIMEOUT_MS) {
    await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active')));
    yield { type: 'error', message: 'Session has expired due to inactivity. Please start a new session.' };
    return;
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
          sessionId
        }
      });
    }
  }

  // Save user message
  await db.insert(aiMessages).values({
    sessionId,
    role: 'user',
    content: sanitizedContent
  });

  // Build system prompt
  let sanitizedPageContext: AiPageContext | undefined;
  try {
    sanitizedPageContext = pageContext ? sanitizePageContext(pageContext) : undefined;
  } catch (err) {
    console.error('[AI-SDK] Failed to sanitize page context:', err);
    sanitizedPageContext = undefined;
  }
  const systemPrompt = sanitizedPageContext
    ? buildSystemPrompt(auth, sanitizedPageContext)
    : (session.systemPrompt ?? buildSystemPrompt(auth));

  // FIFO queue: toolUseIds from canUseTool (SDK-provided), consumed by postToolUse callback.
  // Populated when canUseTool allows a tool (guaranteed 1:1 with postToolUse calls).
  const toolUseIdQueue: string[] = [];

  // Shared async event queue — replaces the old pendingEvents array.
  // Both the SDK processing loop and the postToolUse/canUseTool callbacks push
  // events here; the generator yields from it. This ensures tool_result and
  // approval_required events reach the frontend immediately, even if the SDK
  // iterator is blocked waiting for the next Anthropic API response.
  const eventQueue = new AsyncEventQueue<AiStreamEvent>();

  // ===== postToolUse callback =====
  // Fires after every MCP tool handler returns (success or error).
  // Mirrors the old agenticLoop's per-tool persistence, SSE, and audit.
  const postToolUse: PostToolUseCallback = async (
    toolName, input, output, isError, durationMs
  ) => {
    const toolUseId = toolUseIdQueue.shift(); // correlate with stream event
    const parsedOutput = safeParseJson(output);

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

    // 2. Create aiToolExecutions record (for non-approval tools; approval tools already have one)
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
      // Approval tools: update the existing record to completed/failed
      // The record was already created in canUseTool; find it by sessionId+toolName+status='executing'
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

    // 3. Emit tool_result SSE event — pushed directly to the async queue so
    //    the frontend receives it immediately, without waiting for the SDK
    //    iterator to yield the next message.
    eventQueue.push({
      type: 'tool_result',
      toolUseId: toolUseId ?? '',
      output: parsedOutput,
      isError,
    });

    // 4. Write audit event
    if (requestContext) {
      writeAuditEvent(requestContext, {
        orgId,
        action: `ai.tool.${toolName}`,
        resourceType: 'ai_session',
        resourceId: sessionId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
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

  // Create per-request MCP server (with postToolUse hook)
  const breezeServer = createBreezeMcpServer(auth, postToolUse);

  // Compute remaining budget (fail closed: default to $0.50 if lookup fails)
  let maxBudgetUsd: number | undefined;
  try {
    const remaining = await getRemainingBudgetUsd(orgId);
    if (remaining !== null) maxBudgetUsd = remaining;
  } catch (err) {
    console.error('[AI-SDK] Failed to get remaining budget, denying request:', err);
    yield { type: 'error', message: 'Unable to verify spending budget. Please try again later.' };
    return;
  }

  // Remaining turns
  const maxTurns = Math.max(1, session.maxTurns - session.turnCount);

  // ===== canUseTool callback =====
  const canUseTool: CanUseTool = async (
    toolName,
    input,
    options,
  ) => {
    // Strip MCP prefix to get bare tool name
    const bareName = toolName.startsWith(MCP_PREFIX)
      ? toolName.slice(MCP_PREFIX.length)
      : toolName;

    // Only allow our Breeze tools
    if (!TOOL_TIERS[bareName]) {
      return { behavior: 'deny', message: `Unknown tool: ${bareName}` };
    }

    // Guardrails (tier check + action-based escalation)
    const guardrailCheck = checkGuardrails(bareName, input);

    if (!guardrailCheck.allowed) {
      return { behavior: 'deny', message: guardrailCheck.reason ?? 'Tool blocked by guardrails' };
    }

    // RBAC permission check
    try {
      const permError = await checkToolPermission(bareName, input, auth);
      if (permError) {
        return { behavior: 'deny', message: permError };
      }
    } catch (err) {
      console.error('[AI-SDK] Permission check failed for tool:', bareName, err);
      return { behavior: 'deny', message: 'Unable to verify permissions. Please try again.' };
    }

    // Per-tool rate limit
    try {
      const rateLimitErr = await checkToolRateLimit(bareName, auth.user.id);
      if (rateLimitErr) {
        return { behavior: 'deny', message: rateLimitErr };
      }
    } catch (err) {
      console.error('[AI-SDK] Tool rate limit check failed for:', bareName, err);
      return { behavior: 'deny', message: 'Unable to verify rate limits. Please try again.' };
    }

    // Tier 3: Requires user approval
    if (guardrailCheck.requiresApproval) {
      const [approvalExec] = await db
        .insert(aiToolExecutions)
        .values({
          sessionId,
          toolName: bareName,
          toolInput: input,
          status: 'pending'
        })
        .returning();

      if (!approvalExec) {
        return { behavior: 'deny', message: 'Failed to create approval record' };
      }

      // Emit approval_required event — goes directly to queue for immediate delivery
      eventQueue.push({
        type: 'approval_required',
        executionId: approvalExec.id,
        toolName: bareName,
        input,
        description: guardrailCheck.description ?? `Execute ${bareName}`
      });

      // Wait for approval (blocks the SDK loop; respects abort signal)
      const approved = await waitForApproval(approvalExec.id, 300_000, options.signal); // 5 min

      if (!approved) {
        return { behavior: 'deny', message: 'Tool execution was rejected or timed out' };
      }

      // Mark as executing
      await db
        .update(aiToolExecutions)
        .set({ status: 'executing' })
        .where(eq(aiToolExecutions.id, approvalExec.id));
    }

    // Track toolUseID from SDK for postToolUse correlation (replaces fragile stream-based FIFO)
    toolUseIdQueue.push(options.toolUseID);

    return { behavior: 'allow' };
  };

  // ===== Call SDK query() =====
  let sdkQuery;
  try {
    sdkQuery = query({
      prompt: sanitizedContent,
      options: {
        systemPrompt,
        model: session.model,
        maxTurns,
        maxBudgetUsd,
        tools: [], // Disable ALL built-in tools
        allowedTools: BREEZE_MCP_TOOL_NAMES,
        mcpServers: { breeze: breezeServer },
        canUseTool,
        includePartialMessages: true,
        permissionMode: 'default',
        resume: session.sdkSessionId ?? undefined,
        persistSession: true, // SDK persists session history so resume works across requests
        settingSources: [], // Don't load filesystem settings
        thinking: { type: 'disabled' }, // Keep cost down for RMM chat
      }
    });
  } catch (err) {
    console.error('[AI-SDK] Failed to create query:', err);
    yield { type: 'error', message: 'Failed to initialize AI session' };
    return;
  }

  // ===== Background SDK processing =====
  // Runs the SDK iterator in a separate async task, pushing translated SSE
  // events to the shared eventQueue. This decouples event delivery from the
  // SDK iterator — tool_result events from postToolUse reach the frontend
  // immediately instead of waiting for the next SDK message.
  const processSdkMessages = async () => {
    let currentMessageId = crypto.randomUUID();
    let messageStarted = false;
    let sdkSessionId: string | undefined;

    try {
      for await (const message of sdkQuery) {
        switch (message.type) {
          case 'system': {
            if ('session_id' in message) {
              sdkSessionId = message.session_id;
              // Store SDK session ID eagerly so resume works even if the
              // query errors or times out before the result message.
              db.update(aiSessions)
                .set({ sdkSessionId: message.session_id })
                .where(eq(aiSessions.id, sessionId))
                .catch((err) => console.error('[AI-SDK] Failed to store SDK session ID early:', err));
            }
            break;
          }

          case 'stream_event': {
            const event = message.event;

            if (event.type === 'message_start') {
              currentMessageId = crypto.randomUUID();
              messageStarted = true;
              eventQueue.push({ type: 'message_start', messageId: currentMessageId });
            } else if (event.type === 'content_block_delta') {
              if ('delta' in event && event.delta.type === 'text_delta') {
                eventQueue.push({ type: 'content_delta', delta: event.delta.text });
              }
            } else if (event.type === 'content_block_start') {
              if ('content_block' in event && event.content_block.type === 'tool_use') {
                const block = event.content_block;
                eventQueue.push({
                  type: 'tool_use_start',
                  toolName: block.name.startsWith(MCP_PREFIX)
                    ? block.name.slice(MCP_PREFIX.length)
                    : block.name,
                  toolUseId: block.id,
                  input: {} // Empty in stream event; full input provided to canUseTool and MCP handler by SDK
                });
              }
            } else if (event.type === 'message_delta') {
              if (messageStarted) {
                eventQueue.push({
                  type: 'message_end',
                  inputTokens: 0, // message_delta only provides output_tokens
                  outputTokens: event.usage?.output_tokens ?? 0
                });
                messageStarted = false;
              }
            }
            break;
          }

          case 'assistant': {
            // Full assistant message — save to DB
            const assistantContent = message.message.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? (b as { text: string }).text : ''))
              .join('');

            try {
              await db.insert(aiMessages).values({
                sessionId,
                role: 'assistant',
                content: assistantContent || null,
                contentBlocks: message.message.content as unknown as Record<string, unknown>[],
                inputTokens: message.message.usage?.input_tokens ?? 0,
                outputTokens: message.message.usage?.output_tokens ?? 0
              });
            } catch (err) {
              console.error('[AI-SDK] Failed to save assistant message:', err);
            }

            // Also save tool_use entries for any MCP tool calls
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                const bareName = block.name.startsWith(MCP_PREFIX)
                  ? block.name.slice(MCP_PREFIX.length)
                  : block.name;

                try {
                  await db.insert(aiMessages).values({
                    sessionId,
                    role: 'tool_use',
                    toolName: bareName,
                    toolInput: block.input as Record<string, unknown>,
                    toolUseId: block.id
                  });
                } catch (err) {
                  console.error('[AI-SDK] Failed to save tool_use message:', err);
                }
              }
            }
            break;
          }

          case 'result': {
            const resultMsg = message as SDKResultMessage;

            if (resultMsg.subtype === 'success') {
              // Record usage via SDK-provided cost data
              try {
                await recordUsageFromSdkResult(sessionId, orgId, {
                  total_cost_usd: resultMsg.total_cost_usd,
                  usage: {
                    input_tokens: resultMsg.usage.input_tokens,
                    output_tokens: resultMsg.usage.output_tokens
                  },
                  num_turns: resultMsg.num_turns
                });
              } catch (err) {
                console.error('[AI-SDK] Failed to record SDK usage:', err);
              }

              // SDK session ID already stored eagerly in 'system' handler
            } else {
              // Error result
              const errors = 'errors' in resultMsg ? resultMsg.errors : [];
              const errorMsg = errors.length > 0
                ? errors[0]
                : `AI query ended: ${resultMsg.subtype}`;

              if (resultMsg.subtype === 'error_max_budget_usd') {
                eventQueue.push({ type: 'error', message: 'AI budget limit reached for this query.' });
              } else if (resultMsg.subtype === 'error_max_turns') {
                eventQueue.push({ type: 'error', message: 'Maximum conversation turns reached.' });
              } else {
                eventQueue.push({ type: 'error', message: sanitizeErrorForClient(new Error(errorMsg ?? 'Unknown error')) });
              }

              // Still record usage for error results
              try {
                await recordUsageFromSdkResult(sessionId, orgId, {
                  total_cost_usd: resultMsg.total_cost_usd,
                  usage: {
                    input_tokens: resultMsg.usage.input_tokens,
                    output_tokens: resultMsg.usage.output_tokens
                  },
                  num_turns: resultMsg.num_turns
                });
              } catch (err) {
                console.error('[AI-SDK] Failed to record SDK usage on error:', err);
              }
            }
            break;
          }

          // Ignore other message types (user, user_replay, compact_boundary, etc.)
          default:
            break;
        }
      }
    } catch (err) {
      console.error('[AI-SDK] Query error:', err);
      eventQueue.push({ type: 'error', message: sanitizeErrorForClient(err) });
    }

    // Signal completion
    eventQueue.push({ type: 'done' });
    eventQueue.close();
  };

  // Start SDK processing in background
  const sdkPromise = processSdkMessages();

  // Timeout guard — if the SDK hangs (e.g. Anthropic API unresponsive after
  // tool execution), close the queue so the SSE stream ends gracefully.
  const timeoutId = setTimeout(() => {
    console.error('[AI-SDK] Query timed out after', SDK_QUERY_TIMEOUT_MS, 'ms, session:', sessionId);
    eventQueue.push({ type: 'error', message: 'AI request timed out. Please try again.' });
    eventQueue.push({ type: 'done' });
    eventQueue.close();
  }, SDK_QUERY_TIMEOUT_MS);

  // Prevent unhandled rejection if SDK task fails after we stop reading
  sdkPromise.catch((err) => {
    console.error('[AI-SDK] Background SDK task error:', err);
  });

  // ===== Yield events to SSE stream =====
  try {
    for await (const event of eventQueue) {
      yield event;
      if (event.type === 'done') break;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeParseJson(str: string): Record<string, unknown> {
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
