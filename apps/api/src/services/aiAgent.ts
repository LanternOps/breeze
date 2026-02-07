/**
 * AI Agent Service
 *
 * Core service wrapping the Anthropic SDK for multi-turn AI conversations.
 * Manages sessions, streams responses via SSE, dispatches tool calls
 * through the guardrails system, and tracks costs.
 */

import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions } from '../db/schema';
import { eq, and, desc, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { getToolDefinitions, executeTool } from './aiTools';

// Page context types (mirror @breeze/shared/types/ai)
type AiPageContext =
  | { type: 'device'; id: string; hostname: string; os?: string; status?: string; ip?: string }
  | { type: 'alert'; id: string; title: string; severity?: string; deviceHostname?: string }
  | { type: 'dashboard'; orgName?: string; deviceCount?: number; alertCount?: number }
  | { type: 'custom'; label: string; data: Record<string, unknown> };

type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  | { type: 'approval_required'; executionId: string; toolName: string; input: Record<string, unknown>; description: string }
  | { type: 'message_end'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done' };
import { checkGuardrails } from './aiGuardrails';
import { checkBudget, checkAiRateLimit, recordUsage, calculateCostCents } from './aiCostTracker';

const anthropic = new Anthropic();

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_ITERATIONS = 10;
const MAX_API_RETRIES = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

// ============================================
// Session Management
// ============================================

export async function createSession(
  auth: AuthContext,
  options: { pageContext?: AiPageContext; model?: string; title?: string; orgId?: string }
): Promise<{ id: string; orgId: string }> {
  const orgId = options.orgId ?? auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  if (!orgId) throw new Error('Organization context required');
  if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
    throw new Error('Access denied to this organization');
  }

  const [session] = await db
    .insert(aiSessions)
    .values({
      orgId,
      userId: auth.user.id,
      model: options.model ?? DEFAULT_MODEL,
      title: options.title ?? null,
      contextSnapshot: options.pageContext ?? null,
      systemPrompt: buildSystemPrompt(auth, options.pageContext)
    })
    .returning();

  if (!session) throw new Error('Failed to create session');
  return { id: session.id, orgId };
}

export async function getSession(sessionId: string, auth: AuthContext) {
  const conditions = [eq(aiSessions.id, sessionId)];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [session] = await db
    .select()
    .from(aiSessions)
    .where(and(...conditions))
    .limit(1);

  return session ?? null;
}

export async function listSessions(auth: AuthContext, options: { status?: string; page?: number; limit?: number }) {
  const conditions = [eq(aiSessions.userId, auth.user.id)];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);
  if (options.status) conditions.push(eq(aiSessions.status, options.status as 'active' | 'closed' | 'expired'));

  const limit = Math.min(options.limit ?? 20, 50);
  const offset = ((options.page ?? 1) - 1) * limit;

  const sessions = await db
    .select({
      id: aiSessions.id,
      title: aiSessions.title,
      status: aiSessions.status,
      model: aiSessions.model,
      turnCount: aiSessions.turnCount,
      totalCostCents: aiSessions.totalCostCents,
      lastActivityAt: aiSessions.lastActivityAt,
      createdAt: aiSessions.createdAt
    })
    .from(aiSessions)
    .where(and(...conditions))
    .orderBy(desc(aiSessions.lastActivityAt))
    .limit(limit)
    .offset(offset);

  return sessions;
}

export async function closeSession(sessionId: string, auth: AuthContext): Promise<boolean> {
  const session = await getSession(sessionId, auth);
  if (!session) return false;

  await db
    .update(aiSessions)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(aiSessions.id, sessionId));

  return true;
}

export async function getSessionMessages(sessionId: string, auth: AuthContext) {
  const session = await getSession(sessionId, auth);
  if (!session) return null;

  const messages = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(aiMessages.createdAt);

  return { session, messages };
}

// ============================================
// Message Handling + Streaming
// ============================================

/**
 * Send a message to the AI and stream the response.
 * Returns an async generator of SSE events.
 */
