/**
 * Catalog-endpoint SDK sessions (#3922 phase 2, Wave 3, Task 3.3).
 *
 * Three properties are load-bearing here and each is asserted against the real
 * builder rather than a paraphrase of it:
 *
 *  1. the child env of a catalog session is forced through the local CONNECT
 *     proxy — including DROPPING the parent's proxy variables, since a parent
 *     `NO_PROXY=*` would otherwise let the child dial the provider directly and
 *     skip every SSRF/rebinding control;
 *  2. platform and direct-Anthropic partner sessions are byte-identical to
 *     their pre-catalog behavior — in particular the #1412 hosted
 *     `ANTHROPIC_BASE_URL` fail-closed guard on the PLATFORM path is untouched;
 *  3. a session pinned to a catalog revision rotates when that revision moves,
 *     exactly as it already rotates on key rotation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const {
  queryMock,
  settleInvocationMock,
  capturedQueryArgs,
  grantMock,
  revokeMock,
  getLlmEgressProxyMock,
  recordLlmEgressEventMock,
  sessionUpdates,
  sessionUpdateContexts,
  dbState,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  settleInvocationMock: vi.fn(async (_input: unknown) => ({ costCents: 0, invocationIds: ['i1'], deferred: false })),
  capturedQueryArgs: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  grantMock: vi.fn(
    (
      _sessionId: string,
      _allowed: { host: string; port: 443 },
      _recordEgress: (e: { host: string; resolvedIp: string | null; blocked: boolean }) => void,
    ) => ({ proxyUrl: 'http://breeze:tok@127.0.0.1:45677' }),
  ),
  revokeMock: vi.fn(),
  getLlmEgressProxyMock: vi.fn(),
  recordLlmEgressEventMock: vi.fn(),
  sessionUpdates: [] as Array<Record<string, unknown>>,
  /**
   * Same writes as `sessionUpdates`, but each paired with whether it ran inside
   * a system DB access context. Under forced RLS a contextless write silently
   * matches 0 rows and trips the #1375 guard, so "which context did this run
   * in" is a property of the write, not a detail (#2190).
   */
  sessionUpdateContexts: [] as Array<{
    values: Record<string, unknown>;
    inSystemContext: boolean;
  }>,
  dbState: {
    systemDepth: 0,
    /** Rows the next `.returning()` yields; empty models the 0-row RLS denial. */
    nextReturningRows: [] as Array<Array<{ id: string }>>,
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        sessionUpdates.push(values);
        sessionUpdateContexts.push({ values, inSystemContext: dbState.systemDepth > 0 });
        // Awaitable AND `.returning()`-able: the provenance stamp needs the row
        // count back, everything else on this path just awaits the update.
        return {
          where: vi.fn(() => Object.assign(Promise.resolve(), {
            returning: vi.fn(() =>
              Promise.resolve(dbState.nextReturningRows.shift() ?? [{ id: 'row-1' }])),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
    dbState.systemDepth += 1;
    try {
      return await fn();
    } finally {
      dbState.systemDepth -= 1;
    }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

// W03 Task 7: every turn settles through settleInvocation at the rate bound
// to the turn (here: the catalog revision snapshot). priceUsage / the quote
// stay real so the `done` cost is the actual registry arithmetic.
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: settleInvocationMock,
}));
vi.mock('./aiBudgetReservations', () => ({
  markAiBudgetReservationIndeterminate: vi.fn(async () => undefined),
  readSdkUsageSnapshot: vi.fn(async () => null),
}));
vi.mock('./aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('./aiModels/platformModels')>()),
  getPlatformModelByModelId: vi.fn(async () => null),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(() => false),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (i: unknown) => i,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));
vi.mock('./llm/llmEgressProxy', () => ({ getLlmEgressProxy: getLlmEgressProxyMock }));
vi.mock('./llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: recordLlmEgressEventMock }));

import { StreamingSessionManager, buildClaudeSdkChildEnv } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import type { UsableLlmConfig } from './llm/llmConfigResolver';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { sdkModelOptions } from './aiModels/connectionFactory';
import type { ResolvedModel } from './aiModels/resolveModel';
import { liveQueryKey, turnBindingFrom } from './aiModels/turnBinding';
import type { SettleInvocationInput } from './aiModels/settleInvocation';
import { captureException, captureMessage } from './sentry';
import { closeModelGateway } from './aiModels/gateway';
import * as dbModule from '../db';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER = '1a1a1a1a-1111-4222-8333-444455556666';
const CONFIG_ID = '2b2b2b2b-2222-4222-8222-222222222222';
const ENTRY_ID = '3c3c3c3c-3333-4333-8333-333333333333';
const REVISION_ID = '4d4d4d4d-4444-4444-8444-444444444444';
const PROXY_URL = 'http://breeze:tok@127.0.0.1:45677';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null as string | null,
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@contoso.com' },
} as unknown as AuthContext;

const PLATFORM_CONFIG: UsableLlmConfig = {
  source: 'platform',
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

const DIRECT_PARTNER_CONFIG: UsableLlmConfig = {
  source: 'partner',
  partnerId: PARTNER,
  apiKey: 'partner-key',
  model: 'claude-sonnet-4-6',
  configId: CONFIG_ID,
  configVersion: 1,
  endpoint: { kind: 'anthropic' },
};

const PRICING = {
  catalogEntryId: ENTRY_ID,
  revisionId: REVISION_ID,
  inputCentsPerM: 300,
  outputCentsPerM: 1500,
  cacheReadCentsPerM: 30,
  cacheWriteCentsPerM: 375,
};

const HAIKU_PRICING = {
  catalogEntryId: ENTRY_ID,
  revisionId: REVISION_ID,
  inputCentsPerM: 100,
  outputCentsPerM: 500,
  cacheReadCentsPerM: 10,
  cacheWriteCentsPerM: 125,
};

function catalogConfig(overrides: Partial<{
  authMode: 'x-api-key' | 'bearer';
  revisionId: string;
  providerModel: string;
  apiKey: string;
}> = {}): UsableLlmConfig {
  const revisionId = overrides.revisionId ?? REVISION_ID;
  const providerModel = overrides.providerModel ?? 'anthropic/claude-sonnet-4-6';
  return {
    source: 'partner',
    partnerId: PARTNER,
    apiKey: overrides.apiKey ?? 'partner-key',
    model: 'claude-sonnet-4-6',
    configId: CONFIG_ID,
    configVersion: 1,
    endpoint: {
      kind: 'catalog',
      catalogEntryId: ENTRY_ID,
      revisionId,
      baseUrl: 'https://openrouter.ai/api/v1',
      authMode: overrides.authMode ?? 'x-api-key',
      providerModel,
      pricing: { ...PRICING, revisionId },
      // The default model plus one NON-default verified model: a session's
      // `model` column is client-supplied and can be neither.
      models: {
        'claude-sonnet-4-6': {
          providerModel,
          pricing: { ...PRICING, revisionId },
        },
        'claude-haiku-4-5': {
          providerModel: 'anthropic/claude-haiku-4-5',
          pricing: { ...HAIKU_PRICING, revisionId },
        },
      },
    },
  };
}

/**
 * The ResolvedModel the registry would hand the manager for `config`: the
 * connection half IS the legacy UsableLlmConfig; a catalog connection's wire
 * id and rate come from the pinned revision (W03 Task 7).
 */
function resolvedFor(config: UsableLlmConfig, over: Partial<ResolvedModel> = {}): ResolvedModel {
  const catalog = config.source === 'partner' && config.endpoint.kind === 'catalog' ? config.endpoint : null;
  const kind = config.source === 'platform' ? 'platform' : catalog ? 'catalog' : 'anthropic_byok';
  return makeResolvedModel(kind, {
    partnerId: config.source === 'partner' ? config.partnerId : null,
    connection: { id: config.source === 'partner' ? config.configId : null, kind, config },
    logicalModel: config.model,
    wireModel: catalog ? catalog.providerModel : config.model,
    ...(config.source === 'partner' ? { configVersion: config.configVersion } : {}),
    ...(catalog
      ? {
          catalogRevisionId: catalog.revisionId,
          rateSnapshot: {
            source: 'catalog' as const,
            standard: {
              inputCentsPerM: catalog.pricing.inputCentsPerM,
              outputCentsPerM: catalog.pricing.outputCentsPerM,
              cacheReadCentsPerM: catalog.pricing.cacheReadCentsPerM,
              cacheWriteCentsPerM: catalog.pricing.cacheWriteCentsPerM,
            },
          },
        }
      : {}),
    ...over,
  });
}

const HOSTILE_PARENT_ENV = {
  ANTHROPIC_API_KEY: 'platform-api-key',
  ANTHROPIC_AUTH_TOKEN: 'platform-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'platform-oauth-token',
  ANTHROPIC_BASE_URL: 'https://evil.example/v1',
  IS_HOSTED: 'false',
  PATH: '/usr/bin',
  HOME: '/srv/breeze',
  HTTPS_PROXY: 'http://parent-proxy.local:8080',
  HTTP_PROXY: 'http://parent-proxy.local:8080',
  NO_PROXY: '*',
  https_proxy: 'http://parent-proxy.local:8080',
  http_proxy: 'http://parent-proxy.local:8080',
  no_proxy: '*',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function mockSdkQuery(messages: unknown[], gate: Promise<void>) {
  queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedQueryArgs.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* messages as never[];
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };
  });
}

