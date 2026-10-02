/**
 * Host-side metered AI capability handed to extensions as `context.ai`.
 *
 * The extension never sees an API key: it hands us a prompt and we resolve the
 * org's provider (partner BYOK or platform), enforce rate limits and budget,
 * make the call, and record usage BEFORE resolving. Accounting is therefore not
 * skippable by construction, and there is never a silent fallback from a
 * partner key to the platform key.
 */
import {
  ExtensionAiError,
  type ExtensionAiContext,
  type ExtensionAiInvokeInput,
} from '@breeze/extension-sdk';
import {
  checkAiRateLimit,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
} from './aiCostTracker';
import { markPartnerLlmError } from './llm/llmConfigResolver';
import { LlmUnavailableError } from './llm/llmUnavailableError';
import { captureException, captureMessage } from './sentry';
import {
  markAiBudgetReservationIndeterminate,
  maxOutputTokensForAiBudget,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
} from './aiBudgetReservations';
import { isPlatformLlmConfigured } from './llm/llmAvailability';
import { reportPlatformKeyMissing } from './llm/platformKeyAlert';
import { findOfferingIdByModel, readOrgPartnerId, type ResolvedConnection } from './aiModels/candidateLoader';
import { anthropicClientFor, attemptsOf, createMessage, dispatchCause, type MessageOutcome } from './aiModels/connectionFactory';
import {
  FailoverExhaustedError,
  isPreOutputMessagesFailure,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from './aiModels/failoverDispatch';
import { messagesUsage, messagesUsageAfterDispatchError } from './aiModels/invocationUsage';
import { safeErrorMessage } from './aiModels/safeDbError';
import { ensurePartnerCutover } from './aiModels/registryCutover';
import { resolveModel } from './aiModels/resolveModel';
import { costEstimator, settleInvocation } from './aiModels/settleInvocation';
import { turnBindingFrom } from './aiModels/turnBinding';


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failover hop that was reserved but never dispatched (its budget or client was unusable). */
class HopNotDispatchedError extends Error {
  constructor(readonly reason: 'budget' | 'client', cause?: unknown) {
    super(reason === 'budget' ? 'The AI request exceeds the backup model budget.' : 'The backup model client is unavailable.', { cause });
    this.name = 'HopNotDispatchedError';
  }
}

/** Anthropic APIError carries the HTTP status; anything else is a transport error. */
function httpStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Turn a provider rejection into either an `ExtensionAiError` (which callers
 * treat as "abort the whole run") or the original error (which callers treat as
 * a per-request failure they may fail soft on).
 *
 * The distinction is load-bearing and was the pre-BYOK behaviour of
 * `isRetryableApiError` in the workspace enrichment pass: a 429/5xx/network
 * failure is about the PROVIDER and retrying the batch later is right, while a
 * 400/404/413/422 is about THIS request (one oversized or malformed document)
 * and aborting the run over it would drive an ingest job to `failed` on a single
 * poison file. 401/403 is a credential problem, so it aborts too — and, for a
 * partner key, is recorded on the config row so the partner's AI settings stop
 * reporting a key that Anthropic is rejecting.
 *
 * Every ExtensionAiError raised here is TRANSIENT (`permanent` left false),
 * including a rejected partner credential: the partner must keep seeing a loud,
 * visible failure until they reconnect the key, never a feature that has
 * quietly degraded itself.
 *
 * Gateway connections: a 401/403 comes from the loopback model gateway, and
 * the same status means an expired/revoked grant, a model the grant does not
 * bind, or the endpoint rejecting the key — indistinguishable here. None of
 * them may mark the connection broken from this path (an expired grant says
 * nothing about the partner's key); the connection's health is owned by
 * discovery and verification, which talk to the endpoint directly. The
 * failover classification (failover.ts) still treats every gateway status
 * like any provider's: a 401/403/429/5xx fails over and cools the offering,
 * which is a TTL'd routing preference, never a connection status.
 */
async function classifyProviderFailure(
  error: unknown,
  connection: ResolvedConnection,
): Promise<unknown> {
  const status = httpStatusOf(error);

  if (status === 401 || status === 403) {
    const resolved = connection.config;
    // Only a direct partner credential (source 'partner') is ever stamped;
    // a gateway connection (source 'gateway') and the platform key never are.
    if (resolved.source === 'partner') {
      try {
        const stamped = await markPartnerLlmError({
          configId: resolved.configId,
          configVersion: resolved.configVersion,
          reason: 'auth_rejected',
        });
        if (!stamped) {
          // A compare-and-set miss: the config row's id/version moved (the
          // partner rotated or removed the key mid-flight), so NOTHING was
          // written. Treating that as stamped is how a partner's AI settings
          // keep advertising a key Anthropic is rejecting.
          console.warn('[extension-ai] rejected partner credential was NOT stamped (config version moved)', {
            partnerId: resolved.partnerId,
            configVersion: resolved.configVersion,
          });
          captureMessage('Rejected partner AI credential could not be stamped', {
            eventCode: 'ai_partner_key_error_stamp_stale',
            tags: { partner_id: resolved.partnerId },
          });
        }
      } catch (markError) {
        // Recording the rejection is best-effort: never mask the original cause.
        console.error('[extension-ai] failed to mark rejected partner credential', {
          partnerId: resolved.partnerId,
          error: markError,
        });
        // Was silent to Sentry entirely — mirrors llmConfigResolver's own
        // markPartnerLlmError failure path, which does report.
        captureException(markError, undefined, { partner_id: resolved.partnerId });
      }
    }
    return new ExtensionAiError('ai_unavailable', errorMessage(error));
  }

  if (status === 429) {
    return new ExtensionAiError('rate_limited', errorMessage(error));
  }

  // Provider-side (5xx) or transport-level (no status: DNS, socket, timeout).
  if (status === null || status >= 500) {
    return new ExtensionAiError('ai_unavailable', errorMessage(error));
  }

  // Any other 4xx is about this one request — hand it back unchanged.
  return error;
}

export function buildExtensionAiContext(): ExtensionAiContext {
  return {
    async invoke(input: ExtensionAiInvokeInput) {
      const partnerId = await readOrgPartnerId(input.orgId);
      // A missing organization row must abort, never collapse into "no partner"
      // and get billed to the platform key: the one fallback BYOK forbids.
      if (!partnerId) throw new ExtensionAiError('ai_unavailable', 'AI is unavailable for this organization.');
      const ledgerUserId = input.principal.type === 'user' && input.principal.id ? input.principal.id : null;
      let offeringId: string | undefined;
      if (input.model) {
        // The lookup reads assignments: never against a partner not yet cut over. Transient.
        if (!(await ensurePartnerCutover(partnerId))) {
          throw new ExtensionAiError('ai_unavailable', 'AI configuration is being upgraded. Try again in a moment.');
        }
        offeringId = (await findOfferingIdByModel({
          partnerId, orgId: input.orgId, surface: 'extension_content', modelId: input.model,
        })) ?? undefined;
        if (!offeringId) {
          // PERMANENT: a model id the partner has not enabled; every retry reproduces it.
          throw new ExtensionAiError(
            'ai_unavailable',
            `AI model "${input.model}" is not available for extension use.`,
            { permanent: true },
          );
        }
      }
      const resolved = await resolveModel({
        partnerId,
        orgId: input.orgId,
        userId: ledgerUserId,
        surface: 'extension_content',
        maxTokens: input.maxTokens,
        ...(offeringId ? { requested: { offeringId, origin: 'policy' as const } } : {}),
      });
      if (!resolved.ok) {
        if (resolved.reason === 'connection_unavailable') {
          // No platform credential at all: this deployment simply has no AI.
          // Distinct, PERMANENT code so features degrade (skip the AI step)
          // instead of retrying a configuration that will not appear on its own.
          if (!isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk')) {
            reportPlatformKeyMissing();
            throw new ExtensionAiError('not_configured', 'AI is not configured on this deployment.', { permanent: true });
          }
          // A configured connection that is broken (rejected / unreadable key):
          // TRANSIENT and loud. Never degrade quietly, never serve the platform key.
          throw new ExtensionAiError('ai_unavailable', resolved.message);
        }
        throw new ExtensionAiError('ai_unavailable', resolved.message, {
          // registry_unavailable is a transient cutover failure: retryable.
          permanent: resolved.reason !== 'registry_unavailable',
        });
      }
      const billingSource = resolved.funding;
      const binding = turnBindingFrom(resolved);

      const rateLimitError = input.principal.type === 'user' && input.principal.id
        ? await checkAiRateLimit(input.principal.id, input.orgId)
        : await checkSystemAiRateLimit(input.orgId);
      if (rateLimitError) {
        throw new ExtensionAiError('rate_limited', rateLimitError);
      }

      // Detailed form on purpose: `budget_exceeded` covers both a spend cap
      // that rolls over (retry later) and an org/plan with AI switched off
      // (retrying forever is the bug this exists to stop). Only the tracker
      // knows which, so it is the tracker that decides `permanent`.
      const budgetDenial = await checkBudgetDetailed(input.orgId, billingSource);
      if (budgetDenial) {
        throw new ExtensionAiError('budget_exceeded', budgetDenial.message, {
          permanent: budgetDenial.permanent,
        });
      }

      // The first hop's client is built before anything is reserved: a
      // connection that cannot be dispatched (no usable key; a gateway
      // dispatch without an org) is refused here and never strands a
      // reservation. Transient and loud, like a broken partner connection.
      // (A failover hop's client is built after its reservation, which
      // runWithFailover takes; a refusal there releases that reservation —
      // HopNotDispatchedError below.)
      let client: ReturnType<typeof anthropicClientFor>;
      try {
        client = anthropicClientFor(resolved, { surface: 'workspace_enrichment', orgId: input.orgId });
      } catch (error) {
        if (error instanceof LlmUnavailableError) throw new ExtensionAiError('ai_unavailable', error.message);
        throw error;
      }

      // S8: no stable request identity on this surface (no client-supplied
      // request id), so the key is random per dispatch — the unique index is a
      // structural guarantee, not a replay guard. Contrast
      // `ai-agent-run:${run.id}` in services/aiAgents/runLoop.ts, which has one.
      // Hop 0's key; a failover hop n reserves `<key>:hop:<n>` (W09).
      const reservationKey = `extension-ai:${crypto.randomUUID()}`;
      const reservation = await reserveAiBudget({
        orgId: input.orgId,
        idempotencyKey: reservationKey,
        billingSource,
        binding,
      });
      if (reservation.kind === 'denied') {
        throw new ExtensionAiError('budget_exceeded', reservation.message, {
          permanent: reservation.reason === 'ai_disabled',
        });
      }
      const sourceRef = `extension:${input.surface}`;
      const prompt = JSON.stringify({ system: input.system, messages: input.messages });
      // Each hop's output cap comes from ITS OWN reservation and rate (Codex review 6).
      const maxTokensFor = (hop: FailoverHop) => maxOutputTokensForAiBudget({
        prompt,
        requestedMaxOutputTokens: input.maxTokens,
        budgetCents: hop.reservedCostCents ?? undefined,
        calculateCostCents: costEstimator(hop.resolved),
      });
      // Nothing was sent. A failing release must not replace the budget
      // answer (S8): the hold just expires on its TTL.
      const releaseUnsent = (reservationId: string) => releaseUnusedAiBudgetReservation({ orgId: input.orgId, reservationId })
        .then(() => undefined, (releaseError) => {
          const scrubbed = safeErrorMessage(releaseError);
          console.error('[extension-ai] releasing an unused reservation failed', { reservationId, error: scrubbed });
          captureException(new Error(`extension AI reservation release failed: ${scrubbed}`), undefined, {
            org_id: input.orgId, ai_reservation_id: reservationId,
          });
        });
      const firstHop: FailoverHop = {
        index: 0, resolved, binding, reservationId: reservation.reservationId, idempotencyKey: reservationKey,
        reservedCostCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : null,
      };
      const maxTokens = maxTokensFor(firstHop);
      if (maxTokens === null) {
        await releaseUnsent(firstHop.reservationId);
        throw new ExtensionAiError('budget_exceeded', 'The AI request exceeds the remaining budget.');
      }

      const settleFailedHopAtZero = settleZeroUsageHop({
        orgId: input.orgId, userId: ledgerUserId, sessionId: null, agentRunId: null, sourceRef,
      });
      let outcome: MessageOutcome;
      let served: FailoverHop;
      // The hop in flight: failure handling settles THIS hop, never another's.
      let current = firstHop;
      try {
        // W09 (#7607): a pre-output 429/529/5xx/key/quota failure fails over
        // along the extension_content assignment's fallback list; each hop is
        // admitted, reserved and settled on its own (failoverDispatch.ts).
        // With no list the original error comes straight back (W03 behaviour).
        ({ value: outcome, hop: served } = await runWithFailover({
          first: firstHop,
          reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({
            partnerId,
            orgId: input.orgId,
            userId: ledgerUserId,
            surface: 'extension_content',
            maxTokens: input.maxTokens,
            ...(offeringId ? { requested: { offeringId, origin: 'policy' as const } } : {}),
            excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
          }),
          reserveHop: reserveFailoverHop({ orgId: input.orgId }),
          attempt: (hop) => {
            current = hop;
            if (hop.index === 0) {
              return createMessage(client, resolved, { max_tokens: maxTokens, system: input.system, messages: input.messages });
            }
            const hopMaxTokens = maxTokensFor(hop);
            if (hopMaxTokens === null) return Promise.reject(new HopNotDispatchedError('budget'));
            let hopClient: ReturnType<typeof anthropicClientFor>;
            try {
              hopClient = anthropicClientFor(hop.resolved, { surface: 'workspace_enrichment', orgId: input.orgId });
            } catch (clientError) {
              return Promise.reject(new HopNotDispatchedError('client', clientError));
            }
            return createMessage(hopClient, hop.resolved, { max_tokens: hopMaxTokens, system: input.system, messages: input.messages });
          },
          settleFailedHop: async (hop, error) => {
            try {
              await settleFailedHopAtZero(hop);
            } catch (settleError) {
              // Scrubbed (S8); the failed hop's capacity is retained, never released.
              const scrubbed = safeErrorMessage(settleError);
              console.error('[extension-ai] settling a failed-over hop failed', { reservationId: hop.reservationId, error: scrubbed });
              captureException(new Error(`extension AI settlement failed: ${scrubbed}`), undefined, {
                org_id: input.orgId, ai_reservation_id: hop.reservationId,
              });
              await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId: hop.reservationId })
                .catch((markError) => captureException(new Error(`extension AI reservation not retained as indeterminate: ${safeErrorMessage(markError)}`)));
            }
            // A rejected partner credential is still recorded when a backup serves.
            const cause = dispatchCause(error);
            const status = httpStatusOf(cause);
            if (status === 401 || status === 403) await classifyProviderFailure(cause, hop.resolved.connection);
          },
          isPreOutput: isPreOutputMessagesFailure,
        }));
      } catch (error) {
        if (error instanceof FailoverExhaustedError) {
          // Every hop runWithFailover tried is already settled on its own reservation.
          throw new ExtensionAiError('ai_unavailable', error.stop === 'admission_denied' && error.admissionMessage
            ? error.admissionMessage
            : errorMessage(dispatchCause(error.lastError)));
        }
        if (error instanceof HopNotDispatchedError) {
          await releaseUnsent(current.reservationId);
          if (error.reason === 'budget') {
            throw new ExtensionAiError('budget_exceeded', 'The AI request exceeds the remaining budget.');
          }
          throw new ExtensionAiError('ai_unavailable', errorMessage(error.cause));
        }
        const { binding: failedBinding, reservationId } = current;
        // A refused attempt that completed before its fallback threw was
        // billed by the provider: settle it. Nothing completed → the outcome
        // is unknown and the reservation stays indeterminate.
        const completed = attemptsOf(error);
        let settled = false;
        if (completed.length > 0) {
          try {
            await settleInvocation({
              binding: failedBinding, orgId: input.orgId, userId: ledgerUserId,
              sessionId: null, agentRunId: null, sourceRef,
              ...messagesUsageAfterDispatchError(failedBinding, completed), reservationId, toolExecutionCount: 1,
            });
            settled = true;
          } catch (settleError) {
            // Settlement errors are DB errors: scrubbed before any log or report.
            const scrubbed = safeErrorMessage(settleError);
            console.error('[extension-ai] settling a failed dispatch failed', { reservationId, error: scrubbed });
            captureException(new Error(`extension AI settlement failed: ${scrubbed}`), undefined, {
              org_id: input.orgId, ai_reservation_id: reservationId,
            });
          }
        }
        if (!settled) {
          await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId })
            .catch((markError) => captureException(new Error(`extension AI reservation not retained as indeterminate: ${safeErrorMessage(markError)}`)));
        }
        throw await classifyProviderFailure(dispatchCause(error), current.resolved.connection);
      }

      const text = outcome.message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('');
      // Billed, reported and settled on the hop that SERVED (W09 F5).
      const { reservationId } = served;
      const billed = messagesUsage(served.binding, outcome.attempts);

      const holdIndeterminate = () => markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId })
        .catch((markError) => {
          captureException(new Error(`extension AI reservation not retained as indeterminate: ${safeErrorMessage(markError)}`), undefined, {
            org_id: input.orgId, ai_reservation_id: reservationId,
          });
        });
      try {
        // The one billing path: priced from the bound registry rate, written to
        // the ledger, and (platform funding) drawn down from prepaid credits.
        const settled = await settleInvocation({
          binding: served.binding, orgId: input.orgId, userId: ledgerUserId,
          sessionId: null, agentRunId: null, sourceRef,
          ...billed, reservationId, toolExecutionCount: 1,
        });
        // S1: deferred but not persisted (already reported): keep the hold.
        if (settled.unrecorded) await holdIndeterminate();
      } catch (error) {
        // The provider was paid but the spend could not be recorded. Settlement
        // errors are DB errors: never rethrown raw to the extension (S8).
        const scrubbed = safeErrorMessage(error);
        console.error('[extension-ai] settlement after a paid call failed', { reservationId, error: scrubbed });
        captureException(new Error(`extension AI settlement failed: ${scrubbed}`), undefined, {
          org_id: input.orgId, ai_reservation_id: reservationId,
        });
        await holdIndeterminate();
        throw new ExtensionAiError('ai_unavailable', 'AI usage could not be recorded; try again shortly.', { permanent: false });
      }

      return {
        text,
        model: billed.outcome.servedModel,
        billingSource: served.resolved.funding,
        usage: {
          inputTokens: billed.usage.reduce((n, u) => n + u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite, 0),
          outputTokens: billed.usage.reduce((n, u) => n + u.tokens.output, 0),
        },
      };
    },
  };
}
