import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { aiSessions, aiMessages, aiToolExecutions } from '../../db/schema';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from '../c2c/helpers';
import { CLIENT_SESSION_TYPES } from '../../services/clientAiHosts';
import { adminSessionListQuerySchema, flagSessionSchema } from './schemas';

/**
 * AI for Office — client-session audit viewer endpoints (spec §9.3).
 * Client sessions ONLY (every `${host}_client` type — excel/word/…); technician
 * sessions stay on /ai/admin/*.
 *
 * Flag/unflag mirrors the technician handlers (routes/ai.ts:285-360) — those
 * are inline db.updates with no shared service, so there is nothing to call
 * (Plan-4 decision 2). Same MFA gate, audit actions namespaced client_ai.*.
 *
 * Redaction badges (Plan-4 decision 3): ai_messages stores the redacted form
 * (spec §6 "redact before logging"), so redaction-event metadata is DERIVED
 * by counting [REDACTED:type] markers — no dependency on a Plan-3 metadata
 * format that does not exist yet.
 */

export const clientAiAdminSessionRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

export const REDACTION_MARKER_REGEX = /\[REDACTED:([A-Za-z0-9_-]+)\]/g;

export function countRedactions(text: string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!text) return counts;
  for (const match of text.matchAll(REDACTION_MARKER_REGEX)) {
    const key = match[1]!;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

type SessionAuth = {
  canAccessOrg?: (orgId: string) => boolean;
  user?: { id: string };
};

const sessionSelection = {
  id: aiSessions.id,
  orgId: aiSessions.orgId,
  orgName: organizations.name,
  clientUserId: aiSessions.clientUserId,
  userEmail: portalUsers.email,
  title: aiSessions.title,
  model: aiSessions.model,
  status: aiSessions.status,
  turnCount: aiSessions.turnCount,
  totalCostCents: aiSessions.totalCostCents,
  totalInputTokens: aiSessions.totalInputTokens,
  totalOutputTokens: aiSessions.totalOutputTokens,
  flaggedAt: aiSessions.flaggedAt,
  flaggedBy: aiSessions.flaggedBy,
  flagReason: aiSessions.flagReason,
  createdAt: aiSessions.createdAt,
  lastActivityAt: aiSessions.lastActivityAt,
};

// ── GET /sessions — filtered, paginated list ─────────────────────────────────
clientAiAdminSessionRoutes.get(
  '/sessions',
  requireOrgsRead,
  zValidator('query', adminSessionListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');

    const conditions: SQL[] = [inArray(aiSessions.type, CLIENT_SESSION_TYPES)];
    if (q.orgId) {
      const orgId = resolveScopedOrgId(auth, q.orgId);
      if (!orgId) return c.json({ error: 'Organization not found' }, 404);
      conditions.push(eq(aiSessions.orgId, orgId));
    } else {
      // Defense-in-depth: with no specific org requested, restrict the list to the
      // caller's accessible orgs at the app layer so it agrees with forced RLS
      // (system scope → undefined → unfiltered). Mirrors the org-list endpoint.
      const scope = auth.orgCondition?.(aiSessions.orgId);
      if (scope) conditions.push(scope);
    }
    if (q.clientUserId) conditions.push(eq(aiSessions.clientUserId, q.clientUserId));
    if (q.from) conditions.push(gte(aiSessions.createdAt, new Date(q.from)));
    if (q.to) conditions.push(lte(aiSessions.createdAt, new Date(q.to)));
    if (q.flagged === 'true') conditions.push(isNotNull(aiSessions.flaggedAt));
    if (q.flagged === 'false') conditions.push(isNull(aiSessions.flaggedAt));

    const where = and(...conditions);

    const rows = await db
      .select(sessionSelection)
      .from(aiSessions)
      .leftJoin(organizations, eq(aiSessions.orgId, organizations.id))
      .leftJoin(portalUsers, eq(aiSessions.clientUserId, portalUsers.id))
      .where(where)
      .orderBy(desc(aiSessions.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    const [totalRow] = await db.select({ n: count() }).from(aiSessions).where(where);

    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        orgName: r.orgName ?? null,
        clientUserId: r.clientUserId,
        userEmail: r.userEmail ?? null,
        title: r.title,
        startedAt: r.createdAt,
        lastActivityAt: r.lastActivityAt,
        turnCount: r.turnCount,
        totalCostCents: r.totalCostCents,
        flaggedAt: r.flaggedAt,
        flagReason: r.flagReason,
        status: r.status,
      })),
      pagination: { total: Number(totalRow?.n ?? 0), limit: q.limit, offset: q.offset },
    });
  }
);