// ============================================
// Child environment
// ============================================

describe('buildClaudeSdkChildEnv — catalog endpoints', () => {
  it('routes an x-api-key catalog session through the granted proxy and drops the parent proxy vars', () => {
    const env = buildClaudeSdkChildEnv(catalogConfig(), HOSTILE_PARENT_ENV, {
      egressProxyUrl: PROXY_URL,
    });

    expect(env).toEqual({
      CI: 'true',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      // The endpoint's URL — never the parent's ANTHROPIC_BASE_URL, whatever
      // IS_HOSTED says.
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      ANTHROPIC_API_KEY: 'partner-key',
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      // Explicitly empty: a parent NO_PROXY='*' would exempt every host from
      // the proxy and silently restore direct, unpinned egress.
      NO_PROXY: '',
    });
    // The lowercase forms are what most Node HTTP-proxy agents actually read;
    // leaving the parent's copies in place would defeat the uppercase ones.
    expect(env).not.toHaveProperty('https_proxy');
    expect(env).not.toHaveProperty('http_proxy');
    expect(env).not.toHaveProperty('no_proxy');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('uses ANTHROPIC_AUTH_TOKEN for a bearer endpoint and never both credentials at once', () => {
    const env = buildClaudeSdkChildEnv(catalogConfig({ authMode: 'bearer' }), HOSTILE_PARENT_ENV, {
      egressProxyUrl: PROXY_URL,
    });

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('partner-key');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('refuses to build a catalog env without a proxy URL (fail closed, never unpinned egress)', () => {
    expect(() => buildClaudeSdkChildEnv(catalogConfig(), HOSTILE_PARENT_ENV)).toThrow(
      /egress proxy/i,
    );
  });

  it('leaves the platform child env byte-identical, #1412 guard included', () => {
    const hosted = buildClaudeSdkChildEnv(PLATFORM_CONFIG, {
      ...HOSTILE_PARENT_ENV,
      IS_HOSTED: 'true',
    });

    expect(hosted).toEqual({
      CI: 'true',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
      ANTHROPIC_API_KEY: 'platform-api-key',
      ANTHROPIC_AUTH_TOKEN: 'platform-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'platform-oauth-token',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://parent-proxy.local:8080',
      HTTP_PROXY: 'http://parent-proxy.local:8080',
      NO_PROXY: '*',
      https_proxy: 'http://parent-proxy.local:8080',
      http_proxy: 'http://parent-proxy.local:8080',
      no_proxy: '*',
    });
    expect(hosted).not.toHaveProperty('ANTHROPIC_BASE_URL');

    // …and the self-host forward still works, with an egressProxyUrl in hand
    // (the platform path must ignore it — it has no grant of its own).
    const selfHosted = buildClaudeSdkChildEnv(PLATFORM_CONFIG, HOSTILE_PARENT_ENV, {
      egressProxyUrl: PROXY_URL,
    });
    expect(selfHosted.ANTHROPIC_BASE_URL).toBe('https://evil.example/v1');
    expect(selfHosted.HTTPS_PROXY).toBe('http://parent-proxy.local:8080');
  });

  it('leaves the direct-Anthropic partner child env byte-identical', () => {
    const env = buildClaudeSdkChildEnv(DIRECT_PARTNER_CONFIG, HOSTILE_PARENT_ENV, {
      egressProxyUrl: PROXY_URL,
    });

    expect(env).toEqual({
      CI: 'true',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
      ANTHROPIC_API_KEY: 'partner-key',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://parent-proxy.local:8080',
      HTTP_PROXY: 'http://parent-proxy.local:8080',
      NO_PROXY: '*',
      https_proxy: 'http://parent-proxy.local:8080',
      http_proxy: 'http://parent-proxy.local:8080',
      no_proxy: '*',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });
});

// ============================================
// Session wiring
// ============================================

describe('getOrCreate — catalog egress proxy wiring', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryArgs.length = 0;
    sessionUpdates.length = 0;
    sessionUpdateContexts.length = 0;
    dbState.systemDepth = 0;
    dbState.nextReturningRows.length = 0;
    grantMock.mockReturnValue({ proxyUrl: PROXY_URL });
    getLlmEgressProxyMock.mockResolvedValue({
      grant: grantMock,
      revoke: revokeMock,
      port: () => 45677,
      close: () => Promise.resolve(),
    });
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('grants a session-scoped egress allowance and hands the proxy URL to the child', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    expect(grantMock).toHaveBeenCalledWith(
      'sess-catalog',
      { host: 'openrouter.ai', port: 443 },
      expect.any(Function),
    );
    expect(capturedQueryArgs[0]!.options.env).toEqual(expect.objectContaining({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      HTTPS_PROXY: PROXY_URL,
      NO_PROXY: '',
      // #7444: the guards survive the tool-search env merge at the spawn site.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    }));
    // The wire model id from the revision's map, not the platform-logical id;
    // thinking/effort are the resolver's wire params (W03), nothing derived here.
    expect(capturedQueryArgs[0]!.options.model).toBe('anthropic/claude-sonnet-4-6');
    expect(capturedQueryArgs[0]!.options).toMatchObject(sdkModelOptions(resolvedFor(catalogConfig())));
    // …while the binding keeps the logical id and the revision's rate.
    expect(session.turnBinding).toMatchObject({ logicalModel: 'claude-sonnet-4-6', rateSnapshot: { source: 'catalog' } });

    gate.resolve();
    await session.processorPromise;
  });

  it('records one sdk_session_create egress event carrying the catalog provenance', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-event', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );
    await session.processorPromise;

    expect(recordLlmEgressEventMock).toHaveBeenCalledWith({
      orgId: ORG,
      partnerId: PARTNER,
      surface: 'sdk_session_create',
      host: 'openrouter.ai',
      resolvedIp: null,
      blocked: false,
      catalogEntryId: ENTRY_ID,
      revisionId: REVISION_ID,
      aiSessionId: 'sess-catalog-event',
    });
  });

  it('forwards every proxy CONNECT attempt — allowed or blocked — to the egress audit', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-connect', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    const recorder = grantMock.mock.calls[0]![2];
    recorder({ host: 'openrouter.ai', resolvedIp: '104.18.0.1', blocked: false });
    recorder({ host: 'evil.example', resolvedIp: null, blocked: true });

    expect(recordLlmEgressEventMock).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'sdk_proxy_connect',
      host: 'openrouter.ai',
      resolvedIp: '104.18.0.1',
      blocked: false,
      orgId: ORG,
      partnerId: PARTNER,
      aiSessionId: 'sess-catalog-connect',
    }));
    expect(recordLlmEgressEventMock).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'sdk_proxy_connect',
      host: 'evil.example',
      resolvedIp: null,
      blocked: true,
    }));

    gate.resolve();
    await session.processorPromise;
  });

  it('revokes the grant when the session is removed', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-remove', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );
    manager.remove('sess-catalog-remove');

    expect(revokeMock).toHaveBeenCalledWith('sess-catalog-remove');

    gate.resolve();
    await session.processorPromise;
  });

  /**
   * The regression guard for wire-model pass-through: on a direct-Anthropic
   * partner (and the platform) the resolved wire id is the model id itself.
   * An `anthropic/…`-shaped id leaking onto the non-catalog paths would 404
   * on every turn for the partners who are NOT using a catalog at all.
   */
  it.each([
    ['a direct-Anthropic partner', () => DIRECT_PARTNER_CONFIG],
    ['the platform', () => PLATFORM_CONFIG],
  ])('sends %s resolved model unchanged and binds a non-catalog rate', async (_label, config) => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      `sess-passthrough-${_label.replace(/\W+/g, '-')}`,
      DB_SESSION,
      AUTH, undefined, 'BASE PROMPT', undefined,
      resolvedFor(config(), { logicalModel: 'claude-opus-4-8', wireModel: 'claude-opus-4-8' }),
    );

    expect(capturedQueryArgs[0]!.options.model).toBe('claude-opus-4-8');
    // The resolver's wire params: adaptive thinking + effort medium, never a hard-coded `disabled`.
    expect(capturedQueryArgs[0]!.options.thinking).toEqual({ type: 'adaptive' });
    expect(capturedQueryArgs[0]!.options.effort).toBe('medium');
    expect(session.turnBinding.logicalModel).toBe('claude-opus-4-8');
    // Traffic that went to Anthropic is never priced from a catalog revision.
    expect(session.turnBinding.rateSnapshot.source).not.toBe('catalog');
    // And no provenance claim on a session that has no third party in it.
    expect(sessionUpdates).toContainEqual({ catalogEntryId: null, catalogRevisionId: null });

    gate.resolve();
    await session.processorPromise;
  });

  it('never touches the egress proxy for a platform session', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-platform', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(PLATFORM_CONFIG),
    );
    await session.processorPromise;

    expect(getLlmEgressProxyMock).not.toHaveBeenCalled();
    expect(grantMock).not.toHaveBeenCalled();
    expect(recordLlmEgressEventMock).not.toHaveBeenCalled();
  });

  it('fails the session create loudly when the egress proxy cannot start', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);
    getLlmEgressProxyMock.mockRejectedValueOnce(new Error('EADDRINUSE'));

    await expect(manager.getOrCreate(
      'sess-catalog-proxy-down', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    )).rejects.toThrow();

    // Fail-closed: no subprocess was ever started, so nothing could have
    // reached the provider unpinned.
    expect(queryMock).not.toHaveBeenCalled();
    expect(manager.get('sess-catalog-proxy-down')).toBeUndefined();
  });

  it("sends the RESOLVED model's wire id on the connection, and binds that model's revision rate", async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    // A non-default verified model on the same catalog connection: the
    // resolver chose it (the session's offering), so the wire id and the rate
    // are HAIKU's, never the connection default's. (An unverified model is
    // refused by the resolver before dispatch; the manager no longer maps.)
    const session = await manager.getOrCreate(
      'sess-catalog-haiku',
      DB_SESSION,
      AUTH, undefined, 'BASE PROMPT', undefined,
      resolvedFor(catalogConfig(), {
        logicalModel: 'claude-haiku-4-5',
        wireModel: 'anthropic/claude-haiku-4-5',
        rateSnapshot: {
          source: 'catalog',
          standard: { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 },
        },
      }),
    );

    expect(capturedQueryArgs[0]!.options.model).toBe('anthropic/claude-haiku-4-5');
    expect(session.turnBinding.logicalModel).toBe('claude-haiku-4-5');
    expect(session.turnBinding.rateSnapshot.standard.inputCentsPerM).toBe(100);

    gate.resolve();
    await session.processorPromise;
  });

  it('stamps the catalog entry and revision onto the ai_sessions row', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-provenance', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    // billing_source stays 'partner_key' for direct AND catalog BYOK, so these
    // two columns are the ledger's only record of WHICH third party processed
    // the session's content.
    expect(sessionUpdates).toContainEqual({
      catalogEntryId: ENTRY_ID,
      catalogRevisionId: REVISION_ID,
    });

    gate.resolve();
    await session.processorPromise;
  });

  /**
   * The stamp is the ledger's ONLY record of which third party processed a
   * session's content, so both halves of "best effort" have to hold: it must
   * run in a context that can actually see the row, and a write that moves 0
   * rows must be reported rather than swallowed (#3922 W3 review round 2).
   */
  it('stamps under a system DB context, never on the ambient request context', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-provenance-ctx', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    // #2190/#1375: on the ambient context the write can be denied by forced RLS
    // and match 0 rows silently — leaving the row claiming a routing it never
    // had, or (worse, on the clear side) still claiming a catalog it left.
    expect(sessionUpdateContexts).toContainEqual({
      values: { catalogEntryId: ENTRY_ID, catalogRevisionId: REVISION_ID },
      inSystemContext: true,
    });

    gate.resolve();
    await session.processorPromise;
  });

  it('warns and reports to Sentry when the provenance stamp matches no row', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The stamp is the only `.returning()` write on this path.
    dbState.nextReturningRows.push([]);

    const session = await manager.getOrCreate(
      'sess-catalog-provenance-miss', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    // A silent 0-row stamp is the asymmetric-clear hazard: on the CLEARING side
    // it leaves a FALSE catalog claim on a session that is no longer routed
    // there. The row count is what makes that detectable at all.
    expect(warn).toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'db_write_expecting_rows_zero' }),
    );
    // …and the session still starts: provenance bookkeeping must not take AI
    // away from a partner whose traffic is already correctly pinned.
    expect(queryMock).toHaveBeenCalled();

    warn.mockRestore();
    gate.resolve();
    await session.processorPromise;
  });

  it('tags the provenance-stamp failure capture with names the Sentry allowlist keeps', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('stamp exploded');
    vi.mocked(dbModule.withSystemDbAccessContext).mockRejectedValueOnce(boom);

    const session = await manager.getOrCreate(
      'sess-catalog-provenance-throw', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    // Untagged, this capture lands in the same Sentry bucket as every other
    // bare `captureException(err)` in the manager and is untriageable. The tag
    // NAMES matter as much as their presence: `setCallerTags` silently drops
    // anything outside ALLOWED_TAG_NAMES, so a camelCase `orgId`/`service` tag
    // would be a no-op that reads as a fix.
    // `toEqual`, not `objectContaining`: an exact tag bag is what stops a
    // dropped camelCase key from being added back alongside the working ones.
    expect(captureException).toHaveBeenCalledWith(boom, undefined, {
      org_id: ORG,
      cas_label: 'streamingSessionManager.stampCatalogProvenance',
    });
    expect(queryMock).toHaveBeenCalled();

    error.mockRestore();
    gate.resolve();
    await session.processorPromise;
  });

  it('clears the provenance columns for a session that is not catalog-routed', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-direct-provenance', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(DIRECT_PARTNER_CONFIG),
    );

    // A partner who unpins rotates their sessions; the row must not keep
    // describing a routing the session no longer uses. This is the asymmetric
    // half: a stamp that fails leaves a row with no claim, but a CLEAR that
    // fails leaves a FALSE one — so it runs self-contexted too.
    expect(sessionUpdateContexts).toContainEqual({
      values: { catalogEntryId: null, catalogRevisionId: null },
      inSystemContext: true,
    });

    gate.resolve();
    await session.processorPromise;
  });

  it('releases the egress grant when MCP server construction throws', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    await expect(manager.getOrCreate(
      'sess-catalog-mcp-boom', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
      undefined,
      () => { throw new Error('script-builder factory exploded'); },
    )).rejects.toThrow('script-builder factory exploded');

    // The grant map must not grow unbounded: `remove()` never runs for a
    // session that was never registered, so the grant is taken only AFTER the
    // MCP server exists — inside the window the failure catch actually covers.
    expect(grantMock).not.toHaveBeenCalled();
    expect(manager.get('sess-catalog-mcp-boom')).toBeUndefined();
  });

  it('releases the egress grant when the SDK query itself throws', async () => {
    queryMock.mockImplementation(() => { throw new Error('spawn EACCES'); });

    await expect(manager.getOrCreate(
      'sess-catalog-query-boom', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    )).rejects.toThrow('spawn EACCES');

    expect(grantMock).toHaveBeenCalledOnce();
    expect(revokeMock).toHaveBeenCalledWith('sess-catalog-query-boom');
    expect(manager.get('sess-catalog-query-boom')).toBeUndefined();
  });

  it('settles the turn at the revision snapshot rate, whatever the SDK reports (registry price only)', async () => {
    const gate = deferred();
    const resolved = resolvedFor(catalogConfig());
    mockSdkQuery([{
      type: 'result',
      subtype: 'success',
      total_cost_usd: 3.5,
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      // modelUsage keys are the REQUESTED (wire) ids.
      modelUsage: { 'anthropic/claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 0, costUSD: 3.5 } },
      num_turns: 1,
    }], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-cost', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolved,
    );
    gate.resolve();
    await session.processorPromise;

    const input = settleInvocationMock.mock.calls[0]![0] as SettleInvocationInput;
    expect(input.binding).toEqual(turnBindingFrom(resolved));
    expect(input.binding.rateSnapshot).toMatchObject({ source: 'catalog', standard: { inputCentsPerM: 300 } });
    expect(input.binding.funding).toBe('partner_key');
    expect(input.usage).toEqual([
      expect.objectContaining({ model: 'anthropic/claude-sonnet-4-6', tokens: expect.objectContaining({ input: 1_000_000 }) }),
    ]);
    const done = session.eventBus.getReplayEvents().find((e: any) => e.type === 'done' && e.usage) as any;
    // 1M input × 300 cents/M — the revision price, not the SDK's $3.50.
    expect(done.usage.costCents).toBeCloseTo(300, 6);
  });

  it('prices every catalog turn of one query from its own modelUsage delta, never the SDK running total (#7667)', async () => {
    const gate = deferred();
    const turn = (total: number, cumulative: number) => ({
      type: 'result',
      subtype: 'success',
      total_cost_usd: total,
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      modelUsage: { 'anthropic/claude-sonnet-4-6': { inputTokens: cumulative, outputTokens: 0 } },
      num_turns: 1,
    });
    mockSdkQuery([turn(1, 1_000_000), turn(3, 2_000_000), turn(6, 3_000_000)], gate.promise);
    // Settlement advances the session snapshot (here: in memory).
    let stored: unknown = null;
    const reservations = await import('./aiBudgetReservations');
    vi.mocked(reservations.readSdkUsageSnapshot).mockImplementation(async () => stored as never);
    settleInvocationMock.mockImplementation(async (input: unknown) => {
      const next = (input as SettleInvocationInput).sdkUsage?.nextSnapshot;
      if (next) stored = next;
      return { costCents: 0, invocationIds: ['i1'], deferred: false };
    });

    const session = await manager.getOrCreate(
      'sess-catalog-multiturn', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      resolvedFor(catalogConfig()),
    );
    gate.resolve();
    await session.processorPromise;

    const inputs = settleInvocationMock.mock.calls.map((c: any[]) => (c[0] as SettleInvocationInput).usage[0]!.tokens.input);
    expect(inputs).toEqual([1_000_000, 1_000_000, 1_000_000]);
    const doneCosts = session.eventBus.getReplayEvents()
      .filter((e: any) => e.type === 'done')
      .map((e: any) => e.usage?.costCents);
    expect(doneCosts).toEqual([300, 300, 300].map((c) => expect.closeTo(c, 6)));
  });
});

