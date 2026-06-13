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
} from '../../services/clientAiSessions';
import {
  CLIENT_MCP_SERVER_NAME,
  clientMcpToolNamesForWriteMode,
  createClientWorkbookMcpServer,
} from '../../services/clientAiTools';
import { failPendingForSession } from '../../services/clientAiToolBridge';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';
import { type ClientAiAuthContext } from './schemas';

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
    details: { model, writeMode: policy.writeMode },
  });

  return c.json({ sessionId: session.id }, 201);
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

// Helpers shared with Tasks 11/12 (messages / events / tool-results routes).
export { ensureActiveClientSession, loadClientSession, auditClient, runClientPreflight };
