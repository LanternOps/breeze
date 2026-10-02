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
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../middleware/auth';
import { aiScriptAuthoringEnabled } from '../config/env';
import { loadScriptProposalReviewerDisagreements } from '../services/scriptProposals/metrics';
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
  sanitizeErrorForClient,
} from '../services/aiAgent';
import { InvalidSessionModelError } from '../services/aiModels/invalidSessionModelError';
import { runPreFlightChecks, abortActivePlan, settleBlockedTurnForNewMessage } from '../services/aiAgentSdk';
import { sanitizeThrownToolError } from '../services/aiToolErrors';
import { redactPersistedToolInput } from '../services/aiToolOutput';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { drainPendingRunResults } from '../services/workspace/chatRunBridge';
import {
  checkBudgetDetailed,
  getUsageSummary,
  updateBudget,
  getSessionHistory,
} from '../services/aiCostTracker';
import { createTicket, changeTicketStatus, TicketServiceError, type TicketActor } from '../services/ticketService';
import { createTimeEntry, TimeEntryServiceError } from '../services/timeEntryService';
import { writeRouteAudit } from '../services/auditEvents';
import { assertNotLocked } from '../services/effectiveSettings';
import {
  listEffectiveToolRateLimits,
  resolveToolRateLimitMultiplier,
  toolRateLimitMultiplierSchema,
} from '../services/aiToolRateLimits';
import { normalizeAlertThresholds, evaluateAiBudgetThresholds } from '../services/aiBudgetAlerts';
import { db } from '../db';
import { aiSessions, aiMessages, aiToolExecutions, auditLogs, organizations, devices, actionIntents, scriptProposals, scriptExecutions, aiScriptLaneState } from '../db/schema';
import { eq, and, desc, gte, lte, count, avg, isNotNull, isNull, ne, notExists, notInArray, or, sql as drizzleSql, type SQL } from 'drizzle-orm';
import { REVEAL_WINDOW_DAYS } from '../services/actionIntents/resultSecrets';
import { PERMISSIONS } from '../services/permissions';
import {
  createAiSessionSchema as sharedCreateAiSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  approvePlanSchema,
  pauseAiSchema,
  aiSessionQuerySchema,
  continueAiSessionSchema,
} from '@breeze/shared/validators';
import { aiActionPlans } from '../db/schema';
import { captureException } from '../services/sentry';
import { safeErrorMessage } from '../services/aiModels/safeDbError';
import { persistAutoSessionTitle } from '../services/aiSessionTitle';
import {
  draftTicketFromTranscript,
  ThinTranscriptError,
  TicketDraftFailedError,
} from '../services/aiTicketDraft';
import { LlmUnavailableError } from '../services/llm/llmConfigResolver';
import { llmUnavailableBody } from '../services/llm/llmUnavailableError';
import { anthropicClientFor, type MessageAttempt } from '../services/aiModels/connectionFactory';
import {
  FailoverExhaustedError,
  isPreOutputMessagesFailure,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from '../services/aiModels/failoverDispatch';
import { messagesUsage, messagesUsageAfterDispatchError } from '../services/aiModels/invocationUsage';
import { oneShotUnavailableAnswer } from '../services/aiModels/oneShotUnavailable';
import { settleInvocation } from '../services/aiModels/settleInvocation';
import { resolveSessionTurn } from '../services/aiModels/sessionModel';
import { loadContinuationSummary, withContinuationContext } from '../services/aiModels/continuation';
import { AI_NOT_CONFIGURED_BODY, LlmNotConfiguredError } from '../services/llm/llmAvailability';
import type { ResolvedModel } from '../services/aiModels/resolveModel';
import { liveQueryKey, turnBindingFrom, withCarriedRates } from '../services/aiModels/turnBinding';
import { continuationMessage, planModelTransition, planTransitionWithFailover, readPreviousTurn, readSessionOfferingId } from '../services/aiModels/modelTransition';
import { lastTurnModelOf, turnDisplayFrom } from '../services/aiModels/turnModel';
import { TopologyAiSessionError } from '../services/topology/aiToolGate';
import type { PreparedTopologyInvestigation } from '../services/topology/aiInvestigation';
// Loaded lazily, only for a topology session: its tool/transport graph must not
// load for every chat route (and every route unit test's partial mocks).
const loadTopologyTurn = () => import('./aiTopologyTurn');
// W05 (#7603): the continuation handler, loaded on first use for the same reason.
const loadSessionContinuation = () => import('./aiSessionContinue');
/** Topology sessions get a fixed title: no model or evidence text ever names a session. */
const TOPOLOGY_SESSION_TITLE = 'Topology investigation';
import {
  resolveTopologySessionVisibility,
  topologySessionCondition,
  type TopologySessionVisibility,
} from '../services/topology/aiSessionAccess';

/**
 * M4-D2 for audit rows: an `ai_session` audit row (tool calls, authority
 * changes, injection flags) names its session and carries the tool input, so a
 * row about a topology session pinned to a site the caller cannot read is
 * withheld exactly like the session itself. Applied in SQL before LIMIT.
 */
function topologyAuditSessionCondition(visibility: TopologySessionVisibility): SQL | undefined {
  if (visibility.kind === 'all') return undefined;
  const hidden = visibility.kind === 'none'
    ? isNotNull(aiSessions.topologySiteId)
    : and(isNotNull(aiSessions.topologySiteId), notInArray(aiSessions.topologySiteId, visibility.siteIds));
  return or(
    ne(auditLogs.resourceType, 'ai_session'),
    isNull(auditLogs.resourceId),
    notExists(
      db.select({ one: drizzleSql`1` }).from(aiSessions).where(and(eq(aiSessions.id, auditLogs.resourceId), hidden)),
    ),
  );
}
import { createTicketFromChatSchema, type AiContinuationRequired, type AiTicketDraft } from '@breeze/shared';
import { deviceInSiteScope } from './tickets/siteScope';
import { timeActorFrom } from './timeEntries/timeEntries';
import { pageContextWriteDefaultOrgId } from '../services/aiSessionOrgAnchor';
import {
  AiBudgetSessionBusyError,
  isAiBudgetLockTimeout,
  markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
  type ReserveAiBudgetResult,
} from '../services/aiBudgetReservations';

/**
 * Topology answer cache key (M4 Task 3): moves whenever the dispatch identity
 * moves — the live-query key of the resolved model (connection, config
 * version, catalog revision, wire model, wire params). W06: every chat turn,
 * env OpenAI-compatible deployments included, resolves through the registry.
 */
function topologyProviderRevision(model: ResolvedModel): string {
  return `sdk:${liveQueryKey(turnBindingFrom(model))}`;
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

type AiTurnBudgetDispatch = { reservationId: string; maxBudgetUsd?: number };

function budgetDispatchFrom(result: ReserveAiBudgetResult): AiTurnBudgetDispatch | null {
  if (result.kind === 'denied') return null;
  return {
    reservationId: result.reservationId,
    ...(result.kind === 'reserved'
      ? { maxBudgetUsd: result.reservedCostCents / 100 }
      : {}),
  };
}

async function releaseUnusedTurn(orgId: string, dispatch: AiTurnBudgetDispatch): Promise<void> {
  await releaseUnusedAiBudgetReservation({ orgId, reservationId: dispatch.reservationId });
}

export const aiRoutes = new Hono();

// Sessions with an approve-plan decision currently being persisted (#7077).
// The write happens before the in-memory resolver is released, so without
// this a second request could slip past the pending check and persist a
// conflicting decision.
const planDecisionsInFlight = new WeakSet<object>();
const requireAiRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
// Org-level AI config (budget) and cross-owner moderation (flag/unflag) stay
// organizations:write actions.
const requireAiWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
// #6396: opening and driving your OWN chat session is a dedicated capability
// (ai_sessions:use) held by Org Admin, Org Technician and Partner Technician — NOT
// organizations:write, which no seeded org-scope role holds. Tool calls inside
// the session are re-checked against TOOL_PERMISSIONS (route parity), so this
// gate opens the conversation without widening what the role can do. Own-session
// READS use it too: seeded org roles hold neither organizations:read nor :write.
const requireAiUse = requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action);
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
  requireAiUse,
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
      if (err instanceof LlmNotConfiguredError) return c.json(AI_NOT_CONFIGURED_BODY, 503);
      if (err instanceof InvalidSessionModelError) return c.json({ error: err.message, code: err.code }, 400);
      if (err instanceof LlmUnavailableError) return c.json(llmUnavailableBody(err), 503);
      if (err instanceof TopologyAiSessionError) return c.json({ error: err.message, code: err.code }, err.status);
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message === 'Invalid topology context') return c.json({ error: message }, 400);
      if (message === 'Organization context required') return c.json({ error: message }, 400);
      if (message === 'Invalid M365 connection') return c.json({ error: message }, 400);
      if (message === 'Invalid device') return c.json({ error: message }, 400);
      if (message === 'Access denied to this organization') return c.json({ error: message }, 403);
      // Anything past the four exact-match branches above is an unexpected fault
      // whose message may be raw driver text (#2603) — genericize it.
      return c.json({ error: sanitizeThrownToolError('create_ai_session', err) }, 500);
    }
  }
);

