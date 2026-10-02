import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ctor: vi.fn(),
  create: vi.fn(),
  betaCreate: vi.fn(),
  guarded: vi.fn((_opts: unknown) => 'guarded-fetch'),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: m.create };
    beta = { messages: { create: m.betaCreate } };
    constructor(opts: unknown) { m.ctor(opts); }
  },
}));
vi.mock('../llm/guardedLlmFetch', () => ({ buildGuardedLlmFetch: m.guarded }));
vi.mock('../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
const egress = vi.hoisted(() => ({ grant: vi.fn(), revoke: vi.fn() }));
vi.mock('../llm/llmEgressProxy', () => ({ getLlmEgressProxy: vi.fn(async () => egress) }));
vi.mock('../sentry', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./wireParams', () => ({
  toAgentSdkOptions: (w: { thinking?: unknown; effort?: string }) => ({
    ...(w.thinking ? { thinking: w.thinking } : {}), ...(w.effort ? { effort: w.effort } : {}),
  }),
  toMessagesApiParams: (w: { thinking?: unknown; effort?: string }, opts: { thinksWhenOmitted: boolean }) => (
    opts.thinksWhenOmitted
      ? { ...(w.thinking ? { thinking: w.thinking } : {}), ...(w.effort ? { output_config: { effort: w.effort } } : {}) }
      : {}),
}));
// Partial: the real llmConfigResolver import chain reaches config/env, which
// calls resolveDefaultModel at module load.
vi.mock('../aiModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModel')>()),
  legacyThinksWhenOmitted: () => true,
}));

import { LlmUnavailableError } from '../llm/llmConfigResolver';
import { recordLlmEgressEvent } from '../llm/llmEgressRecorder';
import { __resetPlatformKeyAlertForTests } from '../llm/platformKeyAlert';
import { captureMessage } from '../sentry';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import {
  ANTHROPIC_PUBLIC_BASE_URL,
  SERVER_SIDE_FALLBACK_BETA,
  GATEWAY_CLIENT_BASE_URL,
  SERVER_SIDE_FALLBACK_KINDS,
  anthropicClientFor,
  clientForConnection,
  createAnthropicClient,
  createMessage,
  MessageDispatchError,
  attemptsOf,
  dispatchCause,
  describeDispatch,
  grantCatalogSdkEgress,
  messagesModelParams,
  sdkModelOptions,
} from './connectionFactory';
import type { ResolvedModel } from './resolveModel';
import type { UsableLlmConfig } from '../llm/llmConfigResolver';
import { closeModelGateway, getModelGateway } from './gateway';
import { __setUpstreamFetchForTests } from './gateway/forward';
import { FIXTURE_STD_RATES } from './__fixtures__/resolvedModel';

/** The Anthropic-dialect config of a non-gateway fixture. */
const anthropicConfig = (c: ResolvedModel['connection']): UsableLlmConfig => c.config as UsableLlmConfig;

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const catalogEndpoint = {
  kind: 'catalog' as const, catalogEntryId: 'cat-1', revisionId: 'rev-1', baseUrl: 'https://gw.example.com',
  authMode: 'bearer' as const, providerModel: 'anthropic/claude-sonnet-5.5',
  pricing: { catalogEntryId: 'cat-1', revisionId: 'rev-1', ...STD }, models: {},
};

function r(kind: 'platform' | 'anthropic_byok' | 'catalog', over: Partial<ResolvedModel> = {}): ResolvedModel {
  const config = kind === 'platform'
    ? { source: 'platform' as const, apiKey: 'sk-platform', model: 'claude-sonnet-5-5' }
    : { source: 'partner' as const, partnerId: 'p1', apiKey: 'sk-partner', model: 'claude-sonnet-5-5',
        configId: 'conn-1', configVersion: 2,
        endpoint: kind === 'catalog' ? catalogEndpoint : { kind: 'anthropic' as const } };
  return {
    ok: true, surface: 'chat', role: 'default', transport: 'messages_api', partnerId: 'p1', orgId: 'o1',
    offering: { id: 'off-1', displayName: 'Sonnet' },
    connection: { id: kind === 'platform' ? null : 'conn-1', kind, config },
    funding: kind === 'platform' ? 'platform' : 'partner_key',
    logicalModel: 'claude-sonnet-5-5',
    wireModel: kind === 'catalog' ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' }, inferenceGeo: null, promptProfile: 'claude-standard',
    rateSnapshot: { source: 'platform', standard: STD },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['medium'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: null, maxOutputTokens: null }, fellBack: false,
    ...over,
  } as ResolvedModel;
}