// ============================================
// Revision rotation
// ============================================

describe('getOrCreate — catalog revision rotation', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryArgs.length = 0;
    sessionUpdates.length = 0;
    sessionUpdateContexts.length = 0;
    dbState.systemDepth = 0;
    dbState.nextReturningRows.length = 0;
    grantMock.mockReturnValue({ proxyUrl: PROXY_URL });
    getLlmEgressProxyMock.mockResolvedValue({
      grant: grantMock,
      revoke: revokeMock,
      port: () => 45677,
      close: () => Promise.resolve(),
    });
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('keys the live query on the connection, config version, revision and wire model of a catalog session', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const resolved = resolvedFor(catalogConfig());
    const session = await manager.getOrCreate(
      'sess-rev-snapshot', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolved,
    );

    expect(session.liveKey).toBe(liveQueryKey(turnBindingFrom(resolved)));
    expect(session.liveKey.split('|').slice(0, 4)).toEqual([CONFIG_ID, '1', REVISION_ID, 'anthropic/claude-sonnet-4-6']);

    gate.resolve();
    await session.processorPromise;
  });

  it('rotates an idle session when the catalog revision moves under it', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    const gates = [oldGate.promise, newGate.promise];
    queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
      const gate = gates[capturedQueryArgs.length]!;
      capturedQueryArgs.push(args);
      return {
        async *[Symbol.asyncIterator]() { await gate; },
        interrupt: vi.fn(),
        close: vi.fn(),
      };
    });

    const first = await manager.getOrCreate(
      'sess-rev-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );
    first.state = 'idle';

    const NEXT_REVISION = '5e5e5e5e-5555-4555-8555-555555555555';
    const second = await manager.getOrCreate(
      'sess-rev-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      resolvedFor(catalogConfig({ revisionId: NEXT_REVISION, providerModel: 'anthropic/claude-sonnet-4-7' })),
    );

    expect(second).not.toBe(first);
    expect(first.query.close).toHaveBeenCalledOnce();
    expect(revokeMock).toHaveBeenCalledWith('sess-rev-rotate');
    expect(grantMock).toHaveBeenCalledTimes(2);
    expect(second.liveKey.split('|').slice(0, 4)).toEqual([CONFIG_ID, '1', NEXT_REVISION, 'anthropic/claude-sonnet-4-7']);
    expect(capturedQueryArgs[1]!.options.model).toBe('anthropic/claude-sonnet-4-7');

    oldGate.resolve();
    await first.processorPromise;
    expect(manager.get('sess-rev-rotate')).toBe(second);
    newGate.resolve();
    await second.processorPromise;
  });

  it('defers rotation while the session is mid-turn so the concurrent-message guard applies', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const first = await manager.getOrCreate(
      'sess-rev-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );
    first.state = 'processing';

    const second = await manager.getOrCreate(
      'sess-rev-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      resolvedFor(catalogConfig({ revisionId: '5e5e5e5e-5555-4555-8555-555555555555' })),
    );

    expect(second).toBe(first);
    expect(manager.tryTransitionToProcessing(second)).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(revokeMock).not.toHaveBeenCalled();
    expect(first.liveKey).toBe(liveQueryKey(turnBindingFrom(resolvedFor(catalogConfig()))));

    gate.resolve();
    await first.processorPromise;
  });

  it('reuses the session when nothing about the catalog selection changed', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const first = await manager.getOrCreate(
      'sess-rev-stable', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );
    const second = await manager.getOrCreate(
      'sess-rev-stable', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, resolvedFor(catalogConfig()),
    );

    expect(second).toBe(first);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(grantMock).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first.processorPromise;
  });
});