// GET /sessions - List user's sessions
aiRoutes.get(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  requireAiUse,
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
  requireAiUse,
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
  requireAiUse,
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
  requireAiUse,
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const result = await getSessionMessages(sessionId, auth);
    if (!result) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // W05: what ran the last turn, persisted on the (owner-bound) session row
    // — no extra query, and never a guess from ledger rows (D13). Parsed, so
    // an unrecognised stored value reads as absent; the web store reads it
    // off `session`, the plan's contract names the top-level field.
    const lastTurnModel = lastTurnModelOf(result.session);
    return c.json({ ...result, session: { ...result.session, lastTurnModel }, lastTurnModel });
  }
);

// DELETE /sessions/:id - Close a session
aiRoutes.delete(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  requireAiUse,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

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
  requireAiUse,
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
    const [org] = await db
      .select({ name: organizations.name, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, session.orgId))
      .limit(1);
    if (!org) return c.json({ error: 'ai_unavailable' }, 503);

    // The ticket draft inherits the chat session's offering (spec §4) but is a
    // Messages API one-shot, so it resolves for that transport's carriage.
    const turn = await resolveSessionTurn({
      sessionId, surface: 'chat', userId: auth.user.id, maxTokens: 1024, transport: 'messages_api',
    });
    if (!turn.ok) {
      const answer = oneShotUnavailableAnswer(turn);
      return c.json(answer.body, answer.status);
    }
    let client;
    try {
      client = anthropicClientFor(turn, { surface: 'one_shot_ticket_draft', orgId: session.orgId });
    } catch (err) {
      if (err instanceof LlmUnavailableError) return c.json(llmUnavailableBody(err), 503);
      throw err;
    }
    // reserveAiBudget enforces caps, NOT prepaid credits or the plan gate —
    // check them with the resolved funding before reserving.
    const denial = await checkBudgetDetailed(session.orgId, turn.funding);
    if (denial) return c.json({ error: denial.message }, 402);

    const binding = turnBindingFrom(turn);
    // S8: no stable request identity reaches this surface — the client sends
    // no message/draft id — so the key is random per dispatch. The unique
    // (org_id, idempotency_key) index is therefore a structural guarantee
    // that two dispatches never share a reservation row, NOT a replay guard.
    // SESSIONLESS on purpose: a ticket draft is not a session turn. Passing
    // the chat session here would stamp this one-shot's binding onto the chat
    // session and bind the reservation to it, which the sessionless
    // settlement below then refuses (session-bound reservations require a
    // session settlement). Authorization against the session already happened
    // in getSessionMessages above.
    // Hop 0's key; a failover hop n reserves `<key>:hop:<n>` (W09).
    const reservationKey = `ticket-draft:${sessionId}:${crypto.randomUUID()}`;
    let reservation;
    try {
      reservation = await reserveAiBudget({
        orgId: session.orgId,
        idempotencyKey: reservationKey,
        billingSource: turn.funding,
        binding,
      });
    } catch (err) {
      // Same fail-fast answer as the other admission sites: contention on the
      // org row is a 503 the client can retry, not a 500.
      if (isAiBudgetLockTimeout(err)) return c.json({ error: 'AI_BUDGET_LOCK_TIMEOUT' }, 503);
      throw err;
    }
    if (reservation.kind === 'denied') return c.json({ error: reservation.message }, 429);

    // W09 (#7607): a pre-output provider failure fails over along the session
    // offering's fallback list; each hop is admitted, reserved and settled on
    // its own (failoverDispatch.ts). `current` is the hop in flight: failure
    // handling settles THAT hop. With no list the original error comes
    // straight back and the W03 handling below is unchanged.
    let current: FailoverHop = {
      index: 0, resolved: turn, binding, reservationId: reservation.reservationId, idempotencyKey: reservationKey,
      reservedCostCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : null,
    };

    // Ledger rows carry sessionId null deliberately: a ticket draft is not a
    // chat turn, and its cost in the chat session's total_cost_cents would
    // double-attribute it in the session list. The ledger keeps it as
    // surface 'chat', source_ref 'ticket_draft'.
    const holdIndeterminate = (reservationId: string) => markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId })
      .catch((markError) => {
        captureException(new Error(`ticket draft reservation not retained as indeterminate: ${safeErrorMessage(markError)}`), undefined, {
          org_id: session.orgId, ai_reservation_id: reservationId,
        });
      });
    // Best effort, never throws: a settlement failure (or an unrecorded
    // deferral, S1) holds the reservation indeterminate and is reported
    // scrubbed (S7) — it is never released. Always on THAT hop's binding and
    // reservation (W09 F5).
    const settleOn = async (hop: FailoverHop, attempts: MessageAttempt[], dispatchFailed = false): Promise<void> => {
      const reservationId = hop.reservationId;
      try {
        const { usage, outcome } = dispatchFailed
          ? messagesUsageAfterDispatchError(hop.binding, attempts)
          : messagesUsage(hop.binding, attempts);
        const settled = await settleInvocation({
          binding: hop.binding, orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null,
          sourceRef: 'ticket_draft', usage, outcome, reservationId,
        });
        if (settled.unrecorded) await holdIndeterminate(reservationId);
      } catch (settleError) {
        const message = safeErrorMessage(settleError);
        console.error('[AI] ticket draft settlement failed', { reservationId, error: message });
        captureException(new Error(`ticket draft settlement failed: ${message}`), undefined, {
          org_id: session.orgId, ai_reservation_id: reservationId,
        });
        await holdIndeterminate(reservationId);
      }
    };

    let draft;
    let served: FailoverHop;
    try {
      ({ value: draft, hop: served } = await runWithFailover({
        first: current,
        reResolve: ({ excludeOfferingIds, cause, origin }) => resolveSessionTurn({
          sessionId, surface: 'chat', userId: auth.user.id, maxTokens: 1024, transport: 'messages_api',
          excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
        }),
        // Sessionless, like hop 0: settled with sessionId null.
        reserveHop: reserveFailoverHop({ orgId: session.orgId }),
        attempt: (hop) => {
          current = hop;
          return draftTicketFromTranscript({
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            contextSnapshot: session.contextSnapshot,
            elapsedMinutes,
            resolved: hop.resolved,
            client: hop.index === 0 ? client : anthropicClientFor(hop.resolved, { surface: 'one_shot_ticket_draft', orgId: session.orgId }),
            // This hop's OWN allowance (Codex review 6), never hop 0's.
            ...(hop.reservedCostCents !== null ? { budgetCents: hop.reservedCostCents } : {}),
          });
        },
        settleFailedHop: settleZeroUsageHop({
          orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null, sourceRef: 'ticket_draft',
        }),
        // A draft error carrying a completed attempt never fails over: those tokens bill on this hop.
        isPreOutput: isPreOutputMessagesFailure,
      }));
    } catch (err) {
      if (err instanceof FailoverExhaustedError) {
        // Every hop runWithFailover tried is already settled on its own reservation.
        console.error('[AI] Ticket draft failed on every configured model:', safeErrorMessage(err.lastError), {
          stop: err.stop, admission: err.admissionMessage,
        });
        // The backup's credits / budget refused it: say so, like hop 0's own denial (402).
        if (err.stop === 'admission_denied' && err.admissionMessage) return c.json({ error: err.admissionMessage }, 402);
        return c.json({ error: 'ai_unavailable' }, 503);
      }
      const reservationId = current.reservationId;
      const settle = (attempts: MessageAttempt[], dispatchFailed = false) => settleOn(current, attempts, dispatchFailed);
      try {
        if (err instanceof TicketDraftFailedError && err.attempts.length > 0) {
          // The provider answered (at least once): the burned tokens bill —
          // including a refused attempt whose fallback call then threw.
          await settle(err.attempts, err.providerOutcomeUnknown);
        } else if (err instanceof TicketDraftFailedError && err.providerOutcomeUnknown) {
          await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId });
        } else {
          // Thin transcript / prompt over budget / nothing sent: hand it back.
          await releaseUnusedAiBudgetReservation({ orgId: session.orgId, reservationId });
        }
      } catch (budgetError) {
        captureException(new Error(`ticket draft reservation bookkeeping failed: ${safeErrorMessage(budgetError)}`), undefined, {
          org_id: session.orgId, ai_reservation_id: reservationId,
        });
      }
      if (err instanceof ThinTranscriptError) return c.json({ error: err.message }, 422);
      if (err instanceof LlmUnavailableError) return c.json(llmUnavailableBody(err), 503);
      console.error('[AI] Ticket draft failed:', err);
      captureException(err);
      return c.json({ error: 'Could not draft a ticket from this conversation' }, 502);
    }

    // Best-effort cost accounting on the hop that served; never fails the request.
    await settleOn(served, draft.attempts);

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

