/**
 * AI Chat Routes
 *
 * REST + SSE endpoints for the AI chat sidebar.
 * Uses streaming input mode via StreamingSessionManager for persistent sessions.
 */

import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import {
  createSession,
  getSession,
  listSessions,
  closeSession,
  getSessionMessages,
  handleApproval,
  isIntentBackedExecution,
  searchSessions,
  listM365Connections,
  resolveDefaultModel
} from '../services/aiAgent';
import { runPreFlightChecks, abortActivePlan } from '../services/aiAgentSdk';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { getUsageSummary, updateBudget, getSessionHistory, recordUsage } from '../services/aiCostTracker';
import { createTicket, changeTicketStatus, TicketServiceError } from '../services/ticketService';
import { createTimeEntry } from '../services/timeEntryService';
import { writeRouteAudit } from '../services/auditEvents';
import { assertNotLocked } from '../services/effectiveSettings';
import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions, auditLogs, organizations, devices } from '../db/schema';
import { eq, and, desc, gte, lte, count, avg, sql as drizzleSql } from 'drizzle-orm';
import { PERMISSIONS } from '../services/permissions';
import {
  createAiSessionSchema as sharedCreateAiSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  approvePlanSchema,
  pauseAiSchema,
  aiSessionQuerySchema
} from '@breeze/shared/validators/ai';
import { aiActionPlans } from '../db/schema';
import { captureException } from '../services/sentry';
import { getConfig } from '../config/validate';
import { OpenAICompatibleProvider } from '../services/llm/openaiCompatibleProvider';
import { OpenAISessionManager } from '../services/llm/openaiSessionManager';
import { draftTicketFromTranscript, ThinTranscriptError } from '../services/aiTicketDraft';
import { createTicketFromChatSchema, type AiTicketDraft } from '@breeze/shared';
import { deviceInSiteScope } from './tickets/siteScope';
import { timeActorFrom } from './timeEntries/timeEntries';

// Provider check that tolerates an unvalidated config: route unit tests never
// call validateConfig(), and getConfig() throws in that state. Without a
// validated config, behave as the default anthropic path. Production always
// validates at boot, so this never masks a misconfiguration there.
function isOpenAICompatibleProvider(): boolean {
  try {
    return isOpenAICompatibleProvider();
  } catch {
    return false;
  }
}

// Lazy singleton for the openai-compatible path.
// Only constructed on first use when MCP_LLM_PROVIDER=openai-compatible.
let _openaiSessionManager: OpenAISessionManager | null = null;
function getOpenAISessionManager(): OpenAISessionManager {
  if (!_openaiSessionManager) {
    const cfg = getConfig();
    if (!cfg.MCP_LLM_BASE_URL) {
      // Should be caught at startup by the superRefine cross-field validation,
      // but guard here in case getConfig() is called before validateConfig().
      throw new Error('MCP_LLM_BASE_URL is required when MCP_LLM_PROVIDER is openai-compatible');
    }
    if (
      cfg.MCP_LLM_PROVIDER === 'openai-compatible' &&
      cfg.MCP_LLM_PRICE_INPUT_PER_M_USD === 0 &&
      cfg.MCP_LLM_PRICE_OUTPUT_PER_M_USD === 0
    ) {
      console.warn(
        'MCP_LLM_PROVIDER=openai-compatible but both MCP_LLM_PRICE_*_PER_M_USD are 0: cost tracking and budget enforcement are no-ops on this path.'
      );
    }
    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.MCP_LLM_BASE_URL,
      apiKey: cfg.MCP_LLM_API_KEY!,
      priceInputPerMUsd: cfg.MCP_LLM_PRICE_INPUT_PER_M_USD,
      priceOutputPerMUsd: cfg.MCP_LLM_PRICE_OUTPUT_PER_M_USD,
    });
    _openaiSessionManager = new OpenAISessionManager(provider);
  }
  return _openaiSessionManager;
}

