/**
 * The ONLY place an Anthropic client is constructed (aiModelRegistry.contract
 * .test.ts enforces it from W03 Task 17; the legacy builders in
 * llmConfigResolver.ts remain until their last caller is cut over). Credential
 * pinning is a security control and moved here verbatim from
 * llmConfigResolver.ts:
 *   platform → SDK defaults (env-driven, #1412 self-host base URL)
 *   BYOK     → https://api.anthropic.com, ambient bearer cleared
 *   catalog  → guarded fetch pinned to the revision origin, exactly one
 *              credential header (the other nulled), egress audited
 *
 * Key material is passed straight to the SDK constructor and never logged,
 * thrown or returned.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { legacyThinksWhenOmitted } from '../aiModel';
import type { AiBillingSource } from '../aiCostTracker';
import { buildGuardedLlmFetch, type GuardedLlmFetchAttempt } from '../llm/guardedLlmFetch';
// Type-only: a value import of llmConfigResolver closes a module-init cycle
// (→ llmProviderCatalog → providerFidelityHarness → this file).
import type { LlmClientCallerContext, UsableLlmConfig } from '../llm/llmConfigResolver';
import { recordLlmEgressEvent } from '../llm/llmEgressRecorder';
import { LlmUnavailableError } from '../llm/llmUnavailableError';
import { PLATFORM_KEY_MISSING_MESSAGE, reportPlatformKeyMissing } from '../llm/platformKeyAlert';
import type { ResolvedModel } from './resolveModel';
import { toAgentSdkOptions, toMessagesApiParams, type WireParams } from './wireParams';

export const ANTHROPIC_PUBLIC_BASE_URL = 'https://api.anthropic.com';
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type AnthropicClientTarget =
  | { kind: 'platform' }
  | { kind: 'anthropic' }
  | {
      kind: 'endpoint';
      baseUrl: string;
      authMode: 'x-api-key' | 'bearer';
      recordEgress: (attempt: GuardedLlmFetchAttempt) => void;
    };

export function createAnthropicClient(spec: {
  apiKey: string;
  target: AnthropicClientTarget;
  timeout?: number;
  maxRetries?: number;
}): Anthropic {
  const tuning = {
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.maxRetries !== undefined ? { maxRetries: spec.maxRetries } : {}),
  };
  switch (spec.target.kind) {
    case 'platform':
      return new Anthropic({ apiKey: spec.apiKey, ...tuning });
    case 'anthropic':
      return new Anthropic({ apiKey: spec.apiKey, authToken: null, baseURL: ANTHROPIC_PUBLIC_BASE_URL, ...tuning });
    case 'endpoint': {
      const { baseUrl, authMode, recordEgress } = spec.target;
      return new Anthropic({
        baseURL: baseUrl,
        // Exactly one credential header, and the other explicitly nulled so the
        // SDK cannot fall back to an inherited ANTHROPIC_API_KEY /
        // ANTHROPIC_AUTH_TOKEN and leak the platform's credential to a third party.
        ...(authMode === 'x-api-key'
          ? { apiKey: spec.apiKey, authToken: null }
          : { authToken: spec.apiKey, apiKey: null }),
        fetch: buildGuardedLlmFetch({ allowedOrigin: new URL(baseUrl).origin, recordEgress }) as unknown as typeof fetch,
        ...tuning,
      });
    }
  }
}

/**
 * Moved from llmConfigResolver.buildCatalogEgressRecorder (same semantics):
 * with no org in context the attempt cannot be persisted (org-scoped table),
 * so it warns once per client and lets the request proceed — the guarded
 * fetch's origin/SSRF controls are unaffected by the audit row.
 */
function catalogEgressRecorder(input: {
  caller: LlmClientCallerContext | null;
  partnerId: string;
  catalogEntryId: string;
  revisionId: string;
}): (attempt: GuardedLlmFetchAttempt) => void {
  let warned = false;
  return (attempt) => {
    if (!input.caller?.orgId) {
      if (!warned) {
        warned = true;
        console.warn('[connectionFactory] catalog LLM egress could not be audited: no organization in context '
          + `for partner ${input.partnerId} (surface ${input.caller?.surface ?? 'unknown'}).`);
      }
      return;
    }
    recordLlmEgressEvent({
      orgId: input.caller.orgId,
      partnerId: input.partnerId,
      surface: input.caller.surface,
      host: attempt.host,
      resolvedIp: attempt.resolvedIp,
      blocked: attempt.blocked,
      catalogEntryId: input.catalogEntryId,
      revisionId: input.revisionId,
    });
  };
}

