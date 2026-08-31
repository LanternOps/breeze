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
  calculateCostCents,
  checkAiRateLimit,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
  deductBillingCredits,
  isPricedModel,
  recordUsage,
} from './aiCostTracker';
import {
  buildAnthropicClient,
  LlmOrgResolutionError,
  markPartnerLlmError,
  resolveLlmConfigForOrg,
  type UsableLlmConfig,
} from './llm/llmConfigResolver';
import { captureException, captureMessage } from './sentry';

const EXTENSION_AI_DEFAULT_MODEL = 'claude-haiku-4-5';

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
      const model = input.model
        ?? process.env.WORKSPACE_CONTENT_LLM_MODEL
        ?? EXTENSION_AI_DEFAULT_MODEL;
      if (!isPricedModel(model)) {
        // PERMANENT: the model id is a deployment constant (a
        // WORKSPACE_CONTENT_LLM_MODEL typo, or an id retired from the pricing
        // table). Every retry reproduces it exactly, so a retrying caller must
        // degrade instead of burning its attempts.
        throw new ExtensionAiError(
          'ai_unavailable',
          `AI model "${model}" is not available for metered extension use.`,
          { permanent: true },
        );
      }

      // Resolve through the ORG (not a re-derived partner id): a missing
      // organization row must abort, never collapse into "no partner" and get
      // billed to the platform key — the one fallback BYOK forbids.
      let resolved;
      try {
        resolved = await resolveLlmConfigForOrg(input.orgId);
      } catch (error) {
        if (error instanceof LlmOrgResolutionError) {
          throw new ExtensionAiError('ai_unavailable', error.message);
        }
        throw error;
      }

      if (resolved.source === 'unavailable') {
        // A partner BYOK config exists but is broken (bad key / unreadable
        // ciphertext). Fail loud for that partner; do NOT serve them platform AI.
        throw new ExtensionAiError(
          'ai_unavailable',
          'AI is unavailable until the partner Anthropic API key is reconnected.',
        );
      }

      if (!resolved.apiKey?.trim()) {
        // No partner key AND no platform key: this deployment simply has no AI.
        // Distinct code so features degrade (skip the AI step) instead of
        // retrying a configuration that is never going to appear on its own.
        throw new ExtensionAiError(
          'not_configured',
          'AI is not configured on this deployment.',
          { permanent: true },
        );
      }

      const usable: UsableLlmConfig = resolved;
      const billingSource = usable.source === 'partner' ? 'partner_key' : 'platform';

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

      const client = buildAnthropicClient(usable);
      let response: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        response = await client.messages.create({
          model,
          max_tokens: input.maxTokens,
          system: input.system,
          messages: input.messages,
        });
      } catch (error) {
        throw await classifyProviderFailure(error, usable);
      }

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;

      await recordUsage(
        null,
        input.orgId,
        model,
        inputTokens,
        outputTokens,
        true,
        billingSource,
      );
      if (billingSource === 'platform') {
        // recordUsage only moves counters; the prepaid credit balance that
        // checkBillingCredits gates on is drawn down here (mirrors what
        // recordUsageFromSdkResult does for the chat path). Partner-key spend is
        // billed by Anthropic to the partner, so it is deliberately excluded.
        await deductBillingCredits(input.orgId, calculateCostCents(model, inputTokens, outputTokens));
      }

      return {
        text,
        model,
        billingSource,
        usage: { inputTokens, outputTokens },
      };
    },
  };
}