const createAiSessionSchema = sharedCreateAiSessionSchema.extend({
  orgId: z.string().guid().optional(),
  delegantM365ConnectionId: z.string().guid().optional(),
  // Bind the session to a specific device (a "task on this computer"). The
  // device is org-validated in createSession.
  deviceId: z.string().guid().optional(),
  // Let the caller pick the approval posture (e.g. plan-first for open-ended
  // device tasks). Defaults to the column default (per_step) when omitted.
  approvalMode: z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']).optional()
});

/**
 * Derive a short title from the user's first message.
 * Truncates at a word boundary to ≤80 chars and adds ellipsis if needed.
 */
function generateSessionTitle(content: string): string {
  // Strip excess whitespace
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;

  // Truncate at word boundary
  const truncated = cleaned.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

export const aiRoutes = new Hono();
const requireAiRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
// SR5-09: reading OTHER users' AI sessions (the admin audit dashboard) is a
// dedicated, higher-trust capability — NOT organizations:read, which every
// technician/viewer holds and which for ordinary AI routes only ever returns the
// caller's OWN sessions. Gated on ai_sessions:read_all (Org Admin + Partner Admin).
const requireAiSessionsReadAll = requirePermission(
  PERMISSIONS.AI_SESSIONS_READ_ALL.resource,
  PERMISSIONS.AI_SESSIONS_READ_ALL.action,
);
const requireTicketsWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

aiRoutes.use('*', authMiddleware);

// ============================================
// Session CRUD
// ============================================

// POST /sessions - Create a new AI chat session
aiRoutes.post(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', createAiSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const session = await createSession(auth, body);
      writeRouteAudit(c, {
        orgId: session.orgId,
        action: 'ai.session.create',
        resourceType: 'ai_session',
        resourceId: session.id,
        resourceName: body.title
      });
      return c.json(session, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message === 'Organization context required') return c.json({ error: message }, 400);
      if (message === 'Invalid M365 connection') return c.json({ error: message }, 400);
      if (message === 'Invalid device') return c.json({ error: message }, 400);
      if (message === 'Access denied to this organization') return c.json({ error: message }, 403);
      return c.json({ error: message }, 500);
    }
  }
);

// GET /sessions - List user's sessions
aiRoutes.get(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  zValidator('query', aiSessionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const sessions = await listSessions(auth, {
      status: query.status,
      page: (query.page ? parseInt(query.page, 10) : 1) || 1,
      limit: (query.limit ? parseInt(query.limit, 10) : 20) || 20
    });

    return c.json({ data: sessions });
  }
);

// GET /m365-connections - List the caller's active M365 customer connections.
// Returns ONLY id, customerLabel, customerDisplayName — never delegant pointer fields.
aiRoutes.get(
  '/m365-connections',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const rows = await listM365Connections(auth);
    return c.json({ data: rows });
  }
);

// GET /sessions/search - Search past conversations
// NOTE: Must be registered BEFORE /sessions/:id to prevent `:id` from matching "search"
aiRoutes.get(
  '/sessions/search',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.query('q');

    if (!query || query.length < 2) {
      return c.json({ error: 'Search query must be at least 2 characters' }, 400);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 50);
    const results = await searchSessions(auth, query, { limit });
    return c.json({ data: results });
  }
);

// GET /sessions/:id - Get session with messages
aiRoutes.get(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const result = await getSessionMessages(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json(result);
  }
);

// DELETE /sessions/:id - Close a session
aiRoutes.delete(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const closed = await closeSession(sessionId, auth);
    if (!closed) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const manager =
      isOpenAICompatibleProvider()
        ? getOpenAISessionManager()
        : streamingSessionManager;
    manager.remove(sessionId);

    writeRouteAudit(c, {
      orgId: closed.orgId,
      action: 'ai.session.close',
      resourceType: 'ai_session',
      resourceId: sessionId
    });

    return c.json({ success: true });
  }
);