/** Fetch one client session (any host) the caller can access, else null. */
async function getClientSession(auth: SessionAuth, sessionId: string) {
  const [row] = await db
    .select(sessionSelection)
    .from(aiSessions)
    .leftJoin(organizations, eq(aiSessions.orgId, organizations.id))
    .leftJoin(portalUsers, eq(aiSessions.clientUserId, portalUsers.id))
    .where(and(eq(aiSessions.id, sessionId), inArray(aiSessions.type, CLIENT_SESSION_TYPES)))
    .limit(1);
  if (!row) return null;
  // RLS already scopes the SELECT; this is the belt-and-braces app-layer
  // check the technician routes also perform via getSession(sessionId, auth).
  if (auth.canAccessOrg && !auth.canAccessOrg(row.orgId)) return null;
  return row;
}

// ── GET /sessions/:id — full transcript ──────────────────────────────────────
clientAiAdminSessionRoutes.get('/sessions/:id', requireOrgsRead, async (c) => {
  const auth = c.get('auth') as SessionAuth;
  const session = await getClientSession(auth, c.req.param('id')!);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const messages = await db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      contentBlocks: aiMessages.contentBlocks,
      toolName: aiMessages.toolName,
      toolInput: aiMessages.toolInput,
      toolOutput: aiMessages.toolOutput,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, session.id))
    .orderBy(asc(aiMessages.createdAt));

  const toolExecutions = await db
    .select({
      id: aiToolExecutions.id,
      toolName: aiToolExecutions.toolName,
      toolInput: aiToolExecutions.toolInput,
      status: aiToolExecutions.status,
      approvedBy: aiToolExecutions.approvedBy,
      approvedAt: aiToolExecutions.approvedAt,
      errorMessage: aiToolExecutions.errorMessage,
      durationMs: aiToolExecutions.durationMs,
      createdAt: aiToolExecutions.createdAt,
      completedAt: aiToolExecutions.completedAt,
    })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.sessionId, session.id))
    .orderBy(asc(aiToolExecutions.createdAt));

  return c.json({
    session,
    messages: messages.map((m) => ({ ...m, redactionCounts: countRedactions(m.content) })),
    toolExecutions,
  });
});

// ── POST /sessions/:id/flag ───────────────────────────────────────────────────
clientAiAdminSessionRoutes.post(
  '/sessions/:id/flag',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as SessionAuth;
    const session = await getClientSession(auth, c.req.param('id')!);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // The body is optional (mirrors the technician route — Plan-4 decision 2).
    // Parse defensively: a flag POST may carry no JSON body at all, which
    // zValidator('json') would reject with 400 on this Hono version (the
    // technician test always sends a body, so it never hit this). Tolerate a
    // missing/empty body, then validate the shape with flagSessionSchema so
    // the `reason` length contract still holds.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const parsed = flagSessionSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
    const body = parsed.data ?? {};

    await db
      .update(aiSessions)
      .set({
        flaggedAt: new Date(),
        flaggedBy: auth.user?.id ?? null,
        flagReason: body.reason ?? null,
      })
      .where(eq(aiSessions.id, session.id));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'client_ai.session.flag',
      resourceType: 'ai_session',
      resourceId: session.id,
      details: { reason: body.reason ?? null },
    });

    return c.json({ success: true });
  }
);

// ── DELETE /sessions/:id/flag ─────────────────────────────────────────────────
clientAiAdminSessionRoutes.delete(
  '/sessions/:id/flag',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as SessionAuth;
    const session = await getClientSession(auth, c.req.param('id')!);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    await db
      .update(aiSessions)
      .set({ flaggedAt: null, flaggedBy: null, flagReason: null })
      .where(eq(aiSessions.id, session.id));

    writeRouteAudit(c, {
      orgId: session.orgId,
      action: 'client_ai.session.unflag',
      resourceType: 'ai_session',
      resourceId: session.id,
    });

    return c.json({ success: true });
  }
);
