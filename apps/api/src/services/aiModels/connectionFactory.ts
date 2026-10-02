/**
 * The ONLY place an Anthropic client is constructed (enforced by
 * aiModelRegistry.contract.test.ts; the legacy builders in
 * llmConfigResolver.ts were deleted in W03 Task 17). Credential
 * pinning is a security control and moved here verbatim from
 * llmConfigResolver.ts:
 *   platform → SDK defaults (env-driven, #1412 self-host base URL)
 *   BYOK     → https://api.anthropic.com, ambient bearer cleared
 *   catalog  → guarded fetch pinned to the revision origin, exactly one
 *              credential header (the other nulled), egress audited
 *   gateway  → (W06) the loopback model gateway; the client holds only a
 *              placeholder key and takes a fresh per-request grant, the
 *              gateway holds the credential and guards the real hop
 *
 * Key material is passed straight to the SDK constructor and never logged,
 * thrown or returned.
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { legacyThinksWhenOmitted } from '../aiModel';
import type { AiBillingSource } from '../aiCostTracker';
import { buildGuardedLlmFetch, type GuardedLlmFetchAttempt } from '../llm/guardedLlmFetch';
import {
  getGatewayAdapter,
  getModelGateway,
  type GatewayConnectionConfig,
  type GatewayGrant,
  type GatewayGrantPurpose,
} from './gateway';
import { GATEWAY_TOTAL_TIMEOUT_MS, GRANT_SESSION_TTL_MS } from './gateway/limits';
import { GATEWAY_PLACEHOLDER_KEY } from './gateway/openai/adapter';
import {
  buildClaudeSdkChildEnv,
  buildGatewaySdkChildEnv,
  createIsolatedSdkCwd,
  type IsolatedSdkCwd,
} from './sdkChildEnv';
// Type-only: a value import of llmConfigResolver closes a module-init cycle
// (→ llmProviderCatalog → providerFidelityHarness → this file).
import type { LlmClientCallerContext, UsableLlmConfig } from '../llm/llmConfigResolver';
import { getLlmEgressProxy } from '../llm/llmEgressProxy';
import { recordLlmEgressEvent } from '../llm/llmEgressRecorder';
import { LlmUnavailableError } from '../llm/llmUnavailableError';
import { PLATFORM_KEY_MISSING_MESSAGE, reportPlatformKeyMissing } from '../llm/platformKeyAlert';
// Type-only for the same reason: candidateLoader value-imports llmConfigResolver.
import type { GatewayResolvedConnection, ResolvedConnection } from './candidateLoader';
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
    }
  /**
   * W06: the loopback model gateway. `openGrant` issues a short-lived grant
   * for ONE HTTP request; it is revoked as soon as that response settles. The
   * client itself never holds a grant URL or a credential. W07 widens `dialect`.
   */
  | { kind: 'gateway'; dialect: 'anthropic'; openGrant: () => Promise<GatewayGrant> };

/**
 * The base URL a gateway client is built with. Never dialled: the gateway
 * fetch rewrites it onto a fresh grant per request and refuses any other URL.
 */
export const GATEWAY_CLIENT_BASE_URL = 'http://breeze-model-gateway.invalid';

/** Statuses whose Response may not carry a body (fetch spec). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Hand `res` back with `release` called exactly once when its body has been
 * fully read, errored or cancelled (or at once when there is no body).
 */
