import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  ANTHROPIC_PUBLIC_BASE_URL,
  SERVER_SIDE_FALLBACK_BETA,
  clientForConnection,
  createAnthropicClient,
  createMessage,
  describeDispatch,
  messagesModelParams,
  sdkModelOptions,
} from './connectionFactory';
import type { ResolvedModel } from './resolveModel';

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
    clientForConnection(r('platform').connection.config, null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-platform' });
  });
  it('BYOK: pinned to the public API with ambient bearer cleared', () => {
    clientForConnection(r('anthropic_byok').connection.config, null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-partner', authToken: null, baseURL: ANTHROPIC_PUBLIC_BASE_URL });
  });
  it('catalog: exactly one credential header + guarded fetch pinned to the revision origin', () => {
    clientForConnection(r('catalog').connection.config, { surface: 'one_shot_ticket_draft', orgId: 'o1' });
    expect(m.ctor).toHaveBeenCalledWith({
      baseURL: 'https://gw.example.com', authToken: 'sk-partner', apiKey: null, fetch: 'guarded-fetch',
    });
    expect(m.guarded).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://gw.example.com' }));
  });
  it('catalog: the egress recorder stamps caller surface, org and catalog provenance', () => {
    clientForConnection(r('catalog').connection.config, { surface: 'one_shot_ticket_draft', orgId: 'o1' });
    const { recordEgress } = m.guarded.mock.calls[0]![0] as { recordEgress: (a: unknown) => void };
    recordEgress({ host: 'gw.example.com', resolvedIp: null, blocked: false });
    expect(recordLlmEgressEvent).toHaveBeenCalledWith({
      orgId: 'o1', partnerId: 'p1', surface: 'one_shot_ticket_draft', host: 'gw.example.com',
      resolvedIp: null, blocked: false, catalogEntryId: 'cat-1', revisionId: 'rev-1',
    });
  });
  it('catalog with no org in context: not audited, warns once, request proceeds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clientForConnection(r('catalog').connection.config, null);
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
