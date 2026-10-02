/**
 * POST /ai/sessions/:id/continue — AI model registry W05 (#7603; spec §9.2,
 * §15 #4). A model switch that cannot resume continues in a NEW chat on the
 * target offering, linked back to the old one (`continued_from_session_id`,
 * a composite same-org self-FK) and seeded with a summary the TARGET writes.
 *
 * Registered in routes/ai.ts and loaded lazily from there (like the topology
 * turn), so the resolver / candidate-loader graph loads only for this route.
 *
 * D12: the route is in selfManagedDbContextRoutes. No request transaction is
 * held across the handler: the owner-bound read and the session insert each
 * run in a short caller-scoped context, and the resolver, the reservation,
 * the provider call and the settlement (each its own system transaction, or
 * none) run between them with no connection checked out (#1105).
 *
 * Billing copies the ticket-draft one-shot: a SESSIONLESS reservation under
 * its own key prefix, budget-bounded output, settled through settleInvocation
 * with `sessionId: null` — an unrecorded or failed settlement holds the
 * reservation indeterminate; only an unsent request is released.
 *
 * The summary is untrusted model output: it reaches the new chat's model only
 * as delimited, sanitised background on its FIRST user turn (routes/ai.ts
 * messages route), never in a system prompt.
 */
import type { Context } from 'hono';
import type { AiModelChoice } from '@breeze/shared';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { withSystemDbAccessContext } from '../db';
import { getSessionMessages } from '../services/aiAgent';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { checkBudgetDetailed } from '../services/aiCostTracker';
import {
  isAiBudgetLockTimeout,
  markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
} from '../services/aiBudgetReservations';
import { writeRouteAudit } from '../services/auditEvents';
import { getEffectiveAiBudget } from '../services/effectiveSettings';
import { captureException } from '../services/sentry';
import { readOrgPartnerId } from '../services/aiModels/candidateLoader';
import { anthropicClientFor, type MessageAttempt } from '../services/aiModels/connectionFactory';
import {
  CONTINUATION_SUMMARY_MAX_TOKENS,
  ContinuationSummaryFailedError,
  fitContinuationTranscript,
  insertContinuationSession,
  summarizeForContinuation,
} from '../services/aiModels/continuation';
import { InvalidSessionModelError } from '../services/aiModels/invalidSessionModelError';
import { messagesUsage, messagesUsageAfterDispatchError } from '../services/aiModels/invocationUsage';
import { hasActiveChatTurn } from '../services/aiModels/modelTransition';
import { oneShotUnavailableAnswer } from '../services/aiModels/oneShotUnavailable';
import { resolveModel } from '../services/aiModels/resolveModel';
import { safeErrorMessage } from '../services/aiModels/safeDbError';
import { chooseSessionModel, type SessionModelChoice } from '../services/aiModels/sessionModel';
import { settleInvocation } from '../services/aiModels/settleInvocation';
import { turnBindingFrom } from '../services/aiModels/turnBinding';
import { AI_NOT_CONFIGURED_BODY, LlmNotConfiguredError } from '../services/llm/llmAvailability';
import { LlmUnavailableError } from '../services/llm/llmConfigResolver';

/** The idempotency-key prefix of a continuation summary's reservation (never `chat:`). */
export const CONTINUATION_KEY_PREFIX = 'continuation:';