// POST /sessions/:id/continue — W05 (#7603; spec §9.2, §15 #4): a model
// switch that cannot resume continues in a NEW chat on the target offering,
// linked back to this one and seeded with a summary the TARGET writes.
// D12: registered in selfManagedDbContextRoutes (it makes a provider call).
// The handler (routes/aiSessionContinue.ts) loads lazily, like the topology
// turn: its resolver / candidate-loader graph must not load for every route.
aiRoutes.post(
  '/sessions/:id/continue',
  requireScope('organization', 'partner', 'system'),
  requireAiUse,
  requireMfa(),
  zValidator('json', continueAiSessionSchema),
  async (c) => {
    const { continueAiSession } = await loadSessionContinuation();
    return continueAiSession(c, {
      auth: c.get('auth'),
      sessionId: c.req.param('id')!,
      choice: c.req.valid('json').model,
    });
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

    const actor: TicketActor = { kind: 'user', userId: auth.user.id, name: auth.user.name, email: auth.user.email };

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
    let timeLogError: string | undefined;
    if (body.timeMinutes > 0 && (auth.scope === 'partner' || auth.scope === 'system')) {
      try {
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - body.timeMinutes * 60_000);
        await createTimeEntry(
          { ticketId: ticket.id, startedAt, endedAt, description: 'Logged from AI conversation', ...(body.billable !== undefined ? { isBillable: body.billable } : {}) },
          timeActorFrom(c),
        );
        timeLogged = true;
      } catch (err) {
        console.error(`[AI] Ticket ${ticket.id} created but time entry failed:`, err);
        timeLogError = err instanceof TimeEntryServiceError
          ? err.message
          : 'The time entry could not be logged. Please log it on the ticket.';
      }
    }

    writeRouteAudit(c, { orgId: session.orgId, action: 'ai.session.create_ticket', resourceType: 'ticket', resourceId: ticket.id });
    return c.json({ data: ticket, resolved, timeLogged, ...(timeLogError ? { timeLogError } : {}) }, 201);
  }
);

