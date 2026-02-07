/**
 * AI Chat Routes
 *
 * REST + SSE endpoints for the AI chat sidebar.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { authMiddleware, requireScope } from '../middleware/auth';
import {
  createSession,
  listSessions,
  closeSession,
  getSessionMessages,
  sendMessage,
  handleApproval,
  searchSessions
} from '../services/aiAgent';
import { getUsageSummary, updateBudget, getSessionHistory } from '../services/aiCostTracker';
import { writeRouteAudit } from '../services/auditEvents';
import { db } from '../db';
import { auditLogs } from '../db/schema';
import { eq, and, desc, gte, sql as drizzleSql } from 'drizzle-orm';

// Inline validators (avoid rootDir issues with @breeze/shared)
const aiPageContextSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('device'), id: z.string().uuid(), hostname: z.string(), os: z.string().optional(), status: z.string().optional(), ip: z.string().optional() }),
  z.object({ type: z.literal('alert'), id: z.string().uuid(), title: z.string(), severity: z.string().optional(), deviceHostname: z.string().optional() }),
  z.object({ type: z.literal('dashboard'), orgName: z.string().optional(), deviceCount: z.number().optional(), alertCount: z.number().optional() }),
  z.object({ type: z.literal('custom'), label: z.string(), data: z.record(z.unknown()) })
]);

const createAiSessionSchema = z.object({
  pageContext: aiPageContextSchema.optional(),
  model: z.string().max(100).optional(),
  title: z.string().max(255).optional(),
  orgId: z.string().uuid().optional()
});

const sendAiMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  pageContext: aiPageContextSchema.optional()
});

const approveToolSchema = z.object({
  approved: z.boolean()
});

const aiSessionQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'closed', 'expired']).optional()
});

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

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'ai.session.close',
      resourceType: 'ai_session',
      resourceId: sessionId
    });

    return c.json({ success: true });
  }
);

// ============================================
// Message Sending (SSE Stream)
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

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'ai.message.send',
      resourceType: 'ai_session',
      resourceId: sessionId,
      details: { contentLength: body.content.length }
    });

    return streamSSE(c, async (stream) => {
      try {
        const generator = sendMessage(sessionId, body.content, auth, body.pageContext, c);

        for await (const event of generator) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event)
          });
        }
      } catch (err) {
        console.error('[AI] Stream error:', err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Stream failed'
          })
        });
      }
    });
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

    const success = await handleApproval(executionId, approved, auth);
    if (!success) {
      return c.json({ error: 'Execution not found or already processed' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
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
    if (!orgId) return c.json({ error: 'Organization context required' }, 400);

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
    if (!orgId) return c.json({ error: 'Organization context required' }, 400);

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