export async function* sendMessage(
  sessionId: string,
  content: string,
  auth: AuthContext,
  pageContext?: AiPageContext
): AsyncGenerator<AiStreamEvent> {
  const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  if (!orgId) {
    yield { type: 'error', message: 'Organization context required' };
    return;
  }

  // Check rate limits
  let rateLimitError: string | null;
  try {
    rateLimitError = await checkAiRateLimit(auth.user.id, orgId);
  } catch (err) {
    console.error('[AI] Rate limit check failed:', err);
    yield { type: 'error', message: 'Unable to verify rate limits. Please try again.' };
    return;
  }
  if (rateLimitError) {
    yield { type: 'error', message: rateLimitError };
    return;
  }

  // Check budget
  let budgetError: string | null;
  try {
    budgetError = await checkBudget(orgId);
  } catch (err) {
    console.error('[AI] Budget check failed:', err);
    yield { type: 'error', message: 'Unable to verify budget. Please try again.' };
    return;
  }
  if (budgetError) {
    yield { type: 'error', message: budgetError };
    return;
  }

  // Load session
  const session = await getSession(sessionId, auth);
  if (!session) {
    yield { type: 'error', message: 'Session not found' };
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

  // Save user message
  const [userMessage] = await db
    .insert(aiMessages)
    .values({
      sessionId,
      role: 'user',
      content
    })
    .returning();

  if (!userMessage) {
    console.warn('[AI] User message insert returned empty result for session:', sessionId);
  }

  // Build conversation history
  const history = await loadConversationHistory(sessionId);

  // Update context if page changed
  const systemPrompt = pageContext
    ? buildSystemPrompt(auth, pageContext)
    : (session.systemPrompt ?? buildSystemPrompt(auth));

  // Run the agentic loop
  yield* agenticLoop(session, history, systemPrompt, auth);

  yield { type: 'done' };
}

/**
 * Core agentic loop: sends messages to Claude, handles tool calls,
 * and streams events back to the client.
 */
async function* agenticLoop(
  session: typeof aiSessions.$inferSelect,
  history: Anthropic.MessageParam[],
  systemPrompt: string,
  auth: AuthContext
): AsyncGenerator<AiStreamEvent> {
  const tools = getToolDefinitions();
  let iterations = 0;
  let messages = [...history];

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    let assistantContent = '';
    let toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const messageId = crypto.randomUUID();
    yield { type: 'message_start', messageId };

    // Stream response from Claude with retry logic
    const response = await callAnthropicWithRetry(session.model, systemPrompt, messages, tools);
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;

    // Process content blocks
    for (const block of response.content) {
      if (block.type === 'text') {
        assistantContent += block.text;
        yield { type: 'content_delta', delta: block.text };
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>
        });
        yield {
          type: 'tool_use_start',
          toolName: block.name,
          toolUseId: block.id,
          input: block.input as Record<string, unknown>
        };
      }
    }

    yield { type: 'message_end', inputTokens, outputTokens };

    // Record usage
    try {
      await recordUsage(
        session.id,
        session.orgId,
        session.model,
        inputTokens,
        outputTokens,
        toolUseBlocks.length > 0
      );
    } catch (err) {
      console.error('[AI] Failed to record usage:', err);
    }

    // Save assistant message
    await db.insert(aiMessages).values({
      sessionId: session.id,
      role: 'assistant',
      content: assistantContent || null,
      contentBlocks: response.content as unknown as Record<string, unknown>[],
      inputTokens,
      outputTokens
    });

    // If no tool calls, we're done
    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      break;
    }

    // Process tool calls
    const toolResults: Anthropic.MessageParam['content'] = [];

    for (const toolUse of toolUseBlocks) {
      const guardrailCheck = checkGuardrails(toolUse.name, toolUse.input);

      if (!guardrailCheck.allowed) {
        // Tier 4: Blocked
        const errorResult = JSON.stringify({ error: guardrailCheck.reason });
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: errorResult,
          is_error: true
        });

        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          output: { error: guardrailCheck.reason },
          isError: true
        };
        continue;
      }

      // Track execution record ID for approved tools or new executions
      let execId: string | undefined;

      if (guardrailCheck.requiresApproval) {
        // Tier 3: Create execution record and wait for approval
        const [approvalExec] = await db
          .insert(aiToolExecutions)
          .values({
            sessionId: session.id,
            toolName: toolUse.name,
            toolInput: toolUse.input,
            status: 'pending'
          })
          .returning();

        if (!approvalExec) {
          // Insert failed - push error tool_result so Claude gets a proper response
          const errorResult = JSON.stringify({ error: 'Failed to create approval record' });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: errorResult,
            is_error: true
          });

          yield {
            type: 'error',
            message: 'Failed to create approval record for tool: ' + toolUse.name
          };

          yield {
            type: 'tool_result',
            toolUseId: toolUse.id,
            output: { error: 'Failed to create approval record' },
            isError: true
          };
          continue;
        }

        yield {
          type: 'approval_required',
          executionId: approvalExec.id,
          toolName: toolUse.name,
          input: toolUse.input,
          description: guardrailCheck.description ?? `Execute ${toolUse.name}`
        };

        // Wait for approval (poll with timeout)
        const approved = await waitForApproval(approvalExec.id, 300_000); // 5 min timeout

        if (!approved) {
          const rejectResult = JSON.stringify({ error: 'Tool execution was rejected or timed out' });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: rejectResult,
            is_error: true
          });

          yield {
            type: 'tool_result',
            toolUseId: toolUse.id,
            output: { error: 'Rejected or timed out' },
            isError: true
          };
          continue;
        }

        // Approved: update the existing approval record to 'executing' instead of creating a new one
        await db
          .update(aiToolExecutions)
          .set({ status: 'executing' })
          .where(eq(aiToolExecutions.id, approvalExec.id));

        execId = approvalExec.id;
      } else {
        // No approval needed: create execution record
        const [execRecord] = await db
          .insert(aiToolExecutions)
          .values({
            sessionId: session.id,
            toolName: toolUse.name,
            toolInput: toolUse.input,
            status: 'executing'
          })
          .returning();

        execId = execRecord?.id;
        if (!execId) {
          console.warn('[AI] Execution record insert returned empty result for tool:', toolUse.name);
        }
      }

      // Execute the tool
      const startTime = Date.now();

      try {
        const result = await executeTool(toolUse.name, toolUse.input, auth);
        const durationMs = Date.now() - startTime;
        const parsedResult = safeParseJson(result);

        // Save tool_use message
        await db.insert(aiMessages).values({
          sessionId: session.id,
          role: 'tool_use',
          toolName: toolUse.name,
          toolInput: toolUse.input,
          toolUseId: toolUse.id
        });

        // Save tool_result message
        await db.insert(aiMessages).values({
          sessionId: session.id,
          role: 'tool_result',
          toolName: toolUse.name,
          toolOutput: parsedResult,
          toolUseId: toolUse.id
        });

        // Update execution record
        if (execId) {
          await db
            .update(aiToolExecutions)
            .set({
              status: 'completed',
              toolOutput: parsedResult,
              durationMs,
              completedAt: new Date()
            })
            .where(eq(aiToolExecutions.id, execId));
        }

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result
        });

        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          output: parsedResult,
          isError: false
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Tool execution failed';
        const durationMs = Date.now() - startTime;

        if (execId) {
          await db
            .update(aiToolExecutions)
            .set({
              status: 'failed',
              errorMessage: errorMsg,
              durationMs,
              completedAt: new Date()
            })
            .where(eq(aiToolExecutions.id, execId));
        }

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: errorMsg }),
          is_error: true
        });

        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          output: { error: errorMsg },
          isError: true
        };
      }
    }

    // Add the assistant message and tool results to the conversation
    messages.push({
      role: 'assistant',
      content: response.content
    });

    messages.push({
      role: 'user',
      content: toolResults as Anthropic.ToolResultBlockParam[]
    });
  }
}