export async function continueAiSession(
  c: Context,
  input: { auth: AuthContext; sessionId: string; choice: AiModelChoice },
): Promise<Response> {
  const { auth, sessionId, choice } = input;
  const inRequestDb = <T>(fn: () => Promise<T>): Promise<T> => withAuthDbAccessContext(auth, fn);

  // Owner-bound (SR5-09): only the chat's own user may continue it.
  const loaded = await inRequestDb(() => getSessionMessages(sessionId, auth));
  if (!loaded) return c.json({ error: 'Session not found' }, 404);
  const { session, messages } = loaded;
  // Only a general chat continues (topology and script builder sessions have
  // no such switch).
  if (session.type !== 'general') {
    return c.json({ error: 'This chat cannot be continued in a new chat.', code: 'continuation_unsupported' }, 400);
  }
  // A reply in flight on this replica, or on ANY replica (an active
  // chat-turn reservation; Codex review finding 11): summarise only a
  // settled transcript.
  if (streamingSessionManager.get(sessionId)?.state === 'processing'
    || await hasActiveChatTurn({ orgId: session.orgId, sessionId })) {
    return c.json({ error: 'A reply is still running in this chat. Try again when it finishes.', code: 'turn_in_progress' }, 409);
  }
  const partnerId = await readOrgPartnerId(session.orgId);
  if (!partnerId) return c.json({ error: 'ai_unavailable' }, 503);

  // The new chat's model: a strict USER choice on the chat surface (no
  // bounded fallback; allow_user_choice and the permitted set apply).
  let target: SessionModelChoice;
  try {
    target = await chooseSessionModel({
      partnerId, orgId: session.orgId, userId: auth.user.id, surface: 'chat',
      offeringId: choice.offeringId, ...(choice.options ? { options: choice.options } : {}),
    });
  } catch (err) {
    if (err instanceof InvalidSessionModelError) return c.json({ error: err.message, code: err.code, recoverable: true }, 409);
    if (err instanceof LlmNotConfiguredError) return c.json(AI_NOT_CONFIGURED_BODY, 503);
    if (err instanceof LlmUnavailableError) return c.json({ error: 'ai_unavailable' }, 503);
    throw err;
  }

  // The summary: the same offering, resolved (strict user origin, default
  // options) for the Messages API one-shot.
  const summaryModel = await resolveModel({
    partnerId, orgId: session.orgId, userId: auth.user.id, surface: 'chat',
    requested: { offeringId: choice.offeringId, origin: 'user' },
    transport: 'messages_api', maxTokens: CONTINUATION_SUMMARY_MAX_TOKENS,
  });
  if (!summaryModel.ok) {
    const answer = oneShotUnavailableAnswer(summaryModel);
    return c.json(answer.body, answer.status);
  }
  let client;
  try {
    client = anthropicClientFor(summaryModel, { surface: 'one_shot_continuation_summary', orgId: session.orgId });
  } catch (err) {
    if (err instanceof LlmUnavailableError) return c.json({ error: 'ai_unavailable' }, 503);
    throw err;
  }
  // reserveAiBudget enforces caps, NOT prepaid credits or the plan gate —
  // check them with the resolved funding before reserving.
  const denial = await checkBudgetDetailed(session.orgId, summaryModel.funding);
  if (denial) return c.json({ error: denial.message }, 402);

  const binding = turnBindingFrom(summaryModel);
  // SESSIONLESS on purpose (ticket-draft precedent): the summary is not a
  // turn of either chat. Bound to a session it would stamp this one-shot's
  // binding onto that session, and its own key prefix keeps it out of the
  // chat-turn reads (readPreviousTurn / hasActiveChatTurn match `chat:`).
  // S8: no stable request identity reaches this surface, so the key is
  // random per dispatch — a structural uniqueness guarantee, not a replay guard.
  let reservation;
  try {
    reservation = await reserveAiBudget({
      orgId: session.orgId,
      idempotencyKey: `${CONTINUATION_KEY_PREFIX}${sessionId}:${crypto.randomUUID()}`,
      billingSource: summaryModel.funding,
      binding,
    });
  } catch (err) {
    if (isAiBudgetLockTimeout(err)) return c.json({ error: 'AI_BUDGET_LOCK_TIMEOUT' }, 503);
    throw err;
  }
  if (reservation.kind === 'denied') return c.json({ error: reservation.message }, 429);
  const reservationId = reservation.reservationId;

  // Ledger rows carry sessionId null deliberately (as the ticket draft):
  // surface 'chat', source_ref 'continuation_summary'.
  const holdIndeterminate = () => markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId })
    .catch((markError) => {
      captureException(new Error(`continuation reservation not retained as indeterminate: ${safeErrorMessage(markError)}`), undefined, {
        org_id: session.orgId, ai_reservation_id: reservationId,
      });
    });
  // Best effort, never throws: a settlement failure (or an unrecorded
  // deferral, S1) holds the reservation indeterminate — never released.
  const settle = async (attempts: MessageAttempt[], dispatchFailed = false): Promise<void> => {
    try {
      const { usage, outcome } = dispatchFailed
        ? messagesUsageAfterDispatchError(binding, attempts)
        : messagesUsage(binding, attempts);
      const settled = await settleInvocation({
        binding, orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null,
        sourceRef: 'continuation_summary', usage, outcome, reservationId,
      });
      if (settled.unrecorded) await holdIndeterminate();
    } catch (settleError) {
      const message = safeErrorMessage(settleError);
      console.error('[AI] continuation summary settlement failed', { reservationId, error: message });
      captureException(new Error(`continuation summary settlement failed: ${message}`), undefined, {
        org_id: session.orgId, ai_reservation_id: reservationId,
      });
      await holdIndeterminate();
    }
  };
  // Nothing was sent: hand the reservation back.
  const releaseUnsent = () => releaseUnusedAiBudgetReservation({ orgId: session.orgId, reservationId })
    .catch((releaseError) => {
      captureException(new Error(`continuation reservation release failed: ${safeErrorMessage(releaseError)}`), undefined, {
        org_id: session.orgId, ai_reservation_id: reservationId,
      });
    });

  let transcript;
  try {
    transcript = await fitContinuationTranscript({
      messages: messages.map((m) => ({ role: m.role, content: m.content, toolName: m.toolName ?? null })),
      target: summaryModel, orgId: session.orgId,
    });
  } catch (err) {
    await releaseUnsent();
    throw err;
  }

  let summary;
  try {
    summary = await summarizeForContinuation({
      resolved: summaryModel, client, transcript: transcript.text,
      ...(reservation.kind === 'reserved' ? { budgetCents: reservation.reservedCostCents } : {}),
    });
  } catch (err) {
    if (err instanceof ContinuationSummaryFailedError && err.overBudget) {
      await releaseUnsent();
      return c.json({ error: 'Not enough AI budget left to summarise this conversation.' }, 402);
    }
    try {
      if (err instanceof ContinuationSummaryFailedError && err.attempts.length > 0) {
        // The provider answered (at least once): the burned tokens bill —
        // including a refused attempt whose fallback call then threw.
        await settle(err.attempts, err.providerOutcomeUnknown);
      } else if (err instanceof ContinuationSummaryFailedError && err.providerOutcomeUnknown) {
        await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId });
      } else {
        await releaseUnusedAiBudgetReservation({ orgId: session.orgId, reservationId });
      }
    } catch (budgetError) {
      captureException(new Error(`continuation reservation bookkeeping failed: ${safeErrorMessage(budgetError)}`), undefined, {
        org_id: session.orgId, ai_reservation_id: reservationId,
      });
    }
    if (err instanceof LlmUnavailableError) return c.json({ error: 'ai_unavailable' }, 503);
    console.error('[AI] Continuation summary failed:', safeErrorMessage(err));
    captureException(err);
    return c.json({ error: 'Could not summarise this conversation. Try again, or start a new chat.' }, 502);
  }

  // Best-effort cost accounting; never fails the request.
  await settle(summary.attempts);

  // The summary is already billed: a failure from here on must be loud, not
  // an unhandled 500 that hides a charge with nothing to show for it.
  let created;
  try {
    const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(session.orgId));
    created = await inRequestDb(() => insertContinuationSession({
      source: session, userId: auth.user.id, choice: target, maxTurns: budget.maxTurnsPerSession,
      summary: summary.summary, omittedMessages: transcript.omittedMessages,
    }));
  } catch (err) {
    const message = safeErrorMessage(err);
    console.error('[AI] continuation chat not created after its summary was billed', {
      orgId: session.orgId, reservationId, sessionId, error: message,
    });
    captureException(new Error(`continuation chat not created after summary billed: ${message}`), undefined, {
      org_id: session.orgId, ai_reservation_id: reservationId,
    });
    return c.json({
      code: 'continuation_create_failed',
      error: 'The summary was made, but the new chat could not be created. Try again.',
    }, 502);
  }
  writeRouteAudit(c, {
    orgId: session.orgId,
    action: 'ai.session.continue',
    resourceType: 'ai_session',
    resourceId: created.sessionId,
    details: { fromSessionId: sessionId, offeringId: target.offeringId },
  });
  return c.json({ data: created }, 201);
}
