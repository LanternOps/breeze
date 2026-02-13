/**
 * AI Chat Routes
 *
 * REST + SSE endpoints for the AI chat sidebar.
 * Uses streaming input mode via StreamingSessionManager for persistent sessions.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { authMiddleware, requireScope } from '../middleware/auth';
import {
  createSession,
  getSession,
  listSessions,
  closeSession,
  getSessionMessages,
  handleApproval,
  searchSessions
} from '../services/aiAgent';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { getUsageSummary, updateBudget, getSessionHistory } from '../services/aiCostTracker';
import { writeRouteAudit } from '../services/auditEvents';
import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions, auditLogs } from '../db/schema';
import { eq, and, desc, gte, count, avg, sql as drizzleSql } from 'drizzle-orm';
import {
  createAiSessionSchema as sharedCreateAiSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  aiSessionQuerySchema
} from '@breeze/shared/validators/ai';

const createAiSessionSchema = sharedCreateAiSessionSchema.extend({
  orgId: z.string().uuid().optional()
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

aiRoutes.use('*', authMiddleware);

// ============================================
// Session CRUD
// ============================================

// POST /sessions - Create a new AI chat session
aiRoutes.post(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
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
      if (message === 'Access denied to this organization') return c.json({ error: message }, 403);
      return c.json({ error: message }, 500);
    }
  }
);

// GET /sessions - List user's sessions
aiRoutes.get(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
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

// GET /sessions/search - Search past conversations
// NOTE: Must be registered BEFORE /sessions/:id to prevent `:id` from matching "search"
aiRoutes.get(
  '/sessions/search',
  requireScope('organization', 'partner', 'system'),
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
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

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
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const closed = await closeSession(sessionId, auth);
    if (!closed) {
      return c.json({ error: 'Session not found' }, 404);
    }

    streamingSessionManager.remove(sessionId);

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
  zValidator('json', z.object({ title: z.string().min(1).max(255) })),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
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

// ============================================
// Message Sending (SSE Stream via Streaming Sessions)
// ============================================

// POST /sessions/:id/messages - Send a message and stream the response
aiRoutes.post(
  '/sessions/:id/messages',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', sendAiMessageSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
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
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    let result: { interrupted: boolean; reason?: string };
    try {
      result = await streamingSessionManager.interrupt(sessionId);
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
  zValidator('json', approveToolSchema),
  async (c) => {
    const auth = c.get('auth');
    const executionId = c.req.param('executionId');
    const { approved } = c.req.valid('json');

    // Fetch session first for orgId (auth.orgId is null for partner/system users)
    const sessionId = c.req.param('id');
    const approvalSession = await getSession(sessionId, auth);
    if (!approvalSession) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const success = await handleApproval(executionId, approved, auth);
    if (!success) {
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
// Usage & Budget
// ============================================

// GET /usage - Get AI usage and budget for the org
aiRoutes.get(
  '/usage',
  requireScope('organization', 'partner', 'system'),
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
  zValidator('json', z.object({
    enabled: z.boolean().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    maxTurnsPerSession: z.number().int().min(1).max(200).optional(),
    messagesPerMinutePerUser: z.number().int().min(1).max(100).optional(),
    messagesPerHourPerOrg: z.number().int().min(1).max(10000).optional()
  })),
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;
    if (!orgId) return c.json({ error: 'Organization context required' }, 400);

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const body = c.req.valid('json');
    await updateBudget(orgId, body);

    writeRouteAudit(c, {
      orgId,
      action: 'ai.budget.update',
      resourceType: 'ai_budget'
    });

    return c.json({ success: true });
  }
);

// GET /admin/sessions - Get session history for admin dashboard
aiRoutes.get(
  '/admin/sessions',
  requireScope('organization', 'partner', 'system'),
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

    const sessions = await getSessionHistory(orgId, { limit, offset });
    return c.json({ data: sessions });
  }
);

// GET /admin/security-events - Get AI security and tool audit events
aiRoutes.get(
  '/admin/security-events',
  requireScope('organization', 'partner', 'system'),
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
      drizzleSql`${aiToolExecutions.createdAt} <= ${until}`,
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
