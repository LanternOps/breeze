/**
 * Script Builder AI Routes
 *
 * REST + SSE endpoints for the inline script editor AI assistant.
 * Mounted at /api/v1/ai/script-builder
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { authMiddleware, requireScope } from '../middleware/auth';
import {
  createScriptBuilderSession,
  getScriptBuilderSession,
  getScriptBuilderMessages,
  updateEditorContext,
  closeScriptBuilderSession,
} from '../services/scriptBuilderService';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { handleApproval } from '../services/aiAgent';
import { writeRouteAudit } from '../services/auditEvents';
import {
  createScriptBuilderSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  scriptBuilderContextSchema,
} from '@breeze/shared/validators/ai';
import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../services/scriptBuilderTools';
import { captureException } from '../services/sentry';
import { db } from '../db';
import { aiSessions, aiMessages } from '../db/schema';
import { eq } from 'drizzle-orm';

export const scriptAiRoutes = new Hono();

scriptAiRoutes.use('*', authMiddleware);

/**
 * Derive a short title from the user's first message.
 * Truncates at a word boundary to <=80 chars and adds ellipsis if needed.
 */
function generateSessionTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  const truncated = cleaned.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '\u2026';
}

// ============================================
// Session CRUD
// ============================================

// POST /sessions - Create a new script builder session
scriptAiRoutes.post(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createScriptBuilderSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const session = await createScriptBuilderSession(auth, body);
      writeRouteAudit(c, {
        orgId: session.orgId,
        action: 'ai.script_builder.session.create',
        resourceType: 'ai_session',
        resourceId: session.id,
        resourceName: body.title ?? 'Script Builder',
      });
      return c.json(session, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message === 'Organization context required') return c.json({ error: message }, 400);
      captureException(err, c);
      return c.json({ error: message }, 500);
    }
  }
);

// GET /sessions/:id - Get session with messages
scriptAiRoutes.get(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    try {
      const session = await getScriptBuilderSession(c.req.param('id'), auth);
      if (!session) return c.json({ error: 'Session not found' }, 404);

      const messages = await getScriptBuilderMessages(session.id);
      return c.json({ session, messages });
    } catch (err) {
      captureException(err, c);
      console.error('[ScriptAI] Failed to get session:', err);
      return c.json({ error: 'Failed to load session' }, 500);
    }
  }
);

// DELETE /sessions/:id - Close session
scriptAiRoutes.delete(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    try {
      await closeScriptBuilderSession(sessionId, auth);
      streamingSessionManager.remove(sessionId);

      writeRouteAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'ai.script_builder.session.close',
        resourceType: 'ai_session',
        resourceId: sessionId,
      });

      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to close session';
      if (message === 'Session not found') return c.json({ error: message }, 404);
      captureException(err, c);
      return c.json({ error: message }, 500);
    }
  }
);

// ============================================
// Messaging (SSE streaming)
// ============================================