// PATCH /sessions/:id - Update session title
aiRoutes.patch(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', z.object({ title: z.string().min(1).max(255) })),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const { title } = c.req.valid('json');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await db.update(aiSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(aiSessions.id, sessionId));

    return c.json({ success: true, title });
  }
);

// POST /sessions/:id/flag - Flag a conversation
aiRoutes.post(
  '/sessions/:id/flag',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', z.object({ reason: z.string().max(1000).optional() }).optional()),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    // Flagging is a moderation action (paired with the admin-only unflag below),
    // not an owner-only read — keep its existing org-scoped behavior.
    const session = await getSession(sessionId, auth, { allowAnyOwnerInOrg: true });
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const body = c.req.valid('json') ?? {};

    await db
      .update(aiSessions)
      .set({
        flaggedAt: new Date(),
        flaggedBy: auth.user?.id ?? null,
        flagReason: body.reason ?? null,
      })
      .where(eq(aiSessions.id, sessionId));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.session.flag',
      resourceType: 'ai_session',
      resourceId: sessionId,
    });

    return c.json({ success: true });
  }
);

// DELETE /sessions/:id/flag - Unflag a conversation (admin only)
aiRoutes.delete(
  '/sessions/:id/flag',
  requireScope('partner', 'system'),
  requireAiWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    // Admin-only unflag (requireScope partner/system): moderators clear another
    // user's flag, so this is deliberately org-scoped, not owner-bound.
    const session = await getSession(sessionId, auth, { allowAnyOwnerInOrg: true });
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await db
      .update(aiSessions)
      .set({
        flaggedAt: null,
        flaggedBy: null,
        flagReason: null,
      })
      .where(eq(aiSessions.id, sessionId));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.session.unflag',
      resourceType: 'ai_session',
      resourceId: sessionId,
    });

    return c.json({ success: true });
  }
);

// POST /sessions/:id/ticket-draft - Draft a support ticket from an AI conversation
aiRoutes.post(
  '/sessions/:id/ticket-draft',
  requireScope('organization', 'partner', 'system'),
  requireTicketsWrite,
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const loaded = await getSessionMessages(sessionId, auth);
    if (!loaded) return c.json({ error: 'Session not found' }, 404);
    const { session, messages } = loaded;

    const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(session.createdAt).getTime()) / 60000));
    const model = session.model ?? resolveDefaultModel();

    let draft;
    try {
      draft = await draftTicketFromTranscript({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        contextSnapshot: session.contextSnapshot,
        elapsedMinutes,
        model,
      });
    } catch (err) {
      if (err instanceof ThinTranscriptError) return c.json({ error: err.message }, 422);
      console.error('[AI] Ticket draft failed:', err);
      captureException(err);
      return c.json({ error: 'Could not draft a ticket from this conversation' }, 502);
    }

    // Best-effort cost accounting; never fails the request.
    try {
      await recordUsage(sessionId, session.orgId, model, draft.inputTokens, draft.outputTokens, false);
    } catch {
      // non-fatal
    }

    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, session.orgId))
      .limit(1);
    let deviceHostname: string | null = null;
    if (session.deviceId) {
      const [dev] = await db
        .select({ hostname: devices.hostname })
        .from(devices)
        .where(eq(devices.id, session.deviceId))
        .limit(1);
      deviceHostname = dev?.hostname ?? null;
    }

    const payload: AiTicketDraft = {
      subject: draft.subject,
      problemSummary: draft.problemSummary,
      resolutionSummary: draft.resolutionSummary,
      suggestedStatus: draft.wasFixed ? 'resolved' : 'open',
      suggestedTimeMinutes: draft.suggestedTimeMinutes,
      elapsedMinutes,
      orgId: session.orgId,
      orgName: org?.name ?? null,
      deviceId: session.deviceId ?? null,
      deviceHostname,
    };
    return c.json({ data: payload });
  }
);