// ============================================
// Gateway (W06 openai_compatible) sessions
// ============================================

describe('getOrCreate — gateway (openai_compatible) sessions (W06 Task 9)', () => {
  let manager: StreamingSessionManager;
  const gatewayResolved = () => makeResolvedModel('openai_compatible', { orgId: ORG });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryArgs.length = 0;
    sessionUpdates.length = 0;
    sessionUpdateContexts.length = 0;
    dbState.systemDepth = 0;
    dbState.nextReturningRows.length = 0;
    grantMock.mockReturnValue({ proxyUrl: PROXY_URL });
    getLlmEgressProxyMock.mockResolvedValue({
      grant: grantMock,
      revoke: revokeMock,
      port: () => 45677,
      close: () => Promise.resolve(),
    });
    manager = new StreamingSessionManager();
  });

  afterEach(async () => {
    manager.shutdown();
    await closeModelGateway();
  });

  it('spawns on the loopback gateway with a placeholder key and a deny-all proxy grant; no credential in the env', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-gw', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, gatewayResolved(),
    );

    // Deny-all: a null destination, under a per-dispatch key.
    expect(grantMock).toHaveBeenCalledWith(expect.stringMatching(/^sess-gw:gateway:/), null, expect.any(Function));
    const env = capturedQueryArgs[0]!.options.env as Record<string, string>;
    expect(env).toEqual(expect.objectContaining({
      ANTHROPIC_API_KEY: 'breeze-gateway',
      HTTPS_PROXY: PROXY_URL,
      NO_PROXY: '127.0.0.1,localhost',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen2.5-coder:7b',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_TOOL_SEARCH: 'false',
    }));
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(env)).not.toContain('sk-fixture-upstream');
    expect(capturedQueryArgs[0]!.options.model).toBe('qwen2.5-coder:7b');
    expect(recordLlmEgressEventMock).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'sdk_session_create', host: 'llm.example.com', connectionId: 'conn-oai', orgId: ORG, aiSessionId: 'sess-gw',
    }));
    // No catalog provenance: the stamp clears both columns.
    expect(sessionUpdates).toContainEqual(expect.objectContaining({ catalogEntryId: null, catalogRevisionId: null }));

    gate.resolve();
    await session.processorPromise;
  });

  it('revokes the gateway grant and the proxy grant when the session is removed', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-gw-remove', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, gatewayResolved(),
    );
    const env = capturedQueryArgs[0]!.options.env as Record<string, string>;
    const proxyKey = grantMock.mock.calls[0]![0] as string;
    expect((await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`)).status).toBe(200);

    manager.remove('sess-gw-remove');

    expect(revokeMock).toHaveBeenCalledWith(proxyKey);
    expect((await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`)).status).toBe(401);

    gate.resolve();
    await session.processorPromise;
  });

  it('revokes both grants when the SDK query itself throws', async () => {
    queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
      capturedQueryArgs.push(args);
      throw new Error('spawn EACCES');
    });

    await expect(manager.getOrCreate(
      'sess-gw-boom', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, gatewayResolved(),
    )).rejects.toThrow('spawn EACCES');

    const env = capturedQueryArgs[0]!.options.env as Record<string, string>;
    expect(revokeMock).toHaveBeenCalledWith(grantMock.mock.calls[0]![0]);
    expect((await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`)).status).toBe(401);
    expect(manager.get('sess-gw-boom')).toBeUndefined();
  });

  it('a rotated idle session releases the old grants and takes fresh ones', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    const gates = [oldGate.promise, newGate.promise];
    queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
      const gate = gates[capturedQueryArgs.length]!;
      capturedQueryArgs.push(args);
      return { async *[Symbol.asyncIterator]() { await gate; }, interrupt: vi.fn(), close: vi.fn() };
    });

    const first = await manager.getOrCreate(
      'sess-gw-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, gatewayResolved(),
    );
    first.state = 'idle';
    const second = await manager.getOrCreate(
      'sess-gw-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      makeResolvedModel('openai_compatible', { orgId: ORG, configVersion: 4 }),
    );

    expect(second).not.toBe(first);
    const [oldEnv, newEnv] = capturedQueryArgs.map((a) => a.options.env as Record<string, string>);
    expect(revokeMock).toHaveBeenCalledWith(grantMock.mock.calls[0]![0]);
    expect(revokeMock).not.toHaveBeenCalledWith(grantMock.mock.calls[1]![0]);
    expect((await fetch(`${oldEnv!.ANTHROPIC_BASE_URL}/v1/models`)).status).toBe(401);
    expect((await fetch(`${newEnv!.ANTHROPIC_BASE_URL}/v1/models`)).status).toBe(200);

    oldGate.resolve();
    await first.processorPromise;
    newGate.resolve();
    await second.processorPromise;
  });
});