const FALLBACK = {
  offeringId: 'fb', displayName: 'Haiku', wireModel: 'claude-haiku-4-5',
  wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'platform' as const, standard: STD },
};

beforeEach(() => vi.clearAllMocks());

describe('clientForConnection — credential pinning moved verbatim from llmConfigResolver', () => {
  it('platform: SDK defaults, apiKey only', () => {
    clientForConnection(anthropicConfig(r('platform').connection), null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-platform' });
  });
  it('BYOK: pinned to the public API with ambient bearer cleared', () => {
    clientForConnection(anthropicConfig(r('anthropic_byok').connection), null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-partner', authToken: null, baseURL: ANTHROPIC_PUBLIC_BASE_URL });
  });
  it('catalog: exactly one credential header + guarded fetch pinned to the revision origin', () => {
    clientForConnection(anthropicConfig(r('catalog').connection), { surface: 'one_shot_ticket_draft', orgId: 'o1' });
    expect(m.ctor).toHaveBeenCalledWith({
      baseURL: 'https://gw.example.com', authToken: 'sk-partner', apiKey: null, fetch: 'guarded-fetch',
    });
    expect(m.guarded).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://gw.example.com' }));
  });
  it('catalog: the egress recorder stamps caller surface, org and catalog provenance', () => {
    clientForConnection(anthropicConfig(r('catalog').connection), { surface: 'one_shot_ticket_draft', orgId: 'o1' });
    const { recordEgress } = m.guarded.mock.calls[0]![0] as { recordEgress: (a: unknown) => void };
    recordEgress({ host: 'gw.example.com', resolvedIp: null, blocked: false });
    expect(recordLlmEgressEvent).toHaveBeenCalledWith({
      orgId: 'o1', partnerId: 'p1', surface: 'one_shot_ticket_draft', host: 'gw.example.com',
      resolvedIp: null, blocked: false, catalogEntryId: 'cat-1', revisionId: 'rev-1',
    });
  });
  it('catalog with no org in context: not audited, warns once, request proceeds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clientForConnection(anthropicConfig(r('catalog').connection), null);
    const { recordEgress } = m.guarded.mock.calls[0]![0] as { recordEgress: (a: unknown) => void };
    recordEgress({ host: 'gw.example.com', resolvedIp: null, blocked: false });
    recordEgress({ host: 'gw.example.com', resolvedIp: null, blocked: false });
    expect(recordLlmEgressEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-partner');
    warn.mockRestore();
  });
  it('a blank platform key is LlmUnavailableError, never a keyless client', () => {
    expect(() => clientForConnection({ source: 'platform', apiKey: ' ', model: 'x' }, null)).toThrow(LlmUnavailableError);
    expect(m.ctor).not.toHaveBeenCalled();
  });
  it('a blank platform key alerts the deployment config error at most hourly, with the legacy event code (W03 Task 7)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
      vi.mocked(captureMessage).mockClear();
      __resetPlatformKeyAlertForTests();
      expect(() => clientForConnection({ source: 'platform', apiKey: '', model: 'x' }, null))
        .toThrow('AI is not configured on this deployment.');
      expect(() => clientForConnection({ source: 'platform', apiKey: undefined, model: 'x' }, null)).toThrow(LlmUnavailableError);
      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledWith('AI is not configured on this deployment.', { eventCode: 'llm_platform_key_missing' });
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(() => clientForConnection({ source: 'platform', apiKey: ' ', model: 'x' }, null)).toThrow(LlmUnavailableError);
      expect(captureMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createAnthropicClient', () => {
  it('x-api-key endpoint: apiKey header, bearer nulled; tuning passed through', () => {
    createAnthropicClient({
      apiKey: 'k', timeout: 5, maxRetries: 1,
      target: { kind: 'endpoint', baseUrl: 'https://gw.example.com/v1', authMode: 'x-api-key', recordEgress: () => {} },
    });
    expect(m.ctor).toHaveBeenCalledWith({
      baseURL: 'https://gw.example.com/v1', apiKey: 'k', authToken: null, fetch: 'guarded-fetch', timeout: 5, maxRetries: 1,
    });
    expect(m.guarded).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://gw.example.com' }));
  });
});

describe('sdkModelOptions', () => {
  it('wire model + W01 thinking/effort + fallbackModel for a refusal fallback', () => {
    expect(sdkModelOptions(r('platform', { refusalFallback: FALLBACK }))).toEqual({
      model: 'claude-sonnet-5-5', fallbackModel: 'claude-haiku-4-5',
      thinking: { type: 'adaptive' }, effort: 'medium',
    });
  });
  it('no fallbackModel without a refusal fallback', () => {
    expect(sdkModelOptions(r('platform'))).not.toHaveProperty('fallbackModel');
  });
});

describe('messagesModelParams', () => {
  it('wire model + W01 messages params', () => {
    expect(messagesModelParams(r('platform'))).toEqual({
      model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    });
  });
});

describe('createMessage', () => {
  const reply = (stop: string) => ({ model: 'm', stop_reason: stop, content: [], usage: { input_tokens: 1, output_tokens: 1 } });

  it('plain call: messages.create with the wire model and W01 params', async () => {
    m.create.mockResolvedValue(reply('end_turn'));
    const out = await createMessage({ messages: { create: m.create } } as never, r('platform'),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).toHaveBeenCalledWith({
      max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    });
    expect(out.attempts).toHaveLength(1);
  });

  it('clamps max_tokens to the model\'s max_output_tokens (§7)', async () => {
    m.create.mockResolvedValue(reply('end_turn'));
    await createMessage({ messages: { create: m.create } } as never,
      r('platform', { limits: { maxInputTokens: null, maxOutputTokens: 64 } }),
      { max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create.mock.calls[0]![0]).toMatchObject({ max_tokens: 64 });
  });

  it('Claude API refusal fallback: server-side `fallbacks` array form + beta, one call', async () => {
    m.betaCreate.mockResolvedValue(reply('end_turn'));
    const client = { messages: { create: m.create }, beta: { messages: { create: m.betaCreate } } };
    await createMessage(client as never, r('anthropic_byok', { refusalFallback: FALLBACK }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.betaCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-5-5',
      fallbacks: [{ model: 'claude-haiku-4-5' }],
      betas: [SERVER_SIDE_FALLBACK_BETA],
    }));
  });

  it('wire betas without a fallback: beta endpoint, no `fallbacks`', async () => {
    m.betaCreate.mockResolvedValue(reply('end_turn'));
    const client = { messages: { create: m.create }, beta: { messages: { create: m.betaCreate } } };
    await createMessage(client as never,
      r('platform', { wireParams: { betas: ['some-beta'], applied: {} } }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    const sent = m.betaCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.betas).toEqual(['some-beta']);
    expect(sent).not.toHaveProperty('fallbacks');
  });

  it('catalog refusal fallback: client-side, exactly one retry on the same client', async () => {
    m.create.mockResolvedValueOnce(reply('refusal')).mockResolvedValueOnce(reply('end_turn'));
    const fb = { ...FALLBACK, wireModel: 'anthropic/claude-haiku-4.5' };
    const out = await createMessage({ messages: { create: m.create } } as never, r('catalog', { refusalFallback: fb }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.create.mock.calls[1]![0]).toMatchObject({ model: 'anthropic/claude-haiku-4.5' });
    expect(out.attempts.map((a) => a.wireModel)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5']);
  });

  it('request options (wall clock, no SDK retries) reach every dispatch, including the client-side refusal retry', async () => {
    m.create.mockResolvedValueOnce(reply('refusal')).mockResolvedValueOnce(reply('end_turn'));
    const opts = { signal: AbortSignal.timeout(1000), maxRetries: 0 };
    await createMessage({ messages: { create: m.create } } as never, r('catalog', { refusalFallback: { ...FALLBACK, wireModel: 'anthropic/claude-haiku-4.5' } }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, opts);
    expect(m.create.mock.calls[0]![1]).toBe(opts);
    expect(m.create.mock.calls[1]![1]).toBe(opts);
  });

  it('catalog refusal fallback that THROWS: MessageDispatchError carries the refused (billed) first attempt and the cause', async () => {
    const refused = reply('refusal');
    const cause = new Error('socket hang up');
    m.create.mockResolvedValueOnce(refused).mockRejectedValueOnce(cause);
    const fb = { ...FALLBACK, wireModel: 'anthropic/claude-haiku-4.5' };
    const err = await createMessage({ messages: { create: m.create } } as never, r('catalog', { refusalFallback: fb }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageDispatchError);
    expect((err as MessageDispatchError).cause).toBe(cause);
    expect(attemptsOf(err)).toEqual([{ wireModel: 'anthropic/claude-sonnet-5.5', message: refused }]);
    expect(dispatchCause(err)).toBe(cause);
  });

  it('a throw before any reply (first call, or the single server-side-fallback call) is rethrown as is: nothing completed', async () => {
    const cause = new Error('down');
    m.create.mockRejectedValueOnce(cause);
    const err = await createMessage({ messages: { create: m.create } } as never, r('platform'),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    // Unwrapped, so callers' provider-error classification (status, timeout) still sees the SDK error.
    expect(err).toBe(cause);
    expect(dispatchCause(err)).toBe(cause);
    expect(attemptsOf(err)).toEqual([]);

    m.betaCreate.mockRejectedValueOnce(cause);
    const client = { messages: { create: m.create }, beta: { messages: { create: m.betaCreate } } };
    const err2 = await createMessage(client as never, r('anthropic_byok', { refusalFallback: FALLBACK }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(attemptsOf(err2)).toEqual([]);
  });

  it('attemptsOf is empty for any other error', () => {
    expect(attemptsOf(new Error('x'))).toEqual([]);
    expect(attemptsOf(undefined)).toEqual([]);
  });

  it('catalog refusal with no fallback: one call, refusal returned as is', async () => {
    m.create.mockResolvedValueOnce(reply('refusal'));
    const out = await createMessage({ messages: { create: m.create } } as never, r('catalog'),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(out.message.stop_reason).toBe('refusal');
  });
});

describe('describeDispatch', () => {
  it.each([
    ['platform', { destinationKind: 'platform', baseUrl: null, connectionId: null, funding: 'platform', wireModel: 'claude-sonnet-5-5' }],
    ['anthropic_byok', { destinationKind: 'anthropic_byok', baseUrl: ANTHROPIC_PUBLIC_BASE_URL, connectionId: 'conn-1', funding: 'partner_key', wireModel: 'claude-sonnet-5-5' }],
    ['catalog', { destinationKind: 'catalog', baseUrl: 'https://gw.example.com', connectionId: 'conn-1', funding: 'partner_key', wireModel: 'anthropic/claude-sonnet-5.5' }],
  ] as const)('%s', (kind, expected) => {
    expect(describeDispatch(r(kind))).toEqual(expected);
  });
});

describe('grantCatalogSdkEgress (moved from the session manager, W03 Task 12)', () => {
  beforeEach(() => {
    egress.grant.mockReset().mockReturnValue({ proxyUrl: 'http://127.0.0.1:9999' });
    egress.revoke.mockReset();
    vi.mocked(recordLlmEgressEvent).mockClear();
  });

  it.each(['platform', 'anthropic_byok'] as const)('%s: no grant (the child dials Anthropic itself)', async (kind) => {
    await expect(grantCatalogSdkEgress(r(kind), { key: 'k', orgId: 'org-1', aiSessionId: null })).resolves.toBeNull();
    expect(egress.grant).not.toHaveBeenCalled();
  });

  it('catalog: one CONNECT grant to the revision host on 443, audited, revocable by its key', async () => {
    const got = await grantCatalogSdkEgress(r('catalog'), { key: 'agent-run:run-1', orgId: 'org-1', aiSessionId: null });
    expect(got?.proxyUrl).toBe('http://127.0.0.1:9999');
    expect(egress.grant).toHaveBeenCalledWith('agent-run:run-1', { host: 'gw.example.com', port: 443 }, expect.any(Function));
    expect(recordLlmEgressEvent).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'sdk_session_create', host: 'gw.example.com', orgId: 'org-1', partnerId: 'p1',
      catalogEntryId: 'cat-1', revisionId: 'rev-1', aiSessionId: null, blocked: false,
    }));
    // Every CONNECT attempt under the grant is an audit row.
    const onAttempt = egress.grant.mock.calls[0]![2] as (a: { host: string; resolvedIp: string | null; blocked: boolean }) => void;
    onAttempt({ host: 'evil.example.com', resolvedIp: '10.0.0.1', blocked: true });
    expect(recordLlmEgressEvent).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'sdk_proxy_connect', host: 'evil.example.com', blocked: true,
    }));
    got!.revoke();
    expect(egress.revoke).toHaveBeenCalledWith('agent-run:run-1');
  });
});

describe('gateway connections (W06 Task 9)', () => {
  type CtorOpts = { baseURL: string; apiKey: string | null; authToken: string | null; fetch: typeof fetch };
  const upstream: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];

  beforeEach(async () => {
    upstream.length = 0;
    __setUpstreamFetchForTests((async (url: string, init: { body: string; headers: Record<string, string> }) => {
      upstream.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
      return new Response(JSON.stringify({
        id: 'cmpl-1', object: 'chat.completion', model: 'qwen2.5-coder:7b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never);
  });
  afterEach(async () => {
    __setUpstreamFetchForTests(null);
    await closeModelGateway();
  });

  function buildGatewayClient(over: Partial<ResolvedModel> = {}): CtorOpts {
    anthropicClientFor(makeResolvedModel('openai_compatible', over), { surface: 'one_shot_ticket_draft', orgId: 'org-1' });
    return m.ctor.mock.calls.at(-1)![0] as CtorOpts;
  }

  const messagesCall = (f: typeof fetch, model = 'qwen2.5-coder:7b') => f(`${GATEWAY_CLIENT_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'breeze-gateway' },
    body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });

  it('anthropicClientFor builds a gateway client: placeholder key only, ambient bearer nulled, never the guarded fetch', () => {
    const opts = buildGatewayClient();
    expect(opts.baseURL).toBe(GATEWAY_CLIENT_BASE_URL);
    expect(opts.apiKey).toBe('breeze-gateway');
    expect(opts.authToken).toBeNull();
    expect(typeof opts.fetch).toBe('function');
    expect(m.guarded).not.toHaveBeenCalled();
    expect(JSON.stringify(m.ctor.mock.calls)).not.toContain('sk-fixture-upstream');
  });

  it('takes a fresh short-lived grant per request and revokes it once the response settles', async () => {
    const opts = buildGatewayClient();
    const gw = await getModelGateway();
    const grantSpy = vi.spyOn(gw, 'grant');

    const res = await messagesCall(opts.fetch);
    expect(res.status).toBe(200);
    const msg = await res.json() as { content: Array<{ type: string; text: string }>; usage: { input_tokens: number } };
    expect(msg.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(msg.usage.input_tokens).toBe(12);
    // The upstream got the credential; the client never had it.
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(upstream[0]!.headers.authorization).toBe('Bearer sk-fixture-upstream');

    expect(grantSpy).toHaveBeenCalledTimes(1);
    const input = grantSpy.mock.calls[0]![0];
    expect(input).toMatchObject({ orgId: 'org-1', aiSessionId: null, purpose: 'dispatch', wireModels: ['qwen2.5-coder:7b'] });
    expect(input.ttlMs).toBeLessThanOrEqual(15 * 60_000);
    const first = grantSpy.mock.results[0]!.value as { baseUrl: string };
    // Revoked: the grant URL is dead now.
    expect((await fetch(`${first.baseUrl}/v1/models`)).status).toBe(401);

    await (await messagesCall(opts.fetch)).text();
    expect(grantSpy).toHaveBeenCalledTimes(2);
    expect((grantSpy.mock.results[1]!.value as { baseUrl: string }).baseUrl).not.toBe(first.baseUrl);
  });

  it('an upstream failure still revokes the request grant (error body read)', async () => {
    __setUpstreamFetchForTests((async () => { throw new Error('connect ECONNREFUSED'); }) as never);
    const opts = buildGatewayClient();
    const grantSpy = vi.spyOn(await getModelGateway(), 'grant');
    const res = await messagesCall(opts.fetch);
    expect(res.status).toBeGreaterThanOrEqual(500);
    await res.text();
    const g = grantSpy.mock.results[0]!.value as { baseUrl: string };
    expect((await fetch(`${g.baseUrl}/v1/models`)).status).toBe(401);
  });

  it('a cancelled response body revokes the grant too', async () => {
    const opts = buildGatewayClient();
    const grantSpy = vi.spyOn(await getModelGateway(), 'grant');
    const res = await messagesCall(opts.fetch);
    await res.body!.cancel();
    const g = grantSpy.mock.results[0]!.value as { baseUrl: string };
    expect((await fetch(`${g.baseUrl}/v1/models`)).status).toBe(401);
  });

  it('refuses any URL other than the gateway sentinel, issuing no grant', async () => {
    const opts = buildGatewayClient();
    const grantSpy = vi.spyOn(await getModelGateway(), 'grant');
    await expect(opts.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(/loopback model gateway/);
    await expect(opts.fetch('http://breeze-model-gateway.invalid.evil.com/v1/messages')).rejects.toThrow(/loopback model gateway/);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('binds the refusal fallback too, and the gateway refuses any other model', async () => {
    const opts = buildGatewayClient({ refusalFallback: { ...FALLBACK, wireModel: 'qwen-b', rateSnapshot: { source: 'offering', standard: FIXTURE_STD_RATES } } as never });
    const grantSpy = vi.spyOn(await getModelGateway(), 'grant');
    const res = await messagesCall(opts.fetch, 'claude-opus-5');
    expect(res.status).toBe(403);
    await res.text();
    expect(grantSpy.mock.calls[0]![0].wireModels).toEqual(['qwen2.5-coder:7b', 'qwen-b']);
    expect(upstream).toHaveLength(0);
  });

  it('refuses an org-less gateway dispatch up front with a credential-free error and builds no client', () => {
    let thrown: unknown;
    try { anthropicClientFor(makeResolvedModel('openai_compatible', { orgId: null }), null); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(LlmUnavailableError);
    expect((thrown as Error).message).not.toContain('sk-fixture-upstream');
    expect(m.ctor).not.toHaveBeenCalled();
  });

  it('createAnthropicClient never routes a caller-supplied key to the gateway', () => {
    createAnthropicClient({ apiKey: 'sk-should-not-appear', target: { kind: 'gateway', dialect: 'anthropic', openGrant: async () => { throw new Error('unused'); } } });
    expect(JSON.stringify(m.ctor.mock.calls)).not.toContain('sk-should-not-appear');
  });

  it('createMessage never sends server-side fallbacks on a gateway connection (client-side retry instead)', async () => {
    expect(SERVER_SIDE_FALLBACK_KINDS.has('openai_compatible')).toBe(false);
    expect(SERVER_SIDE_FALLBACK_KINDS.has('catalog')).toBe(false);
    m.create
      .mockResolvedValueOnce({ stop_reason: 'refusal', content: [], usage: {} })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [], usage: {} });
    const client = { messages: { create: m.create }, beta: { messages: { create: m.betaCreate } } } as never;
    const resolved = makeResolvedModel('openai_compatible', {
      refusalFallback: { ...FALLBACK, wireModel: 'qwen-b', rateSnapshot: { source: 'offering', standard: FIXTURE_STD_RATES } } as never,
    });
    const out = await createMessage(client, resolved, { max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(out.attempts.map((a) => a.wireModel)).toEqual(['qwen2.5-coder:7b', 'qwen-b']);
    expect(m.betaCreate).not.toHaveBeenCalled();
  });

  it('describeDispatch reports the gateway kind and its base URL', () => {
    expect(describeDispatch(makeResolvedModel('openai_compatible'))).toEqual({
      destinationKind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', connectionId: 'conn-oai',
      funding: 'partner_key', wireModel: 'qwen2.5-coder:7b',
    });
  });

  it('grantCatalogSdkEgress grants nothing for a gateway connection (the gateway, not the CONNECT proxy, carries it)', async () => {
    egress.grant.mockClear();
    await expect(grantCatalogSdkEgress(makeResolvedModel('openai_compatible'), { key: 'k', orgId: 'org-1', aiSessionId: null }))
      .resolves.toBeNull();
    expect(egress.grant).not.toHaveBeenCalled();
  });
});