// ============================================
// Message Sending (SSE Stream via Streaming Sessions)
// ============================================

// POST /sessions/:id/messages - Send a message and stream the response
aiRoutes.post(
  '/sessions/:id/messages',
  requireScope('organization', 'partner', 'system'),
  requireAiUse,
  requireMfa(),
  zValidator('json', sendAiMessageSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');
    // #3127: this route is registered in selfManagedDbContextRoutes, so no
    // request transaction is held across the handler. Each DB phase runs in its
    // own short context carrying the caller's exact scope, and the settle wait
    // and the budget reservation (which opens its own system transaction) run
    // between them with no connection checked out.
    const inRequestDb = <T>(fn: () => Promise<T>): Promise<T> => withAuthDbAccessContext(auth, fn);

    // Pre-flight checks (rate limits, budget, session status, input sanitization)
    const preflight = await inRequestDb(() =>
      runPreFlightChecks(sessionId, body.content, auth, body.pageContext, c, body.model),
    );
    if (!preflight.ok) {
      const err = preflight.error;
      if (err === 'ai_not_configured') return c.json(AI_NOT_CONFIGURED_BODY, 503);
      if (err === 'ai_unavailable') return c.json({ error: 'ai_unavailable' }, 503);
      // W03: a stored model that went ineligible is recoverable (choose another), never a silent switch.
      if (preflight.code) return c.json({ error: err, code: preflight.code, recoverable: true }, preflight.status === 503 ? 503 : 409);
      if (preflight.status === 503) return c.json({ error: err }, 503);
      if (err === 'Session not found') return c.json({ error: err }, 404);
      if (err.includes('rate limit') || err.includes('Rate limit')) return c.json({ error: err }, 429);
      if (err.includes('budget') || err.includes('Budget')) return c.json({ error: err }, 402);
      if (err.includes('expired')) return c.json({ error: err }, 410);
      return c.json({ error: err }, 400);
    }

    const { session: dbSession, sanitizedContent, systemPrompt, model: resolvedModel } = preflight;

    // Topology M4 Task 3 (#6000): a topology session runs a bounded
    // investigation on this same transport. The pinned site is re-authorized,
    // quotas reserved and sanitized evidence built BEFORE any provider call;
    // a re-authorized cached answer returns without one. Provider text for
    // the turn goes to the runtime's output gate, never to SSE.
    //
    // #3127: the preparation resolves the org's topology flags/readiness with
    // no context held, then runs in ONE short caller-scoped context
    // (inRequestDb) — closed before the settle wait, the reservation and the
    // model stream. The runtime it returns opens its own short contexts for
    // every later read (aiInvestigation.ts); its lease lives in Redis, so
    // aborting it (every refusal below) needs no DB context.
    let topology: Extract<PreparedTopologyInvestigation, { kind: 'live' }> | null = null;
    let topologyTurn: Awaited<ReturnType<typeof loadTopologyTurn>> | null = null;
    if (dbSession.type === 'topology') {
      topologyTurn = await loadTopologyTurn();
      const { prepareTopologyTurn, cachedTopologyEvents } = topologyTurn;
      const prepared = await prepareTopologyTurn(auth, dbSession, sanitizedContent, topologyProviderRevision(resolvedModel), inRequestDb);
      if (!prepared.ok) return c.json(prepared.body, prepared.status);
      if (prepared.prepared.kind === 'cached') {
        const explanation = prepared.prepared.explanation;
        try {
          // Its own short context: a failed write never poisons another phase's transaction.
          await inRequestDb(() => db.insert(aiMessages).values([
            { sessionId, role: 'user', content: sanitizedContent },
            { sessionId, role: 'assistant', content: JSON.stringify(explanation), contentBlocks: [{ type: 'topology_explanation', explanation }] as unknown as Record<string, unknown>[] },
          ]));
        } catch (err) {
          console.error('[AI] Failed to save cached topology explanation:', err);
        }
        return streamSSE(c, async (stream) => {
          for (const event of cachedTopologyEvents(explanation)) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        });
      }
      topology = prepared.prepared;
    }
    const abortTopology = async () => { await topology?.runtime.abort(); };

    // W05 (#7603): a continuation's FIRST turn (no SDK transcript yet) is
    // seeded with the summary its creation stored; later turns resume the SDK
    // transcript, which already contains it. The summary is model output over
    // tool results, so it is untrusted: it is only ever prefixed to this user
    // turn (below), never the system prompt. Read here, in its own short
    // caller-scoped context, before anything is reserved or claimed.
    const continuationSummary = !topology && dbSession.continuedFromSessionId && !dbSession.sdkSessionId
      ? await inRequestDb(() => loadContinuationSummary(sessionId))
      : null;
    if (!topology && dbSession.continuedFromSessionId && !dbSession.sdkSessionId && continuationSummary === null) {
      // The continuation was created with a summary; it is gone (or unreadable).
      // The turn proceeds without the prior context — report it, never content.
      console.warn('[AI] continuation summary missing on the first turn; sending without prior context', {
        orgId: dbSession.orgId, sessionId, continuedFromSessionId: dbSession.continuedFromSessionId,
      });
      captureException(new Error('continuation summary missing on first turn'), undefined, { org_id: dbSession.orgId });
    }

    // A Claude SDK query's maxBudgetUsd is immutable after creation. Finish any
    // approval-only prior turn, then rotate the idle query so this turn is
    // created with the exact durable reservation ceiling.
    const priorSession = streamingSessionManager.get(sessionId);
    if (priorSession?.state === 'processing') {
      // #3089: when the in-flight turn is blocked ONLY on pending tool
      // approvals, the assistant used to go mute — the user's message bounced
      // with a 409 while the model sat waiting up to 5 minutes per approval.
      // Settle those waits instead: the blocked tool calls return promptly
      // with an approval-pending result (tier-3 intents stay pending and are
      // executed by the durable release worker once decided), the model
      // concludes the turn, and this message then proceeds normally. If the
      // session is busy for any other reason (model actively working), or the
      // turn doesn't conclude in time, fall back to a 409 as before.
      // #3127: runs with no DB context held (see inRequestDb above).
      const settle = await settleBlockedTurnForNewMessage(priorSession);
      if (settle !== 'concluded') {
        await abortTopology();
        return c.json({
          error: settle === 'not_blocked_on_approvals'
            ? 'A message is already being processed for this session'
            : 'The assistant is wrapping up the previous turn — please try again in a moment',
        }, 409);
      }
    }
    if (streamingSessionManager.get(sessionId)) {
      streamingSessionManager.remove(sessionId);
    }

    // W09: a failover hop replaces the dispatched model.
    let model = resolvedModel;
    // W05 (spec §9.2; spike constraints 1–3): every model change passes ONE
    // gate before anything is reserved. Same model → W03 reuse; another
    // connection or funding, a transcript too large for the target, or one
    // whose fit can't be proven → the client offers a continuation.
    // W09 (#7607): a resolution-time failover candidate passes the same gate;
    // one that would need a continuation is passed over for the next backup
    // (or the cooling primary) before anything is reserved.
    // #3127: every read opens its own system context; no request DB context
    // is held here (between inRequestDb phases).
    let previous: Awaited<ReturnType<typeof readPreviousTurn>>;
    let transition: Awaited<ReturnType<typeof planModelTransition>>;
    try {
      previous = await readPreviousTurn({ orgId: dbSession.orgId, sessionId });
      // The preflight's session row predates resolveModel's lazy partner
      // cutover, which stamps a pre-W03 session's offering_id: re-read it so a
      // plain same-offering message is not refused as fit_unverifiable.
      const freshOfferingId = await readSessionOfferingId({ orgId: dbSession.orgId, sessionId });
      const priorTurn = previous;
      ({ model, transition } = await planTransitionWithFailover({
        first: resolvedModel,
        plan: (target) => planModelTransition({
          orgId: dbSession.orgId,
          sdkSessionId: dbSession.sdkSessionId,
          sessionOfferingId: freshOfferingId === undefined ? (dbSession.offeringId ?? null) : freshOfferingId,
          previous: priorTurn,
          target,
          systemPrompt: topology ? topology.systemPrompt : systemPrompt,
          pendingUserTurn: topology ? topology.prompt : sanitizedContent,
        }),
        reResolve: (excludeOfferingIds) => resolveSessionTurn({
          sessionId, surface: resolvedModel.surface, userId: auth.user.id, transport: resolvedModel.transport, excludeOfferingIds,
        }),
      }));
    } catch (err) {
      // Nothing is reserved yet; release the topology lease like every other refusal.
      await abortTopology();
      throw err;
    }
    if (transition.kind === 'continuation_required') {
      await abortTopology();
      // A continuation (routes/aiSessionContinue.ts) refuses topology
      // sessions, so offering one here would be a dead end.
      if (topology) {
        return c.json({
          error: 'The AI model for this investigation changed. Start a new investigation to continue.',
          code: 'topology_model_changed',
          recoverable: true,
        }, 409);
      }
      const answer: AiContinuationRequired = {
        error: continuationMessage(transition.reason, model.offering.displayName),
        code: 'continuation_required',
        reason: transition.reason,
        recoverable: true,
        target: { offeringId: model.offering.id, displayName: model.offering.displayName },
      };
      return c.json(answer, 409);
    }
    // Spec §9.2: the turn binding (offering, options, rate, connection
    // identity, wire model) is written onto the reservation in its own
    // transaction; funding is the resolved offering's, decided before admission.
    // W05: a resumed session also carries the rates of the models it switched
    // away from, so their late deltas bill at their own rate (spike Q6).
    const binding = withCarriedRates(turnBindingFrom(model), transition.kind === 'fresh' ? [] : transition.carriedRates);
    // S8: no stable request identity reaches this surface — the client sends
    // no message/draft id — so the key is random per dispatch. The unique
    // (org_id, idempotency_key) index is therefore a structural guarantee
    // that two dispatches never share a reservation row, NOT a replay guard.
    // The one caller with a real identity uses it: `ai-agent-run:${run.id}`
    // in services/aiAgents/runLoop.ts. Give this one a stable key only when
    // the request schema starts carrying a client-generated id.
    let reservation;
    try {
      reservation = await reserveAiBudget({
        orgId: dbSession.orgId,
        billingSource: model.funding,
        sessionId,
        idempotencyKey: `chat:${sessionId}:${crypto.randomUUID()}`,
        binding,
        // W05 spike constraint 3: claimed only against the turn this plan
        // read, and never re-stamped mid-turn.
        sessionSwitchGuard: { expectedPreviousChatReservationId: previous?.reservationId ?? null },
      });
    } catch (err) {
      await abortTopology();
      if (err instanceof AiBudgetSessionBusyError) return c.json({ error: err.message, code: 'turn_in_progress' }, 409);
      if (isAiBudgetLockTimeout(err)) return c.json({ error: 'AI_BUDGET_LOCK_TIMEOUT' }, 503);
      throw err;
    }
    if (reservation.kind === 'denied') {
      await abortTopology();
      return c.json({ error: reservation.message }, 402);
    }
    const budgetDispatch = budgetDispatchFrom(reservation)!;

    type ActiveChatSession = Awaited<ReturnType<typeof streamingSessionManager.getOrCreate>>;
    const subscriptionId = crypto.randomUUID();
    let subscribedSession: ActiveChatSession | null = null;
    const dispatch = await inRequestDb(async (): Promise<
      | { kind: 'dispatched'; activeSession: ActiveChatSession; events: ReturnType<ActiveChatSession['eventBus']['subscribe']> }
      | { kind: 'refused'; response: Response }
      | { kind: 'failed'; error: unknown }
    > => {
      let activeSession: ActiveChatSession;
      try {
        activeSession = await streamingSessionManager.getOrCreate(
          sessionId,
          {
            orgId: dbSession.orgId,
            sdkSessionId: dbSession.sdkSessionId,
            maxTurns: dbSession.maxTurns,
            turnCount: dbSession.turnCount,
            systemPrompt: dbSession.systemPrompt,
            // Device-bound sessions narrow tool execution to the device's org
            // (ai_sessions.org_id), not the login org (#3087).
            deviceId: dbSession.deviceId,
            // A chat opened from a device page defaults its org-scoped WRITES to
            // the page's org (#6675); reads keep the caller's full scope.
            writeDefaultOrgId: pageContextWriteDefaultOrgId(dbSession),
          },
          auth,
          c,
          topology ? topology.systemPrompt : systemPrompt,
          budgetDispatch.maxBudgetUsd,
          model,
          // Topology: the SDK is handed ONLY the topology tools; the pre-tool
          // gate re-checks the allowlist, read budget and live scope.
          topology ? topology.allowedMcpTools : undefined,
          topology && topologyTurn ? topologyTurn.topologyMcpServerFactory : undefined,
          topology
            ? { budgetReservationId: budgetDispatch.reservationId, injectApprovalModeInstructions: false, ledgerUserId: auth.user.id, modelSwitch: transition.kind === 'switch_resume' }
            // A-W04: only a full-registry chat turn may defer tools behind
            // ToolSearch; the host/budget/operator policy decides the rest.
            : { budgetReservationId: budgetDispatch.reservationId, toolSearch: true, ledgerUserId: auth.user.id, modelSwitch: transition.kind === 'switch_resume' },
        );
      } catch (err) {
        return { kind: 'failed', error: err };
      }

      // The topology runtime is bound by the transition itself, and only when
      // this request wins the slot (PR #7147 F1).
      if (!streamingSessionManager.tryTransitionToProcessing(activeSession, budgetDispatch.reservationId, { topologyInvestigation: topology?.runtime, turnBinding: binding, turnDisplay: turnDisplayFrom(model) })) {
        return { kind: 'refused', response: c.json({ error: 'A message is already being processed for this session' }, 409) };
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
        activeSession.topologyInvestigation = undefined;
        return { kind: 'refused', response: c.json({ error: 'Failed to save message' }, 500) };
      }

      // Auto-generate title from first user message
      if (!dbSession.title) {
        const title = topology ? TOPOLOGY_SESSION_TITLE : generateSessionTitle(sanitizedContent);
        try {
          await persistAutoSessionTitle(sessionId, title);
          activeSession.eventBus.publish({ type: 'title_updated', title });
        } catch (err) {
          captureException(err, c);
          console.error('[AI] Failed to auto-set session title:', err);
        }
      }

      // Execution plane (spec §5.5): an `analysis` run associated with this
      // session may have finished between turns (chat-initiated launch is
      // currently disabled, #6086, but a preconfigured agent's run can still
      // report back to a session this way). Its summary is prepended HERE
      // rather than pushed when it arrived — pushing then would start a turn
      // with no SSE subscriber, so the assistant's reply would never reach the
      // browser.
      const pendingRunResults = drainPendingRunResults(activeSession);
      // W05 (#7603): a continuation's FIRST turn carries the summary (read
      // above) as delimited, sanitised, untrusted background — never the
      // system prompt. The persisted user row above keeps the plain text, so
      // the prefix reaches only the model.
      const turnContent = topology
        ? topology.prompt
        : continuationSummary ? withContinuationContext(continuationSummary, sanitizedContent) : sanitizedContent;
      // Subscribe BEFORE the turn is pushed: the session event bus has no
      // replay, and a fast transport can publish the turn's events (even its
      // error and done) before the SSE callback below would run.
      const events = activeSession.eventBus.subscribe(subscriptionId);
      subscribedSession = activeSession;
      activeSession.inputController.pushMessage(
        pendingRunResults && !topology ? `${pendingRunResults}\n\n${turnContent}` : turnContent,
      );
      streamingSessionManager.startTurnTimeout(activeSession);
      return { kind: 'dispatched', activeSession, events };
    }).catch((err: unknown) => {
      // The dispatch context failed after subscribing (e.g. its commit): drop
      // the subscription so the bus doesn't keep a dead queue.
      subscribedSession?.eventBus.unsubscribe(subscriptionId);
      throw err;
    });
    if (dispatch.kind !== 'dispatched') {
      // Released only after the dispatch context has closed, so the release's
      // own system transaction never runs beside a held request connection.
      await abortTopology();
      await releaseUnusedTurn(dbSession.orgId, budgetDispatch);
      if (dispatch.kind === 'failed') throw dispatch.error;
      return dispatch.response;
    }
    const { activeSession, events } = dispatch;

    return streamSSE(c, async (stream) => {

      try {
        for await (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === 'done') break;
        }
      } catch (err) {
        // Never stream a raw error to the browser (#2603). Uses the stream
        // sanitizer (not the tool one) so user-actionable conditions — rate
        // limit, budget, approval timeout — survive, while driver text does
        // not. sanitizeErrorForClient is detector-gated.
        console.error('[AI] Stream error:', err);
        const message = sanitizeErrorForClient(err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            message,
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
  requireAiUse,
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
  requireAiUse,
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
  requireAiUse,
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
  requireAiUse,
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

    const activeSession = streamingSessionManager.get(sessionId);
    if (!activeSession) {
      return c.json({ error: 'Session not active in memory' }, 404);
    }

    if (!activeSession.planApprovalResolver) {
      return c.json({ error: 'No pending plan approval' }, 400);
    }

    if (planDecisionsInFlight.has(activeSession)) {
      return c.json({ error: 'A decision on this plan is already being saved' }, 409);
    }

    // Persist the decision BEFORE releasing the agent (#7077). If the write
    // fails, the approval stays pending so the user can retry, and the agent
    // never acts on (or abandons) a plan whose recorded status disagrees.
    const resolvePlanApproval = activeSession.planApprovalResolver;
    const planId = activeSession.activePlanId;
    planDecisionsInFlight.add(activeSession);
    try {
      if (planId) {
        try {
          // Only a still-pending plan takes a decision: an abort that landed
          // first must not be overwritten with approved/rejected.
          const updated = await db.update(aiActionPlans)
            .set({
              status: approved ? 'approved' : 'rejected',
              approvedBy: auth.user.id,
              approvedAt: new Date(),
            })
            .where(and(eq(aiActionPlans.id, planId), eq(aiActionPlans.status, 'pending')))
            .returning({ id: aiActionPlans.id });
          if (updated.length === 0) {
            return c.json({ error: 'The plan approval is no longer pending' }, 409);
          }
        } catch (err) {
          console.error('[AI] Failed to update plan status:', err);
          captureException(err);
          return c.json(
            { error: 'The plan decision could not be saved. Please try again.' },
            500,
          );
        }
      }
    } finally {
      planDecisionsInFlight.delete(activeSession);
    }

    // The approval can time out, or the plan be aborted, while the write
    // above is in flight. Don't release the agent onto a plan that is gone.
    if (
      activeSession.planApprovalResolver !== resolvePlanApproval ||
      activeSession.activePlanId !== planId
    ) {
      return c.json({ error: 'The plan approval is no longer pending' }, 409);
    }

    // Resolve the in-memory promise
    resolvePlanApproval(approved);
    activeSession.planApprovalResolver = null;

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
  requireAiUse,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
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
  requireAiUse,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      // System/partner users without a specific org: no org to resolve an
      // effective budget for, so budget stays null. #4388: alerts.fired must
      // still be present (empty) so callers can read it unconditionally.
      return c.json({
        daily: { inputTokens: 0, outputTokens: 0, totalCostCents: 0, messageCount: 0 },
        monthly: { inputTokens: 0, outputTokens: 0, totalCostCents: 0, messageCount: 0 },
        budget: null,
        billedTo: 'platform' as const,
        // #4388 W04: present (null) on every /ai/usage response, same
        // rationale as `alerts.fired` above: callers read `usage.credits`
        // unconditionally.
        credits: null,
        alerts: { fired: [] },
      });
    }

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    // #4388 W04: the credit pool is PARTNER-wide, shared across every one of
    // the MSP's customer orgs. An organization-scoped token belongs to one of
    // those customers, so handing it that balance would leak a partner-level
    // figure across the tenancy boundary (and let one customer watch another's
    // spend drain it). Only partner- and system-scoped callers get it.
    const includeCredits = auth.scope === 'partner' || auth.scope === 'system';
    const usage = await getUsageSummary(orgId, { includeCredits });
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
    alertThresholdPercents: z.array(z.number().int().min(1).max(99)).max(5).nullable().optional(),
    // #6476 — raises every per-tool AI/MCP rate limit; 1–10, never lowers one.
    toolRateLimitMultiplier: toolRateLimitMultiplierSchema.optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;
    if (!orgId) return c.json({ error: 'Organization context required' }, 400);

    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const body = c.req.valid('json');

    // Normalise BEFORE the lock check: assertNotLocked compares with
    // isDeepStrictEqual, which is array-order-sensitive, so checking the raw
    // body would 403 a legitimate no-op resubmit of the same rungs sent in a
    // different order.
    const normalized = body.alertThresholdPercents == null
      ? body
      : { ...body, alertThresholdPercents: normalizeAlertThresholds(body.alertThresholdPercents) };

    // Enforce partner locks on AI budget fields. Submitted values are passed so a
    // field the partner enforces only 403s when the org actually changes it
    // (issue #2752); re-sending the enforced value is an allowed no-op.
    if (Object.keys(normalized).length > 0) {
      await assertNotLocked(orgId, 'aiBudgets', normalized);
    }

    await updateBudget(orgId, normalized);

    // A lowered cap or a new rung must fire now, not on the next turn (spec §4.2 #2).
    // The evaluator wraps itself in runOutsideDbContext, so calling it from a
    // request is safe; it never throws.
    void evaluateAiBudgetThresholds(orgId);

    writeRouteAudit(c, {
      orgId,
      action: 'ai.budget.update',
      resourceType: 'ai_budget'
    });

    return c.json({ success: true });
  }
);

// GET /tool-rate-limits - Effective per-tool AI/MCP rate limits (#6476).
// The limits checkToolRateLimit enforces for this org: TOOL_RATE_LIMITS scaled
// by the org's effective toolRateLimitMultiplier (partner value wins). With no
// org (partner/system caller, no org selected) the partner's own value is used,
// matching the MCP partner-scope fallback. Config, not usage — gated like
// GET /usage. The AI Risk → Rate Limits tab reads this instead of a web copy.
aiRoutes.get(
  '/tool-rate-limits',
  requireScope('organization', 'partner', 'system'),
  requireAiUse,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId || null;

    if (orgId && orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const multiplier = await resolveToolRateLimitMultiplier({
      orgId,
      partnerId: orgId ? null : auth.partnerId ?? null,
    });
    const limits = listEffectiveToolRateLimits(multiplier);

    return c.json({ orgId, multiplier, limits });
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

    const sessions = await getSessionHistory(orgId, { limit, offset, flagged }, await resolveTopologySessionVisibility(auth));
    return c.json({ data: sessions });
  }
);

// GET /admin/security-events - Get AI security and tool audit events
aiRoutes.get(
  '/admin/security-events',
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
    const sinceParam = c.req.query('since');
    const actionFilter = c.req.query('action');

    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days

    const conditions: SQL[] = [
      eq(auditLogs.orgId, orgId),
      gte(auditLogs.timestamp, since),
      drizzleSql`(${auditLogs.action} LIKE 'ai.security.%' OR ${auditLogs.action} LIKE 'ai.tool.%')`,
    ];
    const siteCondition = topologyAuditSessionCondition(await resolveTopologySessionVisibility(auth));
    if (siteCondition) conditions.push(siteCondition);

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

    // #6577: rows written before the write-side sanitiser, and rows from
    // direct createAuditLog writers, can hold raw tool input / credentials in
    // details. Redact on read, as the #5570 (SEC-050) history reads do.
    return c.json({
      data: events.map((event) => ({
        ...event,
        details: redactPersistedToolInput(event.details),
      })),
    });
  }
);

// GET /admin/tool-executions - Get tool execution analytics for AI risk dashboard
aiRoutes.get(
  '/admin/tool-executions',
  requireScope('organization', 'partner', 'system'),
  requireAiSessionsReadAll,
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

    // Base conditions: org-scoped via session join + date range, plus the
    // M4-D2 pinned-site filter — in SQL, so counts, per-tool stats, the time
    // series and the LIMITed list all exclude an unreadable site's session.
    const baseConditions: SQL[] = [
      eq(aiSessions.orgId, orgId),
      gte(aiToolExecutions.createdAt, since),
      lte(aiToolExecutions.createdAt, until),
    ];
    const siteCondition = topologySessionCondition(await resolveTopologySessionVisibility(auth));
    if (siteCondition) baseConditions.push(siteCondition);
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

    // 4. Raw executions list (leftJoin: only reset-password rows have an
    // intent with a revealable secret; everything else derives NULL state)
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
        intentId: aiToolExecutions.intentId,
        tempPasswordState: drizzleSql<'available' | 'revealed' | 'expired' | null>`CASE
          WHEN ${actionIntents.id} IS NULL THEN NULL
          WHEN ${actionIntents.result} ?| array['temporaryPasswordEnc', 'temporaryPassword'] THEN
            CASE
              WHEN ${actionIntents.executedAt} < now() - make_interval(days => ${REVEAL_WINDOW_DAYS}) THEN 'expired'
              ELSE 'available'
            END
          WHEN ${actionIntents.result} ? 'temporaryPasswordRevealed' THEN 'revealed'
          WHEN ${actionIntents.result} ? 'temporaryPasswordExpired' THEN 'expired'
          ELSE NULL
        END`,
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .leftJoin(actionIntents, eq(aiToolExecutions.intentId, actionIntents.id))
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
      executions: executions.map((execution) => ({
        ...execution,
        toolInput: redactPersistedToolInput(execution.toolInput),
      })),
    });
  }
);