function releaseWhenSettled(res: Response, release: () => void): Response {
  let released = false;
  const done = (): void => {
    if (released) return;
    released = true;
    release();
  };
  if (!res.body || NULL_BODY_STATUSES.has(res.status)) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The fetch of a gateway client: one grant per HTTP request (an SDK retry is a
 * new request, so a new grant), revoked when the response settles or the
 * request fails. Plain fetch on purpose — the guarded fetch refuses loopback;
 * the gateway guards the real hop (SSRF policy, pinned DNS, audit, scrub).
 */
function gatewayGrantFetch(openGrant: () => Promise<GatewayGrant>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(`${GATEWAY_CLIENT_BASE_URL}/`)) {
      throw new Error('A gateway client may only target the loopback model gateway.');
    }
    const grant = await openGrant();
    const target = `${grant.baseUrl}${href.slice(GATEWAY_CLIENT_BASE_URL.length)}`;
    let res: Response;
    try {
      res = await fetch(input instanceof Request ? new Request(target, input) : target, init);
    } catch (error) {
      grant.revoke();
      throw error;
    }
    return releaseWhenSettled(res, grant.revoke);
  }) as typeof fetch;
}

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
    case 'gateway':
      // The placeholder key only, never spec.apiKey (a caller cannot route a
      // real credential to the gateway hop), and the ambient bearer nulled so
      // an inherited ANTHROPIC_AUTH_TOKEN cannot ride along either.
      return new Anthropic({
        baseURL: GATEWAY_CLIENT_BASE_URL,
        apiKey: GATEWAY_PLACEHOLDER_KEY,
        authToken: null,
        fetch: gatewayGrantFetch(spec.target.openGrant),
        ...tuning,
      });
    default: {
      const never: never = spec.target;
      throw new Error(`Unknown client target ${String((never as { kind?: string }).kind)}`);
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

function isGatewayConnection(c: ResolvedConnection): c is GatewayResolvedConnection {
  return c.config.source === 'gateway';
}

/**
 * Issue a gateway grant for a resolved gateway-kind model. The grant binds the
 * connection, the org and exactly the wire models the resolver priced (the
 * primary and its refusal fallback); the gateway refuses any other model.
 * Starts the gateway lazily on first use.
 */
export async function openGatewayGrant(
  resolved: ResolvedModel,
  input: { orgId: string | null; aiSessionId: string | null; purpose: GatewayGrantPurpose; ttlMs?: number },
): Promise<GatewayGrant> {
  const conn = resolved.connection;
  if (!isGatewayConnection(conn)) throw new Error('openGatewayGrant on a non-gateway connection');
  const wireModels = [...new Set([
    resolved.wireModel,
    ...(resolved.refusalFallback ? [resolved.refusalFallback.wireModel] : []),
  ])];
  const gateway = await getModelGateway();
  return gateway.grant({
    config: conn.config,
    credential: conn.credential,
    wireModels,
    orgId: input.orgId,
    aiSessionId: input.aiSessionId,
    purpose: input.purpose,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
}

export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): Anthropic {
  const conn = resolved.connection;
  if (isGatewayConnection(conn)) {
    // A dispatch grant is always an org's (its egress audit row is org-keyed):
    // refuse up front, before the caller reserves budget, rather than at send.
    const orgId = caller?.orgId ?? resolved.orgId;
    if (!orgId) throw new LlmUnavailableError('This AI model needs an organization context on this surface.');
    return createAnthropicClient({
      apiKey: GATEWAY_PLACEHOLDER_KEY,
      target: {
        kind: 'gateway',
        dialect: 'anthropic',
        // One grant per request. The TTL is only the backstop for a response
        // nobody reads to the end: the gateway's own whole-request cap.
        openGrant: () => openGatewayGrant(resolved, {
          orgId, aiSessionId: null, purpose: 'dispatch', ttlMs: GATEWAY_TOTAL_TIMEOUT_MS,
        }),
      },
    });
  }
  return clientForConnection(conn.config, caller);
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
/** The SDK request options a one-shot surface may pin (wall clock, no hidden retries). */
export interface MessageRequestOptions { signal?: AbortSignal; maxRetries?: number }
/**
 * One completed provider request. `call` is set by a caller that runs several
 * createMessage calls under one settlement (a retry loop) so the ledger
 * interprets each call's attempts on their own (see invocationUsage.messagesUsage).
 */
export interface MessageAttempt { wireModel: string; message: Anthropic.Message; call?: number }
/**
 * Append one createMessage call's attempts to a running list, tagging them with
 * the next `call` index. A caller whose single settlement spans several calls
 * (a retry or tool loop) uses this so each call's refusal/fallback semantics
 * stay its own. Nothing to append (a throw before any attempt completed) is a no-op.
 */
export function appendCall(into: MessageAttempt[], callAttempts: readonly MessageAttempt[]): void {
  if (callAttempts.length === 0) return;
  const call = into.reduce((n, a) => Math.max(n, (a.call ?? 0) + 1), 0);
  into.push(...callAttempts.map((a) => ({ ...a, call })));
}
export interface MessageOutcome { message: Anthropic.Message; attempts: MessageAttempt[] }

/**
 * A dispatch that failed AFTER at least one provider call completed — today
 * only the client-side refusal retry (catalog connections): the first, refused
 * attempt was billed by the provider and must still be settled. `attempts` are
 * the completed calls; `cause` is the original error of the call that threw.
 * A failure before anything completed is rethrown unwrapped (no attempts).
 */
export class MessageDispatchError extends Error {
  constructor(public readonly attempts: MessageAttempt[], cause: unknown) {
    super(`Messages API dispatch failed after ${attempts.length} completed attempt(s): ${
      cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'MessageDispatchError';
  }
}

/** The completed (billable) attempts a createMessage failure carries; empty for any other error. */
export function attemptsOf(err: unknown): MessageAttempt[] {
  return err instanceof MessageDispatchError ? [...err.attempts] : [];
}

/** The provider/transport error behind a createMessage failure, for status/timeout classification. */
export function dispatchCause(err: unknown): unknown {
  return err instanceof MessageDispatchError ? err.cause : err;
}

/** Server-side `fallbacks` only on the Claude API itself (spec §5.3); every other kind retries client-side. */
export const SERVER_SIDE_FALLBACK_KINDS: ReadonlySet<string> = new Set(['platform', 'anthropic_byok']);

/**
 * One Messages API call for a resolved model. A refusal fallback is sent
 * server-side (array form only — `fallbacks: "default"` could serve a model we
 * cannot price, spec §14) on Claude API connections, and as exactly one
 * client-side retry on the SAME client for catalog and gateway connections.
 */
export async function createMessage(
  client: Anthropic,
  resolved: ResolvedModel,
  body: MessagesBody,
  /** Per-request transport options (abort signal, SDK retries) passed to every dispatch. */
  requestOptions?: MessageRequestOptions,
): Promise<MessageOutcome> {
  const wireBetas = resolved.wireParams.betas;
  // §7: a call's max_tokens never exceeds the model's max_output_tokens.
  const cap = resolved.limits.maxOutputTokens;
  const capped: MessagesBody = cap !== null && body.max_tokens > cap ? { ...body, max_tokens: cap } : body;
  const params = { ...capped, ...messagesModelParams(resolved) };
  const fb = resolved.refusalFallback;
  const serverSide = fb !== undefined && SERVER_SIDE_FALLBACK_KINDS.has(resolved.connection.kind);

  if (serverSide || wireBetas.length > 0) {
    // BetaFallbackParam accepts model/max_tokens/thinking/output_config/speed;
    // messagesModelParams returns only model/thinking/output_config.
    const fbParams = serverSide ? messagesModelParams(fb) : null;
    const message = await client.beta.messages.create({
      ...params,
      betas: [...wireBetas, ...(serverSide ? [SERVER_SIDE_FALLBACK_BETA] : [])],
      ...(fbParams ? { fallbacks: [fbParams] } : {}),
    } as never, ...(requestOptions ? [requestOptions] : [])) as unknown as Anthropic.Message;
    // Server-side fallback is ONE request: a refusal and its fallback come back
    // (with combined usage/iterations) in a single response, so a throw here
    // means no response at all — nothing completed to settle.
    return { message, attempts: [{ wireModel: resolved.wireModel, message }] };
  }

  const first = await client.messages.create(params as never, ...(requestOptions ? [requestOptions] : [])) as Anthropic.Message;
  if (fb && first.stop_reason === 'refusal') {
    let second: Anthropic.Message;
    try {
      second = await client.messages.create({
        ...capped,
        ...messagesModelParams(fb),
      } as never, ...(requestOptions ? [requestOptions] : [])) as Anthropic.Message;
    } catch (error) {
      // The refused first attempt is billed by the provider: never lose it.
      throw new MessageDispatchError([{ wireModel: resolved.wireModel, message: first }], error);
    }
    return {
      message: second,
      attempts: [{ wireModel: resolved.wireModel, message: first }, { wireModel: fb.wireModel, message: second }],
    };
  }
  return { message: first, attempts: [{ wireModel: resolved.wireModel, message: first }] };
}

export interface DispatchFacts {
  destinationKind: ResolvedConnection['kind'];
  baseUrl: string | null;
  connectionId: string | null;
  funding: AiBillingSource;
  wireModel: string;
}

/** Display/audit URL of a gateway connection's upstream. W07 adds cloud arms. */
export function gatewayUpstreamUrl(config: GatewayConnectionConfig): string {
  switch (config.kind) {
    case 'openai_compatible':
      return config.baseUrl;
    default: {
      const never: never = config.kind;
      throw new Error(`Unknown gateway connection kind ${String(never)}`);
    }
  }
}

export function describeDispatch(resolved: ResolvedModel): DispatchFacts {
  const cfg = resolved.connection.config;
  const baseUrl = cfg.source === 'gateway'
    ? gatewayUpstreamUrl(cfg)
    : cfg.source !== 'partner'
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

/**
 * CONNECT-proxy grant for an Agent SDK child talking to a catalog endpoint
 * (moved from streamingSessionManager.getOrCreate, W03 Task 12, so chat and
 * agent runs share one implementation). The child may open exactly one
 * destination — the revision's host on 443 — through the local allowlisting
 * proxy; every CONNECT is audited as `sdk_proxy_connect`, and one
 * `sdk_session_create` row records the target even if the child never
 * connects. Null for platform / direct-Anthropic connections (no grant
 * needed). Throws if the proxy cannot start: never start an unproxied child.
 */
export async function grantCatalogSdkEgress(
  resolved: ResolvedModel,
  input: { key: string; orgId: string; aiSessionId: string | null },
): Promise<{ proxyUrl: string; revoke: () => void } | null> {
  const cfg = resolved.connection.config;
  if (cfg.source !== 'partner' || cfg.endpoint.kind !== 'catalog') return null;
  const endpoint = cfg.endpoint;
  const host = new URL(endpoint.baseUrl).hostname;
  const provenance = {
    orgId: input.orgId,
    partnerId: cfg.partnerId,
    catalogEntryId: endpoint.catalogEntryId,
    revisionId: endpoint.revisionId,
    aiSessionId: input.aiSessionId,
  };
  const proxy = await getLlmEgressProxy();
  const proxyUrl = proxy.grant(input.key, { host, port: 443 }, (attempt) => {
    // Synchronous and fire-and-forget by the recorder's contract; it runs
    // inside the proxy's socket handler.
    recordLlmEgressEvent({
      ...provenance, surface: 'sdk_proxy_connect', host: attempt.host, resolvedIp: attempt.resolvedIp, blocked: attempt.blocked,
    });
  }).proxyUrl;
  recordLlmEgressEvent({ ...provenance, surface: 'sdk_session_create', host, resolvedIp: null, blocked: false });
  return { proxyUrl, revoke: () => proxy.revoke(input.key) };
}

export interface SdkChildDispatch {
  env: Record<string, string>;
  /**
   * Gateway kinds only: an empty, private working directory the child must be
   * spawned in (the Agent SDK `cwd` option), so the environment context the
   * CLI sends to the untrusted endpoint carries no repository or host path.
   * Removed by `revoke`. Undefined for every other kind (spawn unchanged).
   */
  cwd?: string;
  /** Releases every grant the child was given (and its `cwd`). Idempotent; call it on EVERY exit path. */
  revoke: () => void;
}

/**
 * THE seam for spawning an Agent SDK child for a resolved model (W06). Used by
 * both spawn sites (chat streamingSessionManager.getOrCreate, aiAgents/runLoop).
 *   gateway kinds → gateway grant (session TTL) + adapter env + a deny-all,
 *                   audited CONNECT grant; the child env carries no credential,
 *                   and the child runs in an empty temp `cwd`
 *   catalog       → CONNECT grant + catalog env (unchanged)
 *   platform/BYOK → env (unchanged)
 * Throws, holding nothing, if any grant cannot be issued: never start an
 * unproxied or ungranted child.
 */
export async function prepareSdkChild(
  resolved: ResolvedModel,
  input: { key: string; orgId: string; aiSessionId: string | null; source?: NodeJS.ProcessEnv },
): Promise<SdkChildDispatch> {
  const conn = resolved.connection;
  if (isGatewayConnection(conn)) {
    const proxy = await getLlmEgressProxy();
    // A per-dispatch proxy key: a late revoke from a torn-down child can never
    // cancel the deny-all grant of a child that replaced it under input.key.
    const proxyKey = `${input.key}:gateway:${randomUUID()}`;
    const provenance = {
      orgId: input.orgId, partnerId: conn.config.partnerId, aiSessionId: input.aiSessionId, connectionId: conn.id,
    };
    const denied = proxy.grant(proxyKey, null, (attempt) => {
      recordLlmEgressEvent({
        ...provenance, surface: 'sdk_proxy_connect', host: attempt.host, resolvedIp: attempt.resolvedIp, blocked: attempt.blocked,
      });
    });
    let grant: GatewayGrant | null = null;
    let isolatedCwd: IsolatedSdkCwd | null = null;
    let revoked = false;
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      try {
        try { grant?.revoke(); } finally { proxy.revoke(proxyKey); }
      } finally {
        isolatedCwd?.remove();
      }
    };
    try {
      isolatedCwd = await createIsolatedSdkCwd();
      grant = await openGatewayGrant(resolved, {
        orgId: input.orgId, aiSessionId: input.aiSessionId, purpose: 'dispatch', ttlMs: GRANT_SESSION_TTL_MS,
      });
      const adapterEnv = getGatewayAdapter(conn.kind).sdkChildEnv({
        gatewayBaseUrl: grant.baseUrl, config: conn.config, wireModel: resolved.wireModel,
      });
      const env = buildGatewaySdkChildEnv({ adapterEnv, denyProxyUrl: denied.proxyUrl, source: input.source });
      recordLlmEgressEvent({
        ...provenance, surface: 'sdk_session_create',
        host: new URL(gatewayUpstreamUrl(conn.config)).hostname, resolvedIp: null, blocked: false,
      });
      return { env, cwd: isolatedCwd.cwd, revoke };
    } catch (error) {
      revoke();
      throw error;
    }
  }
  const egress = await grantCatalogSdkEgress(resolved, { key: input.key, orgId: input.orgId, aiSessionId: input.aiSessionId });
  try {
    const env = buildClaudeSdkChildEnv(conn.config, input.source ?? process.env, egress ? { egressProxyUrl: egress.proxyUrl } : {});
    return { env, revoke: () => egress?.revoke() };
  } catch (error) {
    egress?.revoke();
    throw error;
  }
}