aiRoutes.post(
  '/sessions/:id/ticket',
  requireScope('organization', 'partner', 'system'),
  requireTicketsWrite,
  zValidator('json', createTicketFromChatSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');

    const session = await getSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // deviceId comes from the session; drop it if a site-restricted caller can't reach the device.
    let deviceId: string | undefined = session.deviceId ?? undefined;
    if (deviceId && !(await deviceInSiteScope(auth, deviceId))) deviceId = undefined;

    const actor = { userId: auth.user.id, name: auth.user.name, email: auth.user.email };

    let ticket;
    try {
      ticket = await createTicket(
        { source: 'ai', orgId: session.orgId, subject: body.subject, description: body.description, deviceId, priority: body.priority },
        actor,
      );
    } catch (err) {
      if (err instanceof TicketServiceError) return c.json({ error: err.message }, err.status ?? 400);
      throw err;
    }

    let resolved = false;
    if (body.status === 'resolved') {
      try {
        await changeTicketStatus(ticket.id, { status: 'resolved' }, { resolutionNote: body.resolutionNote }, actor);
        resolved = true;
      } catch (err) {
        console.error(`[AI] Ticket ${ticket.id} created but resolve failed:`, err);
        captureException(err);
      }
    }

    let timeLogged = false;
    if (body.timeMinutes > 0 && (auth.scope === 'partner' || auth.scope === 'system')) {
      try {
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - body.timeMinutes * 60_000);
        await createTimeEntry(
          { ticketId: ticket.id, startedAt, endedAt, description: 'Logged from AI conversation', isBillable: body.billable },
          timeActorFrom(c),
        );
        timeLogged = true;
      } catch (err) {
        console.error(`[AI] Ticket ${ticket.id} created but time entry failed:`, err);
      }
    }

    writeRouteAudit(c, { orgId: session.orgId, action: 'ai.session.create_ticket', resourceType: 'ticket', resourceId: ticket.id });
    return c.json({ data: ticket, resolved, timeLogged }, 201);
  }
);

// ============================================
// Message Sending (SSE Stream via Streaming Sessions)
// ============================================

