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
  recordUsageMock,
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
  recordUsageMock: vi.fn(() => Promise.resolve()),
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

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: recordUsageMock,
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
  calculateCostCents: () => 0,
  // Real arithmetic (cents per million): the catalog cost path is the reason
  // this snapshot exists, so a stub returning 0 would hide it.
  calculateCatalogCostCents: (
    pricing: { inputCentsPerM: number; outputCentsPerM: number },
    inputTokens: number,
    outputTokens: number,
  ) =>
    Math.round(
      ((inputTokens / 1_000_000) * pricing.inputCentsPerM +
        (outputTokens / 1_000_000) * pricing.outputCentsPerM) * 100,
    ) / 100,
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
import { captureException, captureMessage } from './sentry';
import * as dbModule from '../db';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER = '1a1a1a1a-1111-4222-8333-444455556666';
const CONFIG_ID = '2b2b2b2b-2222-4222-8222-222222222222';
const ENTRY_ID = '3c3c3c3c-3333-4333-8333-333333333333';
const REVISION_ID = '4d4d4d4d-4444-4444-8444-444444444444';
const PROXY_URL = 'http://breeze:tok@127.0.0.1:45677';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-6',
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
      'sess-catalog', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
    }));
    // The wire model id from the revision's map, not the platform-logical id.
    expect(capturedQueryArgs[0]!.options.model).toBe('anthropic/claude-sonnet-4-6');
    // …while the session keeps the logical id for provenance/pricing fallback.
    expect(session.model).toBe('claude-sonnet-4-6');

    gate.resolve();
    await session.processorPromise;
  });

  it('records one sdk_session_create egress event carrying the catalog provenance', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-event', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-connect', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-remove', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );
    manager.remove('sess-catalog-remove');

    expect(revokeMock).toHaveBeenCalledWith('sess-catalog-remove');

    gate.resolve();
    await session.processorPromise;
  });

  /**
   * The regression guard for the wire-model translation itself: on a
   * direct-Anthropic partner (and the platform) `resolveWireModel` must be a
   * pass-through. A translation that leaked onto the non-catalog paths would
   * send an `anthropic/…`-shaped id to api.anthropic.com — a 404 on every turn
   * for the partners who are NOT using the new feature at all.
   */
  it.each([
    ['a direct-Anthropic partner', () => DIRECT_PARTNER_CONFIG],
    ['the platform', () => PLATFORM_CONFIG],
  ])('sends %s session model unchanged and meters it at list rates', async (_label, config) => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    // A model that no catalog revision maps — the point being that nothing on
    // this path consults a model map at all.
    const session = await manager.getOrCreate(
      `sess-passthrough-${_label.replace(/\W+/g, '-')}`,
      { ...DB_SESSION, model: 'claude-opus-4-8' },
      AUTH, undefined, 'BASE PROMPT', undefined, config(),
    );

    expect(capturedQueryArgs[0]!.options.model).toBe('claude-opus-4-8');
    expect(session.model).toBe('claude-opus-4-8');
    // No pricing snapshot => `recordUsage` falls back to the Anthropic list
    // rates, which is exactly right for traffic that went to Anthropic.
    expect(session.catalogPricing).toBeUndefined();
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
      'sess-platform', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG,
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
      'sess-catalog-proxy-down', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    )).rejects.toThrow();

    // Fail-closed: no subprocess was ever started, so nothing could have
    // reached the provider unpinned.
    expect(queryMock).not.toHaveBeenCalled();
    expect(manager.get('sess-catalog-proxy-down')).toBeUndefined();
  });

  it("sends the SESSION's own model on the wire, not the partner default's", async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    // `ai_sessions.model` is a free-form client-supplied string and can also be
    // stale; the resolver's model_unverified gate only ever checked the partner
    // DEFAULT, so this model reached the provider untranslated.
    const session = await manager.getOrCreate(
      'sess-catalog-haiku',
      { ...DB_SESSION, model: 'claude-haiku-4-5' },
      AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );

    expect(capturedQueryArgs[0]!.options.model).toBe('anthropic/claude-haiku-4-5');
    expect(session.model).toBe('claude-haiku-4-5');
    // …and the ledger prices haiku at HAIKU's rates, not sonnet's.
    expect(session.catalogPricing).toEqual(expect.objectContaining({ inputCentsPerM: 100 }));

    gate.resolve();
    await session.processorPromise;
  });

  it('fails the session closed when the pinned revision has not verified the session model', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    await expect(manager.getOrCreate(
      'sess-catalog-unmapped',
      { ...DB_SESSION, model: 'claude-opus-4-8' },
      AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    )).rejects.toThrow(/claude-opus-4-8/);

    // Never silently re-pointed at the default model's wire id, and no
    // subprocess started.
    expect(queryMock).not.toHaveBeenCalled();
    expect(grantMock).not.toHaveBeenCalled();
    expect(manager.get('sess-catalog-unmapped')).toBeUndefined();
  });

  it('stamps the catalog entry and revision onto the ai_sessions row', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-provenance', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-provenance-ctx', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-provenance-miss', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-provenance-throw', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-direct-provenance', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, DIRECT_PARTNER_CONFIG,
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
      'sess-catalog-mcp-boom', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
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
      'sess-catalog-query-boom', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    )).rejects.toThrow('spawn EACCES');

    expect(grantMock).toHaveBeenCalledOnce();
    expect(revokeMock).toHaveBeenCalledWith('sess-catalog-query-boom');
    expect(manager.get('sess-catalog-query-boom')).toBeUndefined();
  });

  it('prices the turn from the revision snapshot instead of Anthropic list rates', async () => {
    const gate = deferred();
    mockSdkQuery([{
      type: 'result',
      subtype: 'success',
      total_cost_usd: 3.5,
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      num_turns: 1,
    }], gate.promise);

    const session = await manager.getOrCreate(
      'sess-catalog-cost', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );
    gate.resolve();
    await session.processorPromise;

    expect(recordUsageMock).toHaveBeenCalledWith(
      'sess-catalog-cost',
      ORG,
      expect.objectContaining({ total_cost_usd: 3.5 }),
      'partner_key',
      expect.objectContaining({ catalogEntryId: ENTRY_ID, revisionId: REVISION_ID, inputCentsPerM: 300 }),
    );
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

  it('snapshots the revision and wire model of a catalog session', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-rev-snapshot', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );

    expect(session.llmConfigSnapshot).toEqual({
      source: 'partner',
      configId: CONFIG_ID,
      configVersion: 1,
      revisionId: REVISION_ID,
      providerModel: 'anthropic/claude-sonnet-4-6',
    });

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
      'sess-rev-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );
    first.state = 'idle';

    const NEXT_REVISION = '5e5e5e5e-5555-4555-8555-555555555555';
    const second = await manager.getOrCreate(
      'sess-rev-rotate', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      catalogConfig({ revisionId: NEXT_REVISION, providerModel: 'anthropic/claude-sonnet-4-7' }),
    );

    expect(second).not.toBe(first);
    expect(first.query.close).toHaveBeenCalledOnce();
    expect(revokeMock).toHaveBeenCalledWith('sess-rev-rotate');
    expect(grantMock).toHaveBeenCalledTimes(2);
    expect(second.llmConfigSnapshot).toEqual({
      source: 'partner',
      configId: CONFIG_ID,
      configVersion: 1,
      revisionId: NEXT_REVISION,
      providerModel: 'anthropic/claude-sonnet-4-7',
    });
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
      'sess-rev-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );
    first.state = 'processing';

    const second = await manager.getOrCreate(
      'sess-rev-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      catalogConfig({ revisionId: '5e5e5e5e-5555-4555-8555-555555555555' }),
    );

    expect(second).toBe(first);
    expect(manager.tryTransitionToProcessing(second)).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(revokeMock).not.toHaveBeenCalled();
    expect(first.llmConfigSnapshot.revisionId).toBe(REVISION_ID);

    gate.resolve();
    await first.processorPromise;
  });

  it('reuses the session when nothing about the catalog selection changed', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const first = await manager.getOrCreate(
      'sess-rev-stable', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );
    const second = await manager.getOrCreate(
      'sess-rev-stable', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, catalogConfig(),
    );

    expect(second).toBe(first);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(grantMock).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first.processorPromise;
  });
});