// ============================================
// Approval Flow
// ============================================

/**
 * Wait for a tool execution to be approved or rejected.
 * Polls the DB with exponential backoff.
 */
async function waitForApproval(executionId: string, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  let pollInterval = 500;
  let consecutiveErrors = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const [execution] = await db
        .select({ status: aiToolExecutions.status })
        .from(aiToolExecutions)
        .where(eq(aiToolExecutions.id, executionId))
        .limit(1);

      consecutiveErrors = 0;

      if (!execution) return false;

      if (execution.status === 'approved') return true;
      if (execution.status === 'rejected') return false;
    } catch (err) {
      consecutiveErrors++;
      console.error(`[AI] Approval poll error (attempt ${consecutiveErrors}):`, err);
      if (consecutiveErrors >= 5) {
        try {
          await db
            .update(aiToolExecutions)
            .set({ status: 'rejected', errorMessage: 'Polling failed' })
            .where(eq(aiToolExecutions.id, executionId));
        } catch { /* best-effort cleanup */ }
        return false;
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 3000);
  }

  // Timeout - mark as rejected
  try {
    await db
      .update(aiToolExecutions)
      .set({ status: 'rejected', errorMessage: 'Approval timed out' })
      .where(eq(aiToolExecutions.id, executionId));
  } catch (err) {
    console.error('[AI] Failed to mark timed-out execution:', err);
  }

  return false;
}