// POST /sessions/:id/messages - Send a message and stream the response
aiRoutes.post(
  '/sessions/:id/messages',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', sendAiMessageSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');

    // Pre-flight checks (rate limits, budget, session status, input sanitization)
    const preflight = await runPreFlightChecks(sessionId, body.content, auth, body.pageContext, c);
    if (!preflight.ok) {
      const err = preflight.error;
      if (err === 'Session not found') return c.json({ error: err }, 404);
      if (err.includes('rate limit') || err.includes('Rate limit')) return c.json({ error: err }, 429);
      if (err.includes('budget') || err.includes('Budget')) return c.json({ error: err }, 402);
      if (err.includes('expired')) return c.json({ error: err }, 410);
      return c.json({ error: err }, 400);
    }

    const { session: dbSession, sanitizedContent, systemPrompt, maxBudgetUsd } = preflight;

    // ---- OpenAI-compatible path (chat-only, no tool-calling) ----
    if (isOpenAICompatibleProvider()) {
      const openaiManager = getOpenAISessionManager();
      const openaiSession = openaiManager.getOrCreate(sessionId, dbSession.orgId, auth, c);

      if (!openaiManager.tryTransitionToProcessing(openaiSession)) {
        return c.json({ error: 'A message is already being processed for this session' }, 409);
      }

      writeRouteAudit(c, {
        orgId: dbSession.orgId,
        action: 'ai.message.send',
        resourceType: 'ai_session',
        resourceId: sessionId,
        details: { contentLength: body.content.length },
      });

      try {
        await db.insert(aiMessages).values({
          sessionId,
          role: 'user',
          content: sanitizedContent,
        });
      } catch (err) {
        console.error('[AI/OpenAI] Failed to save user message to DB:', err);
        openaiSession.state = 'idle';
        return c.json({ error: 'Failed to save message' }, 500);
      }

      if (!dbSession.title) {
        const title = generateSessionTitle(sanitizedContent);
        try {
          await db.update(aiSessions).set({ title }).where(eq(aiSessions.id, sessionId));
          openaiSession.eventBus.publish({ type: 'title_updated', title });
        } catch (err) {
          console.error('[AI/OpenAI] Failed to auto-set session title:', err);
        }
      }

      openaiManager.startTurn(openaiSession, dbSession.model, systemPrompt, sanitizedContent);

      const subscriptionId = crypto.randomUUID();
      return streamSSE(c, async (stream) => {
        const events = openaiSession.eventBus.subscribe(subscriptionId);
        try {
          for await (const event of events) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            if (event.type === 'done') break;
          }
        } catch (err) {
          console.error('[AI/OpenAI] Stream error:', err);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'Stream failed' }),
          });
        } finally {
          openaiSession.eventBus.unsubscribe(subscriptionId);
        }
      });
    }
    // ---- End OpenAI-compatible path ----

    // Get or create streaming session
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
      systemPrompt,
      maxBudgetUsd,
    );

    // Concurrent message guard — atomic check-and-set
    if (!streamingSessionManager.tryTransitionToProcessing(activeSession)) {
      return c.json({ error: 'A message is already being processed for this session' }, 409);
    }

    writeRouteAudit(c, {
      orgId: dbSession.orgId,
      action: 'ai.message.send',
      resourceType: 'ai_session',
      resourceId: sessionId,
      details: { contentLength: body.content.length }
    });

    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'user',
        content: sanitizedContent,
      });
    } catch (err) {
      console.error('[AI] Failed to save user message to DB:', err);
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
        console.error('[AI] Failed to auto-set session title:', err);
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
        console.error('[AI] Stream error:', err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Stream failed',
          }),
        });
      } finally {
        activeSession.eventBus.unsubscribe(subscriptionId);
      }
    });
  }
);

// ============================================
// Interrupt
// ============================================

// POST /sessions/:id/interrupt - Interrupt the current AI response
aiRoutes.post(
  '/sessions/:id/interrupt',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    let result: { interrupted: boolean; reason?: string };
    try {
      const manager =
        isOpenAICompatibleProvider()
          ? getOpenAISessionManager()
          : streamingSessionManager;
      result = await manager.interrupt(sessionId);
    } catch (err) {
      console.error('[AI] Interrupt failed:', err);
      return c.json({ error: 'Failed to interrupt session' }, 500);
    }

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.message.interrupt',
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
// Tool Approval
// ============================================

// POST /sessions/:id/approve/:executionId - Approve or reject a tool execution
aiRoutes.post(
  '/sessions/:id/approve/:executionId',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', approveToolSchema),
  async (c) => {
    const auth = c.get('auth');
    const executionId = c.req.param('executionId')!;
    const { approved } = c.req.valid('json');

    // Fetch session first for orgId (auth.orgId is null for partner/system users)
    const sessionId = c.req.param('id')!;
    const approvalSession = await getSession(sessionId, auth);
    if (!approvalSession) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const success = await handleApproval(executionId, approved, auth, sessionId);
    if (!success) {
      // CRITICAL-3 (whole-branch review): a Tier-3 intent-backed execution
      // NEVER reports success here — its real decision lives on
      // action_intents.status, decided via the /approvals surface (mobile
      // push or the Approvals queue), not this self-approve endpoint. Give
      // the web chat client an honest "still pending" response instead of a
      // generic "not found" so it can render a waiting state rather than
      // silently timing out.
      if (await isIntentBackedExecution(executionId)) {
        return c.json({
          success: false,
          pending: true,
          via: 'intent',
          message: 'This action needs approval in the Approvals area or the Breeze mobile app.',
        });
      }
      return c.json({ error: 'Execution not found or already processed' }, 404);
    }

    writeRouteAudit(c, {
      orgId: approvalSession.orgId,
      action: 'ai.tool_approval.update',
      resourceType: 'ai_execution',
      resourceId: executionId,
      details: { approved }
    });

    return c.json({ success: true, approved });
  }
);

// ============================================
// Pause AI (auto_approve → per_step fallback)
// ============================================

aiRoutes.post(
  '/sessions/:id/pause',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', pauseAiSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const { paused } = c.req.valid('json');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    if (isOpenAICompatibleProvider()) {
      return c.json(
        {
          error: 'This operation is not supported when using the OpenAI-compatible provider.',
          code: 'NOT_SUPPORTED_ON_PROVIDER',
        },
        501,
      );
    }

    const activeSession = streamingSessionManager.get(sessionId);
    if (!activeSession) {
      return c.json({ error: 'Session not active in memory' }, 404);
    }

    activeSession.isPaused = paused;

    // If pausing while a plan is active, abort it
    if (paused && activeSession.activePlanId) {
      await abortActivePlan(activeSession);
    }

    const effectiveMode = paused ? 'per_step' : activeSession.approvalMode;
    activeSession.eventBus.publish({ type: 'approval_mode_changed', mode: effectiveMode });

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.session.pause',
      resourceType: 'ai_session',
      resourceId: sessionId,
      details: { paused, effectiveMode },
    });

    return c.json({ success: true, paused, effectiveMode });
  }
);