export function clientForConnection(config: UsableLlmConfig, caller: LlmClientCallerContext | null): Anthropic {
  if (!config.apiKey?.trim()) {
    // Same hourly deployment alert the legacy getAnthropicClientForPartner sent.
    if (config.source === 'platform') reportPlatformKeyMissing();
    throw new LlmUnavailableError(PLATFORM_KEY_MISSING_MESSAGE);
  }
  if (config.source === 'partner' && config.endpoint.kind === 'catalog') {
    const ep = config.endpoint;
    return createAnthropicClient({
      apiKey: config.apiKey,
      target: {
        kind: 'endpoint',
        baseUrl: ep.baseUrl,
        authMode: ep.authMode,
        recordEgress: catalogEgressRecorder({
          caller, partnerId: config.partnerId, catalogEntryId: ep.catalogEntryId, revisionId: ep.revisionId,
        }),
      },
    });
  }
  return createAnthropicClient({
    apiKey: config.apiKey,
    target: config.source === 'partner' ? { kind: 'anthropic' } : { kind: 'platform' },
  });
}

export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): Anthropic {
  return clientForConnection(resolved.connection.config, caller);
}

/** Agent SDK `query()` model options. `fallbackModel` carries the refusal fallback. */
export function sdkModelOptions(resolved: ResolvedModel): Partial<Options> {
  return {
    model: resolved.wireModel,
    ...(resolved.refusalFallback ? { fallbackModel: resolved.refusalFallback.wireModel } : {}),
    ...toAgentSdkOptions(resolved.wireParams),
  };
}

/**
 * Messages API model params. W01's adapter only ever REDUCES thinking on a
 * one-shot: params are sent only for a model that thinks when they are
 * omitted (W01 keys that on the wire id, legacyThinksWhenOmitted).
 */
export function messagesModelParams(
  resolved: { wireModel: string; wireParams: WireParams },
): Record<string, unknown> {
  return {
    model: resolved.wireModel,
    ...toMessagesApiParams(resolved.wireParams, { thinksWhenOmitted: legacyThinksWhenOmitted(resolved.wireModel) }),
  };
}

export type MessagesBody = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'thinking' | 'output_config'>;
export interface MessageAttempt { wireModel: string; message: Anthropic.Message }
export interface MessageOutcome { message: Anthropic.Message; attempts: MessageAttempt[] }

/**
 * One Messages API call for a resolved model. A refusal fallback is sent
 * server-side (array form only — `fallbacks: "default"` could serve a model we
 * cannot price, spec §14) on Claude API connections, and as exactly one
 * client-side retry on the SAME client for catalog connections.
 */
export async function createMessage(
  client: Anthropic,
  resolved: ResolvedModel,
  body: MessagesBody,
): Promise<MessageOutcome> {
  const wireBetas = resolved.wireParams.betas;
  // §7: a call's max_tokens never exceeds the model's max_output_tokens.
  const cap = resolved.limits.maxOutputTokens;
  const capped: MessagesBody = cap !== null && body.max_tokens > cap ? { ...body, max_tokens: cap } : body;
  const params = { ...capped, ...messagesModelParams(resolved) };
  const fb = resolved.refusalFallback;
  const serverSide = fb !== undefined && resolved.connection.kind !== 'catalog';

  if (serverSide || wireBetas.length > 0) {
    // BetaFallbackParam accepts model/max_tokens/thinking/output_config/speed;
    // messagesModelParams returns only model/thinking/output_config.
    const fbParams = serverSide ? messagesModelParams(fb) : null;
    const message = await client.beta.messages.create({
      ...params,
      betas: [...wireBetas, ...(serverSide ? [SERVER_SIDE_FALLBACK_BETA] : [])],
      ...(fbParams ? { fallbacks: [fbParams] } : {}),
    } as never) as unknown as Anthropic.Message;
    return { message, attempts: [{ wireModel: resolved.wireModel, message }] };
  }

  const first = await client.messages.create(params as never) as Anthropic.Message;
  if (fb && first.stop_reason === 'refusal') {
    const second = await client.messages.create({
      ...capped,
      ...messagesModelParams(fb),
    } as never) as Anthropic.Message;
    return {
      message: second,
      attempts: [{ wireModel: resolved.wireModel, message: first }, { wireModel: fb.wireModel, message: second }],
    };
  }
  return { message: first, attempts: [{ wireModel: resolved.wireModel, message: first }] };
}

export interface DispatchFacts {
  destinationKind: 'platform' | 'anthropic_byok' | 'catalog';
  baseUrl: string | null;
  connectionId: string | null;
  funding: AiBillingSource;
  wireModel: string;
}

export function describeDispatch(resolved: ResolvedModel): DispatchFacts {
  const cfg = resolved.connection.config;
  const baseUrl = cfg.source !== 'partner'
    ? null
    : cfg.endpoint.kind === 'catalog' ? cfg.endpoint.baseUrl : ANTHROPIC_PUBLIC_BASE_URL;
  return {
    destinationKind: resolved.connection.kind,
    baseUrl,
    connectionId: resolved.connection.id,
    funding: resolved.funding,
    wireModel: resolved.wireModel,
  };
}