/**
 * Approve or reject a pending tool execution.
 */
export async function handleApproval(
  executionId: string,
  approved: boolean,
  auth: AuthContext
): Promise<boolean> {
  const [execution] = await db
    .select()
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.id, executionId))
    .limit(1);

  if (!execution || execution.status !== 'pending') return false;

  // Verify the session belongs to the user's org
  const session = await getSession(execution.sessionId, auth);
  if (!session) return false;

  await db
    .update(aiToolExecutions)
    .set({
      status: approved ? 'approved' : 'rejected',
      approvedBy: auth.user.id,
      approvedAt: new Date()
    })
    .where(eq(aiToolExecutions.id, executionId));

  return true;
}

// ============================================
// Conversation History
// ============================================

async function loadConversationHistory(sessionId: string): Promise<Anthropic.MessageParam[]> {
  let dbMessages;
  try {
    dbMessages = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.sessionId, sessionId))
      .orderBy(aiMessages.createdAt);
  } catch (err) {
    console.error('[AI] Failed to load conversation history for session:', sessionId, err);
    return [];
  }

  const messages: Anthropic.MessageParam[] = [];

  for (const msg of dbMessages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      if (msg.contentBlocks) {
        messages.push({
          role: 'assistant',
          content: msg.contentBlocks as Anthropic.ContentBlock[]
        });
      } else {
        messages.push({ role: 'assistant', content: msg.content ?? '' });
      }
    } else if (msg.role === 'tool_result') {
      // Tool results are appended as user messages with tool_result blocks
      const lastMessage = messages[messages.length - 1];
      const resultBlock: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.toolUseId ?? '',
        content: msg.toolOutput ? JSON.stringify(msg.toolOutput) : ''
      };

      if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
        (lastMessage.content as Anthropic.ToolResultBlockParam[]).push(resultBlock);
      } else {
        messages.push({ role: 'user', content: [resultBlock] });
      }
    }
    // tool_use messages are captured as part of assistant contentBlocks
  }

  return messages;
}

// ============================================
// System Prompt
// ============================================

function buildSystemPrompt(auth: AuthContext, pageContext?: AiPageContext): string {
  const parts: string[] = [];

  parts.push(`You are Breeze AI, an intelligent IT assistant built into the Breeze RMM platform. You help IT technicians and MSP staff manage devices, troubleshoot issues, analyze security threats, and build automations.

## Your Capabilities
- Query and analyze device inventory, hardware, and metrics
- View and manage alerts (acknowledge, resolve)
- Execute commands on devices (with user approval for destructive operations)
- Run scripts on devices
- Manage system services
- Perform security scans and threat management
- Query audit logs for investigation
- Create automations
- Perform network discovery

## Important Rules
1. Always verify device access before operations - you can only see devices in the user's organization.
2. For destructive operations (service restart, file delete, script execution), the user will be asked to approve.
3. Provide concise, actionable responses. You're talking to IT professionals.
4. When showing device data, format it clearly with relevant details.
5. If you need more information to help, ask specific questions.
6. Never fabricate device data or metrics - always use tools to get real data.
7. When troubleshooting, explain your reasoning and suggest next steps.`);

  // Add user context
  parts.push(`\n## Current User
- Name: ${auth.user.name}
- Email: ${auth.user.email}
- Scope: ${auth.scope}`);

  if (auth.orgId) {
    parts.push(`- Organization ID: ${auth.orgId}`);
  }

  // Add page context
  if (pageContext) {
    parts.push('\n## Current Page Context');
    switch (pageContext.type) {
      case 'device':
        parts.push(`The user is viewing device "${pageContext.hostname}" (ID: ${pageContext.id}).`);
        if (pageContext.os) parts.push(`OS: ${pageContext.os}`);
        if (pageContext.status) parts.push(`Status: ${pageContext.status}`);
        if (pageContext.ip) parts.push(`IP: ${pageContext.ip}`);
        parts.push('Prioritize information and actions related to this device.');
        break;

      case 'alert':
        parts.push(`The user is viewing alert "${pageContext.title}" (ID: ${pageContext.id}).`);
        if (pageContext.severity) parts.push(`Severity: ${pageContext.severity}`);
        if (pageContext.deviceHostname) parts.push(`Device: ${pageContext.deviceHostname}`);
        parts.push('Prioritize helping investigate and resolve this alert.');
        break;

      case 'dashboard':
        parts.push('The user is on the main dashboard.');
        if (pageContext.orgName) parts.push(`Organization: ${pageContext.orgName}`);
        if (pageContext.deviceCount != null) parts.push(`Total devices: ${pageContext.deviceCount}`);
        if (pageContext.alertCount != null) parts.push(`Active alerts: ${pageContext.alertCount}`);
        break;

      case 'custom':
        parts.push(`Context: ${pageContext.label}`);
        parts.push(JSON.stringify(pageContext.data, null, 2));
        break;
    }
  }

  return parts.join('\n');
}