// ============================================
// Plan Approval
// ============================================

aiRoutes.post(
  '/sessions/:id/approve-plan',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', approvePlanSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const { approved } = c.req.valid('json');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    if (isOpenAICompatibleProvider()) {
      return c.json(
        {
          error: 'This operation is not supported when using the OpenAI-compatible provider.',
          code: 'NOT_SUPPORTED_ON_PROVIDER',
        },
        501,
      );
    }

    const activeSession = streamingSessionManager.get(sessionId);
    if (!activeSession) {
      return c.json({ error: 'Session not active in memory' }, 404);
    }

    if (!activeSession.planApprovalResolver) {
      return c.json({ error: 'No pending plan approval' }, 400);
    }

    // Resolve the in-memory promise
    activeSession.planApprovalResolver(approved);
    activeSession.planApprovalResolver = null;

    // Update DB plan record
    if (activeSession.activePlanId || !approved) {
      try {
        const planId = activeSession.activePlanId;
        if (planId) {
          await db.update(aiActionPlans)
            .set({
              status: approved ? 'approved' : 'rejected',
              approvedBy: auth.user.id,
              approvedAt: new Date(),
            })
            .where(eq(aiActionPlans.id, planId));
        }
      } catch (err) {
        console.error('[AI] Failed to update plan status:', err);
        captureException(err);
        return c.json({ success: true, approved, warning: 'Plan processed but database record could not be updated.' });
      }
    }

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.plan_approval.update',
      resourceType: 'ai_action_plan',
      resourceId: activeSession.activePlanId ?? sessionId,
      details: { approved },
    });

    return c.json({ success: true, approved });
  }
);

// ============================================
// Plan Abort
// ============================================

aiRoutes.post(
  '/sessions/:id/abort-plan',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    if (isOpenAICompatibleProvider()) {
      return c.json(
        {
          error: 'This operation is not supported when using the OpenAI-compatible provider.',
          code: 'NOT_SUPPORTED_ON_PROVIDER',
        },
        501,
      );
    }

    const activeSession = streamingSessionManager.get(sessionId);
    if (!activeSession) {
      return c.json({ error: 'Session not active in memory' }, 404);
    }

    const planId = activeSession.activePlanId;
    if (!planId) {
      return c.json({ error: 'No active plan to abort' }, 400);
    }

    const aborted = await abortActivePlan(activeSession);

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'ai.plan.abort',
      resourceType: 'ai_action_plan',
      resourceId: planId,
    });

    return c.json({ success: aborted });
  }
);