// GET /admin/script-proposals-metrics - AI Risk Dashboard script-proposal panel (W05, #5612)
aiRoutes.get(
  '/admin/script-proposals-metrics',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    // Same dark-when-off gate as every other AI script authoring surface
    // (routes/ai/scriptProposals.ts) — without it, a deployment with the
    // feature off gets a permanently-empty "Script Proposals" tab instead of
    // the tab simply not answering.
    if (!aiScriptAuthoringEnabled()) return c.json({ error: 'feature_disabled' }, 404);

    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      // Same shape as the populated branch below — ScriptProposalsPanel keys
      // the unattended-run/lane-state cards on `!== undefined`, so a partial
      // shape here would silently drop both cards for a partner/system-scope
      // caller with no orgId instead of showing zero / not-configured.
      return c.json({
        scriptProposals: {
          perDay: [], unattendedRuns: 0, laneState: null,
          reviewerDisagreements: { humanRejectedAfterApprove: 0, humanApprovedAfterReject: 0 },
        },
      });
    }
    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const sinceParam = c.req.query('since');
    const untilParam = c.req.query('until');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const until = untilParam ? new Date(untilParam) : new Date();
    if (isNaN(since.getTime())) return c.json({ error: `Invalid 'since' date: ${sinceParam}` }, 400);
    if (isNaN(until.getTime())) return c.json({ error: `Invalid 'until' date: ${untilParam}` }, 400);

    // 1. Proposals per day
    const perDayRows = await db
      .select({
        date: drizzleSql<string>`DATE(${scriptProposals.createdAt})::text`,
        count: drizzleSql<number>`COUNT(*)::int`,
      })
      .from(scriptProposals)
      .where(and(eq(scriptProposals.orgId, orgId), gte(scriptProposals.createdAt, since), lte(scriptProposals.createdAt, until)))
      .groupBy(drizzleSql`DATE(${scriptProposals.createdAt})`)
      .orderBy(drizzleSql`DATE(${scriptProposals.createdAt}) ASC`);
    const perDay = perDayRows.map((row) => ({ date: row.date, count: Number(row.count) }));

    // 2. Reviewer disagreements — a human decision that goes against the
    // latest completed model review. Extracted to services/scriptProposals/
    // metrics.ts (raw SQL, DISTINCT ON) so a live-Postgres test can exercise
    // it directly.
    const reviewerDisagreements = await loadScriptProposalReviewerDisagreements(orgId, since, until);

    // 3. Unattended runs in the window (W04, #5612)
    const [unattendedCountRow] = await db
      .select({ count: drizzleSql<number>`COUNT(*)::int` })
      .from(scriptExecutions)
      .where(
        and(
          eq(scriptExecutions.orgId, orgId),
          eq(scriptExecutions.approvalMethod, 'unattended_reviewer_gated'),
          gte(scriptExecutions.createdAt, since),
          lte(scriptExecutions.createdAt, until),
        ),
      );
    const unattendedRuns = Number(unattendedCountRow?.count ?? 0);

    // 4. Lane state (W04) — one row per org, PK org_id; no row means the
    // lane has never been evaluated for this org.
    const [laneRow] = await db
      .select({ state: aiScriptLaneState.state })
      .from(aiScriptLaneState)
      .where(eq(aiScriptLaneState.orgId, orgId))
      .limit(1);
    const laneState = laneRow?.state ?? null;

    return c.json({
      scriptProposals: {
        perDay,
        unattendedRuns,
        laneState,
        reviewerDisagreements,
      },
    });
  }
);
