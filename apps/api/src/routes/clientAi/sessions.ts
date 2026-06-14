/**
 * AI for Office — /client-ai/sessions/* (spec §4, §5, §8).
 *
 * All routes run behind Plan 1's clientAiAuthMiddleware (bearer session →
 * org-scoped DB context) + requireClientAiEnabledMiddleware (per-request
 * enabled/selected-user policy gate, policy on c.get('clientAiPolicy')).
 *
 * Access rule on every session route: the ai_sessions row must match BOTH
 * auth.clientUserId and auth.orgId (and type='excel_client') — enforced by
 * loadClientSession's WHERE in addition to RLS.
 *
 * Audit actor convention (Plan 1's exchange route): actorType 'user',
 * actorId = portal_users.id, details.principalType 'portal_user'.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { aiMessages, aiSessions } from '../../db/schema';
import {
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
} from '../../middleware/clientAiAuth';
import {
  streamingSessionManager,
  type ActiveSession,
} from '../../services/streamingSessionManager';
import { writeAuditEvent } from '../../services/auditEvents';
import { checkBillingCredits } from '../../services/aiCostTracker';
import {
  checkClientBudget,
  getRemainingClientBudgetUsd,
  recordClientUsage,
} from '../../services/clientAiUsage';
import {
  DEFAULT_CLIENT_AI_MODEL,
  buildClientAuthContext,
  buildExcelClientSystemPrompt,
  checkClientRateLimits,
  generateClientSessionTitle,
} from '../../services/clientAiSessions';
import { applyDlp, type DlpRedactionEvent } from '../../services/clientAiDlp';
import {
  CLIENT_MCP_SERVER_NAME,
  clientMcpToolNamesForWriteMode,
  createClientWorkbookMcpServer,
} from '../../services/clientAiTools';
import { failPendingForSession, resolveClientToolResult } from '../../services/clientAiToolBridge';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';
import {
  clientToolResultSchema,
  flagSessionSchema,
  sendClientMessageSchema,
  type ClientAiAuthContext,
} from './schemas';
import { CLIENT_AI_SSE_PING_INTERVAL_MS, toClientSseEvent } from './sse';

export const clientAiSessionRoutes = new Hono();

clientAiSessionRoutes.use('*', clientAiAuthMiddleware);
clientAiSessionRoutes.use('*', requireClientAiEnabledMiddleware);

type ClientSessionRow = typeof aiSessions.$inferSelect;

/** The per-route access check: id + type + client principal + org, all in the WHERE. */
async function loadClientSession(
  sessionId: string,
  auth: ClientAiAuthContext,
): Promise<ClientSessionRow | null> {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(
      and(
        eq(aiSessions.id, sessionId),
        eq(aiSessions.type, 'excel_client'),
        eq(aiSessions.clientUserId, auth.clientUserId),
        eq(aiSessions.orgId, auth.orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function auditClient(
  c: Context,
  auth: ClientAiAuthContext,
  event: {
    action: string;
    resourceId?: string | null;
    result?: 'success' | 'denied';
    details?: Record<string, unknown>;
  },
): void {
  writeAuditEvent(c, {
    orgId: auth.orgId,
    action: event.action,
    resourceType: 'ai_session',
    resourceId: event.resourceId ?? null,
    actorType: 'user',
    actorId: auth.clientUserId,
    actorEmail: auth.email,
    result: event.result ?? 'success',
    details: { principalType: 'portal_user', ...(event.details ?? {}) },
  });
}

/** Shared preflight (spec §4 order): rate limits → org budget → partner credits. */
async function runClientPreflight(
  c: Context,
  auth: ClientAiAuthContext,
  policy: ClientAiOrgPolicy,
): Promise<Response | null> {
  const rateError = await checkClientRateLimits(auth.clientUserId, auth.orgId, policy);
  if (rateError) return c.json({ error: rateError }, 429);

  const budgetError = await checkClientBudget(policy);
  if (budgetError) return c.json({ error: budgetError }, 402);

  const creditError = await checkBillingCredits(auth.orgId);
  if (creditError) return c.json({ error: creditError }, 402);

  return null;
}

/**
 * Get-or-create the in-memory SDK session for a client DB session: synthetic
 * org-pinned auth, the workbook-only MCP server (scriptAi.ts:211-215 factory
 * pattern), write-mode-filtered SDK toolset, remaining-budget hard stop, no
 * technician approval-mode prompt injection — then refresh the per-message
 * client fields the tool handlers read.
 */
async function ensureActiveClientSession(
  c: Context,
  sessionRow: ClientSessionRow,
  auth: ClientAiAuthContext,
  policy: ClientAiOrgPolicy,
): Promise<ActiveSession> {
  const maxBudgetUsd = await getRemainingClientBudgetUsd(policy);

  const active = await streamingSessionManager.getOrCreate(
    sessionRow.id,
    {
      orgId: sessionRow.orgId,
      sdkSessionId: sessionRow.sdkSessionId,
      model: sessionRow.model,
      maxTurns: sessionRow.maxTurns,
      turnCount: sessionRow.turnCount,
      systemPrompt: sessionRow.systemPrompt,
    },
    buildClientAuthContext({
      clientUserId: auth.clientUserId,
      orgId: auth.orgId,
      email: auth.email,
      name: auth.name,
    }),
    c,
    sessionRow.systemPrompt ?? buildExcelClientSystemPrompt(policy.writeMode),
    maxBudgetUsd,
    clientMcpToolNamesForWriteMode(policy.writeMode),
    (_getAuth, _onPreToolUse, _onPostToolUse, getSession) => ({
      // The technician pre/post callbacks are deliberately unused: they reject
      // tools absent from TOOL_TIERS (aiAgentSdk.ts:222-225) and encode
      // technician persistence. Client handlers own their pipeline.
      server: createClientWorkbookMcpServer(getSession),
      name: CLIENT_MCP_SERVER_NAME,
    }),
    { injectApprovalModeInstructions: false },
  );

  // Refresh per-message client state read by the tool handlers and the result hook.
  active.clientWriteMode = policy.writeMode;
  active.clientDlpConfig = policy.dlpConfig;
  const { orgId, clientUserId } = auth;
  active.recordExtraUsage = (usage) =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      () =>
        recordClientUsage(orgId, clientUserId, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costCents: usage.costCents,
          messageCount: 1,
        }),
    );

  return active;
}

// ============================================
// POST / — create a session (spec §4 pre-flight at create)
// ============================================

clientAiSessionRoutes.post('/', async (c) => {
  const auth = c.get('clientAiAuth');
  const policy = c.get('clientAiPolicy');

  const rejection = await runClientPreflight(c, auth, policy);
  if (rejection) return rejection;

  const model = policy.allowedModels[0] ?? DEFAULT_CLIENT_AI_MODEL;
  const systemPrompt = buildExcelClientSystemPrompt(policy.writeMode);

  const [session] = await db
    .insert(aiSessions)
    .values({
      orgId: auth.orgId,
      userId: null,
      clientUserId: auth.clientUserId,
      type: 'excel_client',
      model,
      systemPrompt,
    })
    .returning({ id: aiSessions.id });

  if (!session) {
    return c.json({ error: 'Failed to create session' }, 500);
  }

  await recordClientUsage(auth.orgId, auth.clientUserId, { sessionCount: 1 });

  auditClient(c, auth, {
    action: 'ai.client_session.create',
    resourceId: session.id,
    details: { model, writeMode: policy.writeMode, writeApproval: policy.writeApproval },
  });

  // Expose the effective write governance so the pane can render the Auto/Ask
  // toggle. writeApproval is the server-side gate: 'ask' means the toggle is
  // hidden and auto-apply is impossible regardless of what the pane requests.
  return c.json(
    {
      sessionId: session.id,
      writeMode: policy.writeMode,
      writeApproval: policy.writeApproval,
    },
    201,
  );
});

// ============================================
// GET /:id — session + (already-redacted) message history
// ============================================

clientAiSessionRoutes.get('/:id', async (c) => {
  const auth = c.get('clientAiAuth');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Messages were persisted in redacted form (spec §6) — return them as-is.
  const messages = await db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      contentBlocks: aiMessages.contentBlocks,
      toolName: aiMessages.toolName,
      toolInput: aiMessages.toolInput,
      toolOutput: aiMessages.toolOutput,
      toolUseId: aiMessages.toolUseId,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(asc(aiMessages.createdAt))
    .limit(500);

  return c.json({
    session: {
      id: session.id,
      status: session.status,
      title: session.title,
      model: session.model,
      turnCount: session.turnCount,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCostCents: session.totalCostCents,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    },
    messages,
  });
});

// ============================================
// POST /:id/close
// ============================================

clientAiSessionRoutes.post('/:id/close', async (c) => {
  const auth = c.get('clientAiAuth');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Resolve any parked tool requests first so the SDK loop unblocks, then
  // tear down the in-memory session, then mark the row closed.
  failPendingForSession(sessionId, 'session_closed');
  streamingSessionManager.remove(sessionId);

  await db
    .update(aiSessions)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(aiSessions.id, sessionId));

  auditClient(c, auth, { action: 'ai.client_session.close', resourceId: sessionId });

  return c.json({ success: true });
});

// ============================================
// POST /:id/flag — the END USER flags their own conversation for review.
//
// Mirrors the admin flag (routes/clientAi/adminSessions.ts) but runs on the
// portal-session path: the actor is the portal user, so flagged_by (which FKs
// users.id) is left NULL; the flag_reason carries the end user's note. Admins
// see it via the SessionsTab "Flagged only" filter (already wired).
// ============================================

clientAiSessionRoutes.post('/:id/flag', async (c) => {
  const auth = c.get('clientAiAuth');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // The body is optional (a flag may carry no reason at all). Parse defensively:
  // a missing/empty body must not 400, then validate the shape so the reason
  // length contract holds (mirrors the admin flag route).
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = undefined;
  }
  const parsed = flagSessionSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const reason = parsed.data?.reason ?? null;

  await db
    .update(aiSessions)
    .set({ flaggedAt: new Date(), flaggedBy: null, flagReason: reason })
    .where(eq(aiSessions.id, sessionId));

  auditClient(c, auth, {
    action: 'ai.client_session.flag',
    resourceId: sessionId,
    details: { reason },
  });

  return c.json({ success: true });
});

