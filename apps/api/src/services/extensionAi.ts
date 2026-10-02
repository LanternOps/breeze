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
import { markPartnerLlmError, type UsableLlmConfig } from './llm/llmConfigResolver';
import { captureException, captureMessage } from './sentry';
import {
  markAiBudgetReservationIndeterminate,
  maxOutputTokensForAiBudget,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
} from './aiBudgetReservations';
import { isPlatformLlmConfigured } from './llm/llmAvailability';
import { reportPlatformKeyMissing } from './llm/platformKeyAlert';
import { findOfferingIdByModel, readOrgPartnerId } from './aiModels/candidateLoader';
import { anthropicClientFor, attemptsOf, createMessage, dispatchCause, type MessageOutcome } from './aiModels/connectionFactory';
import { messagesUsage, messagesUsageAfterDispatchError } from './aiModels/invocationUsage';
import { safeErrorMessage } from './aiModels/safeDbError';
import { ensurePartnerCutover } from './aiModels/registryCutover';
import { resolveModel } from './aiModels/resolveModel';
import { costEstimator, settleInvocation } from './aiModels/settleInvocation';
import { turnBindingFrom } from './aiModels/turnBinding';


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 */
async function classifyProviderFailure(
  error: unknown,
  resolved: UsableLlmConfig,
): Promise<unknown> {
  const status = httpStatusOf(error);

  if (status === 401 || status === 403) {
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

      // S8: no stable request identity on this surface (no client-supplied
      // request id), so the key is random per dispatch — the unique index is a
      // structural guarantee, not a replay guard. Contrast
      // `ai-agent-run:${run.id}` in services/aiAgents/runLoop.ts, which has one.
      const reservation = await reserveAiBudget({
        orgId: input.orgId,
        idempotencyKey: `extension-ai:${crypto.randomUUID()}`,
        billingSource,
        binding,
      });
      if (reservation.kind === 'denied') {
        throw new ExtensionAiError('budget_exceeded', reservation.message, {
          permanent: reservation.reason === 'ai_disabled',
        });
      }
      const reservationId = reservation.reservationId;
      const maxTokens = maxOutputTokensForAiBudget({
        prompt: JSON.stringify({ system: input.system, messages: input.messages }),
        requestedMaxOutputTokens: input.maxTokens,
        budgetCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : undefined,
        calculateCostCents: costEstimator(resolved),
      });
      if (maxTokens === null) {
        // Nothing was sent. A failing release must not replace the budget
        // answer (S8): the hold just expires on its TTL.
        await releaseUnusedAiBudgetReservation({ orgId: input.orgId, reservationId }).catch((releaseError) => {
          const scrubbed = safeErrorMessage(releaseError);
          console.error('[extension-ai] releasing an unused reservation failed', { reservationId, error: scrubbed });
          captureException(new Error(`extension AI reservation release failed: ${scrubbed}`), undefined, {
            org_id: input.orgId, ai_reservation_id: reservationId,
          });
        });
        throw new ExtensionAiError('budget_exceeded', 'The AI request exceeds the remaining budget.');
      }

      const client = anthropicClientFor(resolved, { surface: 'workspace_enrichment', orgId: input.orgId });
      let outcome: MessageOutcome;
      try {
        outcome = await createMessage(client, resolved, {
          max_tokens: maxTokens,
          system: input.system,
          messages: input.messages,
        });
      } catch (error) {
        // A refused attempt that completed before its fallback threw was
        // billed by the provider: settle it. Nothing completed → the outcome
        // is unknown and the reservation stays indeterminate.
        const completed = attemptsOf(error);
        let settled = false;
        if (completed.length > 0) {
          try {
            await settleInvocation({
              binding, orgId: input.orgId, userId: ledgerUserId,
              sessionId: null, agentRunId: null, sourceRef: `extension:${input.surface}`,
              ...messagesUsageAfterDispatchError(binding, completed), reservationId, toolExecutionCount: 1,
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
        throw await classifyProviderFailure(dispatchCause(error), resolved.connection.config);
      }

      const text = outcome.message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('');
      const billed = messagesUsage(binding, outcome.attempts);

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
          binding, orgId: input.orgId, userId: ledgerUserId,
          sessionId: null, agentRunId: null, sourceRef: `extension:${input.surface}`,
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
        billingSource,
        usage: {
          inputTokens: billed.usage.reduce((n, u) => n + u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite, 0),
          outputTokens: billed.usage.reduce((n, u) => n + u.tokens.output, 0),
        },
      };
    },
  };
}