// ============================================
// Usage & Budget
// ============================================

// GET /usage - Get AI usage and budget for the org
aiRoutes.get(
  '/usage',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      // System/partner users without a specific org — return zero usage
      return c.json({
        daily: { inputTokens: 0, outputTokens: 0, totalCostCents: 0, messageCount: 0 },
        monthly: { inputTokens: 0, outputTokens: 0, totalCostCents: 0, messageCount: 0 },
        budget: null
      });
    }

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const usage = await getUsageSummary(orgId);
    return c.json(usage);
  }
);

// PUT /budget - Update AI budget settings for the org
aiRoutes.put(
  '/budget',
  requireScope('organization', 'partner', 'system'),
  requireAiWrite,
  requireMfa(),
  zValidator('json', z.object({
    enabled: z.boolean().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    maxTurnsPerSession: z.number().int().min(1).max(200).optional(),
    messagesPerMinutePerUser: z.number().int().min(1).max(100).optional(),
    messagesPerHourPerOrg: z.number().int().min(1).max(10000).optional(),
    approvalMode: z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']).optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;
    if (!orgId) return c.json({ error: 'Organization context required' }, 400);

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const body = c.req.valid('json');

    // Enforce partner locks on AI budget fields
    const budgetFields = Object.keys(body);
    if (budgetFields.length > 0) {
      await assertNotLocked(orgId, 'aiBudgets', budgetFields);
    }

    await updateBudget(orgId, body);

    writeRouteAudit(c, {
      orgId,
      action: 'ai.budget.update',
      resourceType: 'ai_budget'
    });

    return c.json({ success: true });
  }
);

// GET /admin/sessions - Get session history for admin dashboard.
// SR5-09: enumerates other users' sessions (id, userId, title, cost, flags), so
// it requires ai_sessions:read_all — a stricter gate than the ordinary AI reads.
// The returned rows are already a projected metadata DTO (getSessionHistory):
// no systemPrompt, contextSnapshot, sdkSessionId, or raw tool input/output.
aiRoutes.get(
  '/admin/sessions',
  requireScope('organization', 'partner', 'system'),
  requireAiSessionsReadAll,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      return c.json({ data: [] });
    }

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
    const flagged = c.req.query('flagged') === 'true' ? true : undefined;

    const sessions = await getSessionHistory(orgId, { limit, offset, flagged });
    return c.json({ data: sessions });
  }
);

// GET /admin/security-events - Get AI security and tool audit events
aiRoutes.get(
  '/admin/security-events',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      return c.json({ data: [] });
    }

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
    const sinceParam = c.req.query('since');
    const actionFilter = c.req.query('action');

    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days

    const conditions = [
      eq(auditLogs.orgId, orgId),
      gte(auditLogs.timestamp, since),
      drizzleSql`(${auditLogs.action} LIKE 'ai.security.%' OR ${auditLogs.action} LIKE 'ai.tool.%')`,
    ];

    if (actionFilter) {
      conditions.push(eq(auditLogs.action, actionFilter));
    }

    const events = await db
      .select({
        id: auditLogs.id,
        timestamp: auditLogs.timestamp,
        actorType: auditLogs.actorType,
        actorEmail: auditLogs.actorEmail,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        result: auditLogs.result,
        errorMessage: auditLogs.errorMessage,
        details: auditLogs.details,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit);

    return c.json({ data: events });
  }
);