// ============================================
// POST /:id/messages — message ingress (spec §4 pre-flight per message;
// DLP chokepoint (a) + workbookContext cells; redact-before-log)
// ============================================

function dlpBlockedResponse(
  c: Context,
  auth: ClientAiAuthContext,
  sessionId: string,
  blockReason: string | undefined,
): Response {
  const reason = blockReason ?? 'dlp_blocked';
  const message = `Your message was blocked by your organization's data protection policy (${reason}).`;
  // Surface on the SSE channel too (pinned contract) when the session is live.
  const active = streamingSessionManager.get(sessionId);
  if (active) {
    active.eventBus.publish({ type: 'error', message });
  }
  auditClient(c, auth, {
    action: 'ai.client_session.message',
    resourceId: sessionId,
    result: 'denied',
    details: { reason },
  });
  return c.json({ error: 'dlp_blocked', reason, message }, 400);
}

clientAiSessionRoutes.post(
  '/:id/messages',
  zValidator('json', sendClientMessageSchema),
  async (c) => {
    const auth = c.get('clientAiAuth');
    const policy = c.get('clientAiPolicy');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');

    const session = await loadClientSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (session.status !== 'active') {
      return c.json({ error: 'Session is no longer active' }, 410);
    }

    const rejection = await runClientPreflight(c, auth, policy);
    if (rejection) return rejection;

    // ── DLP chokepoint (a): the user prompt (templates ride inside it in v1) ──
    const textResult = await applyDlp({
      text: body.content,
      dlpConfig: policy.dlpConfig,
      orgId: auth.orgId,
    });
    if (textResult.action === 'block') {
      return dlpBlockedResponse(c, auth, sessionId, textResult.blockReason);
    }

    // ── workbookContext cells leave Breeze for the provider too — same chokepoint ──
    const redactions: DlpRedactionEvent[] = [...textResult.redactions];
    const wb = body.workbookContext;
    let contextCells: unknown[][] | undefined;
    if (wb && wb.kind !== 'none' && wb.cells) {
      const cellsResult = await applyDlp({
        cells: wb.cells,
        dlpConfig: policy.dlpConfig,
        orgId: auth.orgId,
      });
      if (cellsResult.action === 'block') {
        return dlpBlockedResponse(c, auth, sessionId, cellsResult.blockReason);
      }
      redactions.push(...cellsResult.redactions);
      contextCells = cellsResult.cells;
    }

    const redactedContent = textResult.text ?? body.content;
    let modelContent = redactedContent;
    if (wb && wb.kind !== 'none') {
      const label =
        wb.kind === 'selection'
          ? `Current selection${wb.address ? ` (${wb.address})` : ''}`
          : `Sheet "${wb.sheetName ?? 'unknown'}"`;
      modelContent += `\n\n[Workbook context — ${label}]\n${
        contextCells ? JSON.stringify(contextCells) : '(no cell data provided)'
      }`;
    }

    const activeSession = await ensureActiveClientSession(c, session, auth, policy);

    // Concurrent message guard — atomic check-and-set (ai.ts:467 convention).
    if (!streamingSessionManager.tryTransitionToProcessing(activeSession)) {
      return c.json({ error: 'A message is already being processed for this session' }, 409);
    }

    // Persist the REDACTED form only: result.text + result.redactions
    // (spec §6; Plan 3 Task 6 contract — the raw input is never stored).
    const contentBlocks: Record<string, unknown>[] = [];
    if (redactions.length > 0) {
      contentBlocks.push({ type: 'dlp_redactions', redactions });
    }
    if (wb && wb.kind !== 'none') {
      contentBlocks.push({
        type: 'workbook_context',
        kind: wb.kind,
        address: wb.address ?? null,
        sheetName: wb.sheetName ?? null,
        cells: contextCells ?? null,
      });
    }

    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'user',
        content: redactedContent,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : null,
      });
    } catch (err) {
      console.error('[client-ai] Failed to save user message:', err);
      activeSession.state = 'idle';
      return c.json({ error: 'Failed to save message' }, 500);
    }

    if (!session.title) {
      const title = generateClientSessionTitle(redactedContent);
      try {
        await db.update(aiSessions).set({ title }).where(eq(aiSessions.id, sessionId));
      } catch (err) {
        console.error('[client-ai] Failed to auto-set session title:', err);
      }
    }

    activeSession.inputController.pushMessage(modelContent);
    streamingSessionManager.startTurnTimeout(activeSession);

    auditClient(c, auth, {
      action: 'ai.client_session.message',
      resourceId: sessionId,
      details: {
        contentLength: body.content.length,
        workbookContextKind: wb?.kind ?? 'none',
        redactionCount: redactions.length,
      },
    });

    // The turn streams over GET /:id/events — see sse.ts for the event names.
    return c.json({ accepted: true }, 202);
  },
);