// POST /sessions/:id/messages - Send message, returns SSE stream
scriptAiRoutes.post(
  '/sessions/:id/messages',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', sendAiMessageSchema.extend({
    editorContext: scriptBuilderContextSchema.optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const { content, editorContext } = c.req.valid('json');

    // Run pre-flight checks (rate limits, budget, session status)
    const preflight = await runPreFlightChecks(sessionId, content, auth, undefined, c);
    if (!preflight.ok) {
      const err = preflight.error;
      if (err === 'Session not found') return c.json({ error: err }, 404);
      if (err.includes('rate limit') || err.includes('Rate limit')) return c.json({ error: err }, 429);
      if (err.includes('budget') || err.includes('Budget')) return c.json({ error: err }, 402);
      if (err.includes('expired')) return c.json({ error: err }, 410);
      return c.json({ error: err }, 400);
    }

    // Verify this is actually a script_builder session
    if (preflight.session.type !== 'script_builder') {
      return c.json({ error: 'Session not found' }, 404);
    }

    const { session: dbSession, sanitizedContent, systemPrompt, maxBudgetUsd } = preflight;

    // Now safe to update editor context
    let updatedSystemPrompt: string | undefined;
    if (editorContext) {
      try {
        updatedSystemPrompt = await updateEditorContext(sessionId, editorContext, auth);
      } catch (err) {
        captureException(err, c);
        console.error('[ScriptAI] Failed to update editor context:', err);
      }
    }
    const effectiveSystemPrompt = updatedSystemPrompt ?? systemPrompt;

    // Get or create streaming session with script builder MCP tools
    const activeSession = await streamingSessionManager.getOrCreate(
      sessionId,
      {
        orgId: dbSession.orgId,
        sdkSessionId: dbSession.sdkSessionId,
        model: dbSession.model,
        maxTurns: dbSession.maxTurns,
        turnCount: dbSession.turnCount,
        systemPrompt: dbSession.systemPrompt,
      },
      auth,
      c,
      effectiveSystemPrompt,
      maxBudgetUsd,
      SCRIPT_BUILDER_MCP_TOOL_NAMES,
      // Custom MCP server factory for script builder tools
      (getAuth, onPreToolUse, onPostToolUse) => ({
        server: createScriptBuilderMcpServer(getAuth, onPreToolUse, onPostToolUse),
        name: 'script_builder',
      }),
    );

    // Concurrent message guard - atomic check-and-set
    if (!streamingSessionManager.tryTransitionToProcessing(activeSession)) {
      return c.json({ error: 'A message is already being processed for this session' }, 409);
    }

    writeRouteAudit(c, {
      orgId: dbSession.orgId,
      action: 'ai.script_builder.message.send',
      resourceType: 'ai_session',
      resourceId: sessionId,
      details: { contentLength: content.length },
    });

    // Save user message to DB
    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'user',
        content: sanitizedContent,
      });
    } catch (err) {
      captureException(err, c);
      console.error('[ScriptAI] Failed to save user message to DB:', err);
      activeSession.state = 'idle';
      return c.json({ error: 'Failed to save message' }, 500);
    }

    // Auto-generate title from first user message
    if (!dbSession.title) {
      const title = generateSessionTitle(sanitizedContent);
      try {
        await db.update(aiSessions)
          .set({ title })
          .where(eq(aiSessions.id, sessionId));
        activeSession.eventBus.publish({ type: 'title_updated', title });
      } catch (err) {
        captureException(err, c);
        console.error('[ScriptAI] Failed to auto-set session title:', err);
      }
    }

    // Push message to the streaming input and start turn timeout
    activeSession.inputController.pushMessage(sanitizedContent);
    streamingSessionManager.startTurnTimeout(activeSession);

    const subscriptionId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      const events = activeSession.eventBus.subscribe(subscriptionId);

      try {
        for await (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === 'done') break;
        }
      } catch (err) {
        captureException(err, c);
        console.error('[ScriptAI] Stream error:', err);
        try {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'Stream failed',
            }),
          });
        } catch (writeErr) {
          console.warn('[ScriptAI] Could not write SSE error event (client likely disconnected):', writeErr);
        }
      } finally {
        activeSession.eventBus.unsubscribe(subscriptionId);
      }
    });
  }
);

// ============================================
// Interrupt
// ============================================

// POST /sessions/:id/interrupt - Interrupt active response
scriptAiRoutes.post(
  '/sessions/:id/interrupt',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    // Verify session ownership
    const session = await getScriptBuilderSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    let result: { interrupted: boolean; reason?: string };
    try {
      result = await streamingSessionManager.interrupt(sessionId);
    } catch (err) {
      captureException(err, c);
      console.error('[ScriptAI] Interrupt failed:', err);
      return c.json({ error: 'Failed to interrupt session' }, 500);
    }

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.script_builder.message.interrupt',
      resourceType: 'ai_session',
      resourceId: sessionId,
      details: { interrupted: result.interrupted, reason: result.reason },
    });

    if (!result.interrupted) {
      return c.json({ success: false, interrupted: false, reason: result.reason }, 409);
    }

    return c.json({ success: true, interrupted: true });
  }
);

// ============================================
// Tool Approval (for execute_script_on_device)
// ============================================

// POST /sessions/:id/approve/:executionId
scriptAiRoutes.post(
  '/sessions/:id/approve/:executionId',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', approveToolSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const executionId = c.req.param('executionId');
    const { approved } = c.req.valid('json');

    // Verify session ownership
    const session = await getScriptBuilderSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const success = await handleApproval(executionId, approved, auth);
    if (!success) {
      return c.json({ error: 'Execution not found or already processed' }, 404);
    }

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.script_builder.tool_approval.update',
      resourceType: 'ai_execution',
      resourceId: executionId,
      details: { approved },
    });

    return c.json({ success: true, approved });
  }
);