// GET /admin/tool-executions - Get tool execution analytics for AI risk dashboard
aiRoutes.get(
  '/admin/tool-executions',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      // Partner/system users without a specific org — return empty analytics
      return c.json({
        summary: { total: 0, byStatus: {}, byTool: [] },
        timeSeries: [],
        executions: [],
      });
    }

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 200);
    const sinceParam = c.req.query('since');
    const untilParam = c.req.query('until');
    const statusFilter = c.req.query('status');
    const toolNameFilter = c.req.query('toolName');

    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const until = untilParam ? new Date(untilParam) : new Date();

    if (isNaN(since.getTime())) {
      return c.json({ error: `Invalid 'since' date: ${sinceParam}` }, 400);
    }
    if (isNaN(until.getTime())) {
      return c.json({ error: `Invalid 'until' date: ${untilParam}` }, 400);
    }

    // Base conditions: org-scoped via session join + date range
    const baseConditions = [
      eq(aiSessions.orgId, orgId),
      gte(aiToolExecutions.createdAt, since),
      lte(aiToolExecutions.createdAt, until),
    ];
    if (statusFilter) {
      baseConditions.push(drizzleSql`${aiToolExecutions.status} = ${statusFilter}`);
    }
    if (toolNameFilter) {
      baseConditions.push(eq(aiToolExecutions.toolName, toolNameFilter));
    }

    // 1. Status counts
    const statusCounts = await db
      .select({
        status: aiToolExecutions.status,
        count: count(),
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .where(and(...baseConditions))
      .groupBy(aiToolExecutions.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of statusCounts) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    // 2. Per-tool stats
    const toolStats = await db
      .select({
        toolName: aiToolExecutions.toolName,
        count: count(),
        avgDurationMs: avg(aiToolExecutions.durationMs),
        completedCount: drizzleSql<number>`COUNT(*) FILTER (WHERE ${aiToolExecutions.status} = 'completed')`,
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .where(and(...baseConditions))
      .groupBy(aiToolExecutions.toolName)
      .orderBy(drizzleSql`COUNT(*) DESC`);

    const byTool = toolStats.map((row) => ({
      toolName: row.toolName,
      count: Number(row.count),
      avgDurationMs: row.avgDurationMs ? Math.round(Number(row.avgDurationMs)) : null,
      successRate: Number(row.count) > 0 ? Number(row.completedCount) / Number(row.count) : 0,
    }));

    // 3. Daily time series
    const timeSeries = await db
      .select({
        date: drizzleSql<string>`DATE(${aiToolExecutions.createdAt})::text`,
        completed: drizzleSql<number>`COUNT(*) FILTER (WHERE ${aiToolExecutions.status} = 'completed')`,
        failed: drizzleSql<number>`COUNT(*) FILTER (WHERE ${aiToolExecutions.status} = 'failed')`,
        rejected: drizzleSql<number>`COUNT(*) FILTER (WHERE ${aiToolExecutions.status} = 'rejected')`,
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .where(and(...baseConditions))
      .groupBy(drizzleSql`DATE(${aiToolExecutions.createdAt})`)
      .orderBy(drizzleSql`DATE(${aiToolExecutions.createdAt}) ASC`);

    // 4. Raw executions list
    const executions = await db
      .select({
        id: aiToolExecutions.id,
        sessionId: aiToolExecutions.sessionId,
        toolName: aiToolExecutions.toolName,
        status: aiToolExecutions.status,
        toolInput: aiToolExecutions.toolInput,
        approvedBy: aiToolExecutions.approvedBy,
        approvedAt: aiToolExecutions.approvedAt,
        durationMs: aiToolExecutions.durationMs,
        errorMessage: aiToolExecutions.errorMessage,
        createdAt: aiToolExecutions.createdAt,
        completedAt: aiToolExecutions.completedAt,
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .where(and(...baseConditions))
      .orderBy(desc(aiToolExecutions.createdAt))
      .limit(limit);

    return c.json({
      summary: { total, byStatus, byTool },
      timeSeries: timeSeries.map((row) => ({
        date: row.date,
        completed: Number(row.completed),
        failed: Number(row.failed),
        rejected: Number(row.rejected),
      })),
      executions,
    });
  }
);