// ============================================
// GET /:id/events — the persistent SSE channel (spec §4)
//
// Preferred client: fetch-based SSE with the Authorization header. EventSource
// fallback: ?token= (GET-only, clientAiAuthMiddleware). The stream does NOT
// end on turn_complete — it persists across turns until the client
// disconnects or the session is evicted/closed (the bus subscription closes).
//
// NOTE on DB access: loadClientSession runs inside the middleware's
// org-scoped request context; the streaming callback itself does NO DB work
// (it runs after the request transaction commits — the #1105 lesson).
// ============================================

clientAiSessionRoutes.get('/:id/events', async (c) => {
  const auth = c.get('clientAiAuth');
  const policy = c.get('clientAiPolicy');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.status !== 'active') {
    return c.json({ error: 'Session is no longer active' }, 410);
  }

  // Create the in-memory session if absent so the add-in can connect the
  // stream immediately after POST /sessions, before the first message.
  const activeSession =
    streamingSessionManager.get(sessionId) ??
    (await ensureActiveClientSession(c, session, auth, policy));

  const subscriptionId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    const events = activeSession.eventBus.subscribe(subscriptionId);

    const ping = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
        /* client gone — the abort handler tears down */
      });
    }, CLIENT_AI_SSE_PING_INTERVAL_MS);

    stream.onAbort(() => {
      clearInterval(ping);
      activeSession.eventBus.unsubscribe(subscriptionId);
    });

    try {
      for await (const event of events) {
        const sse = toClientSseEvent(event);
        if (sse) {
          await stream.writeSSE(sse);
        }
        // Deliberately NO break on 'done' — the channel persists across turns.
      }
    } catch (err) {
      console.error('[client-ai] SSE stream error:', err);
      await stream
        .writeSSE({ event: 'session_error', data: JSON.stringify({ message: 'Stream failed' }) })
        .catch(() => {});
    } finally {
      clearInterval(ping);
      activeSession.eventBus.unsubscribe(subscriptionId);
    }
  });
});

// ============================================
// POST /:id/tool-results — the add-in reports a tool outcome (spec §5 step 2)
//
// Execution/rejection audit + persistence + tool_completed publishing happen
// in the MCP handler (services/clientAiTools.ts) once this resolution lands —
// the route only authenticates, access-checks, and resolves the bridge.
// ============================================

clientAiSessionRoutes.post(
  '/:id/tool-results',
  zValidator('json', clientToolResultSchema),
  async (c) => {
    const auth = c.get('clientAiAuth');
    const sessionId = c.req.param('id')!;

    const session = await loadClientSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const { toolUseId, status, output } = c.req.valid('json');

    const resolved = resolveClientToolResult(sessionId, toolUseId, {
      status,
      output: output ?? null,
    });
    if (!resolved) {
      // Unknown id, already resolved/timed out, or owned by another session.
      return c.json({ error: 'unknown_tool_request' }, 404);
    }

    return c.json({ ok: true });
  },
);

// Helpers shared with Tasks 11/12 (messages / events / tool-results routes).
export { ensureActiveClientSession, loadClientSession, auditClient, runClientPreflight };