// ============================================
// API Retry Logic
// ============================================

async function callAnthropicWithRetry(
  model: string,
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[]
): Promise<Anthropic.Message> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
    try {
      const stream = anthropic.messages.stream({
        model,
        max_tokens: 4096,
        system,
        messages,
        tools
      });
      return await stream.finalMessage();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if retryable
      const statusCode = (err as { status?: number }).status;
      if (!statusCode || !RETRYABLE_STATUS_CODES.has(statusCode)) {
        throw toUserFriendlyError(err);
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[AI] Anthropic API error (${statusCode}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_API_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw toUserFriendlyError(lastError);
}

function toUserFriendlyError(err: unknown): Error {
  const statusCode = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);

  if (statusCode === 429) return new Error('AI service is temporarily busy. Please try again in a moment.');
  if (statusCode === 529) return new Error('AI service is currently overloaded. Please try again later.');
  if (statusCode === 401) return new Error('AI service authentication error. Please contact your administrator.');
  if (statusCode && statusCode >= 500) return new Error('AI service is experiencing issues. Please try again.');
  if (message.includes('context_length_exceeded')) return new Error('Conversation is too long. Please start a new session.');
  return new Error(`AI request failed: ${message}`);
}

// ============================================
// Search Sessions
// ============================================

export async function searchSessions(
  auth: AuthContext,
  query: string,
  options: { limit?: number }
): Promise<Array<{ id: string; title: string | null; matchedContent: string; createdAt: Date }>> {
  const conditions: SQL[] = [eq(aiSessions.userId, auth.user.id)];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);

  // Search in session titles and message content
  const searchPattern = '%' + escapeLike(query) + '%';

  // First: search session titles
  const titleMatches = await db
    .select({
      id: aiSessions.id,
      title: aiSessions.title,
      createdAt: aiSessions.createdAt
    })
    .from(aiSessions)
    .where(and(
      ...conditions,
      sql`${aiSessions.title} ILIKE ${searchPattern}`
    ))
    .orderBy(desc(aiSessions.lastActivityAt))
    .limit(options.limit ?? 20);

  // Then: search message content
  const messageMatches = await db
    .select({
      sessionId: aiMessages.sessionId,
      content: aiMessages.content,
      sessionTitle: aiSessions.title,
      sessionCreatedAt: aiSessions.createdAt
    })
    .from(aiMessages)
    .innerJoin(aiSessions, eq(aiMessages.sessionId, aiSessions.id))
    .where(and(
      ...conditions, // re-use org/user conditions on aiSessions
      sql`${aiMessages.content} ILIKE ${searchPattern}`,
      sql`${aiMessages.role} IN ('user', 'assistant')`
    ))
    .orderBy(desc(aiMessages.createdAt))
    .limit(options.limit ?? 20);

  // Merge and deduplicate by session ID
  const seen = new Set<string>();
  const results: Array<{ id: string; title: string | null; matchedContent: string; createdAt: Date }> = [];

  for (const t of titleMatches) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      results.push({ id: t.id, title: t.title, matchedContent: t.title ?? '', createdAt: t.createdAt });
    }
  }

  for (const m of messageMatches) {
    if (!seen.has(m.sessionId)) {
      seen.add(m.sessionId);
      // Truncate matched content for display
      const content = m.content ?? '';
      const idx = content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + query.length + 40);
      const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');

      results.push({
        id: m.sessionId,
        title: m.sessionTitle,
        matchedContent: snippet,
        createdAt: m.sessionCreatedAt
      });
    }
  }

  return results.slice(0, options.limit ?? 20);
}

// ============================================
// Helpers
// ============================================

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, '\\$&');
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    console.warn('[AI] Tool returned non-JSON output, wrapping as raw:', str.slice(0, 200));
    return { raw: str };
  }
}
