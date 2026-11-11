/**
 * #11393 W01: the one tool exposure per streaming-session entry — registration
 * filter (`onlyTools`), kept extras, `allowedTools`, tool search and the
 * live-query key all come from the same exposure.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, resolveTenantToolsMock, SURFACE_TOOLS } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  resolveTenantToolsMock: vi.fn(),
  SURFACE_TOOLS: [] as string[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock, tool: (name: string) => ({ name }) }));

vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: vi.fn(async () => null),
  wispSessionToolFilter: vi.fn(),
  unreachableWispAuth: (auth: unknown) => auth,
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiBudgetReservations', () => ({
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({ kind: 'indeterminate' })),
  readSdkUsageSnapshot: vi.fn(async () => null),
}));
vi.mock('./aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('./aiModels/platformModels')>()),
  getPlatformModelByModelId: vi.fn(async () => null),
}));
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: [], deferred: false })),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__set_device_context', 'mcp__breeze__execute_command'],
  listChatSurfaceToolNames: () => SURFACE_TOOLS,
  chatToolDomain: (name: string) => (name === 'query_devices' ? 'devices' : undefined),
}));
vi.mock('./toolSources/resolver', () => ({
  resolveTenantTools: (...args: unknown[]) => resolveTenantToolsMock(...args),
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (input: Record<string, unknown>) => input,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { liveQueryKey, turnBindingFrom } from './aiModels/turnBinding';
import { CHAT_MINIMAL_TOOLS } from './aiModels/toolProfiles';
import { DEFAULT_TOOL_PROFILE_FACTS, type ToolProfileFacts } from './aiModels/toolExposure';
import { createBreezeMcpServer } from './aiAgentSdkTools';
import type { AuthContext } from '../middleware/auth';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const DB_SESSION = { orgId: ORG, sdkSessionId: null, maxTurns: 50, turnCount: 0, systemPrompt: null };
const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@contoso.com' },
} as unknown as AuthContext;

const TENANT = {
  qualifiedName: 'hudu__get_asset', id: 'tool-1', sourceName: 'Hudu', description: 'd',
  inputSchema: { type: 'object', properties: {} },
};
const EXTRA_REGISTRY = ['execute_command', 'manage_alerts', 'get_device_context'];

const facts = (over: Partial<ToolProfileFacts>): ToolProfileFacts => ({ ...DEFAULT_TOOL_PROFILE_FACTS, ...over });
const MINIMAL = facts({ toolProfile: 'minimal', transport: 'gateway' });
const modelWith = (f?: ToolProfileFacts, over: Record<string, unknown> = {}) =>
  makeResolvedModel('platform', { ...(f ? { toolProfileFacts: f } : {}), ...over });

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  SURFACE_TOOLS.length = 0;
  SURFACE_TOOLS.push(...CHAT_MINIMAL_TOOLS, 'set_device_context', ...EXTRA_REGISTRY);
  resolveTenantToolsMock.mockResolvedValue([TENANT]);
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() { await new Promise(() => undefined); },
    interrupt: vi.fn(),
    close: vi.fn(),
  }));
  manager = new StreamingSessionManager();
});
afterEach(() => manager.shutdown());

type QueryOptions = { allowedTools: string[]; tools: string[]; env: Record<string, string> };
const queryOptions = () => (queryMock.mock.calls.at(-1)![0] as { options: QueryOptions }).options;
const breezeArgs = () => vi.mocked(createBreezeMcpServer).mock.calls.at(-1)! as unknown as unknown[];
const registeredExtras = () => (breezeArgs()[4] as Array<{ name: string }>).map((e) => e.name);
const onlyToolsOf = () => (breezeArgs()[5] as { onlyTools: ReadonlySet<string> }).onlyTools;

const create = (id: string, resolved: ReturnType<typeof modelWith>, ...rest: unknown[]) =>
  (manager.getOrCreate as (...a: unknown[]) => ReturnType<StreamingSessionManager['getOrCreate']>)(
    id, DB_SESSION, AUTH, undefined, 'PROMPT', undefined, resolved, ...rest,
  );

describe('tool exposure wiring (#11393 W01)', () => {
  const identityCases: Array<[string, ToolProfileFacts | undefined]> = [
    ['absent', undefined],
    ['explicit auto + unknown window', { toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'gateway' }],
  ];

  it.each(identityCases)('full + unknown window (%s) changes nothing: no onlyTools, default allowedTools, one-arg key', async (label, f) => {
    const resolved = modelWith(f);
    const session = await create(`s-id-${label}`, resolved, undefined, undefined, { toolSearch: true });

    // The options arg is undefined with no Wisp grant and no onlyTools.
    expect(breezeArgs()[5]).toBeUndefined();
    expect(registeredExtras()).toEqual(['hudu__get_asset']);
    expect(queryOptions().allowedTools).toEqual([
      'mcp__breeze__set_device_context', 'mcp__breeze__execute_command', 'mcp__breeze__hudu__get_asset',
    ]);
    expect(session.liveKey).toBe(liveQueryKey(turnBindingFrom(resolved)));
    expect(session.liveKey).not.toContain('|tx:');
    expect(session.toolExposure?.names).toBeNull();
    expect(queryOptions().env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  it('minimal: onlyTools = curated minimal + set_device_context, extras dropped, search off, key rotated', async () => {
    const fullKey = liveQueryKey(turnBindingFrom(modelWith()));
    const session = await create('s-min', modelWith(MINIMAL), undefined, undefined, { toolSearch: true });

    const expected = [...CHAT_MINIMAL_TOOLS, 'set_device_context'];
    expect([...onlyToolsOf()].sort()).toEqual([...expected].sort());
    expect(onlyToolsOf().has('execute_command')).toBe(false);
    expect(onlyToolsOf().has('manage_alerts')).toBe(false);

    expect(queryOptions().allowedTools.slice().sort()).toEqual(expected.map((n) => `mcp__breeze__${n}`).sort());
    expect(queryOptions().allowedTools).not.toContain('mcp__breeze__hudu__get_asset');
    expect(registeredExtras()).toEqual([]);
    expect(session.allowedTools).toEqual(queryOptions().allowedTools);

    // profile_static: tool search is off although the surface opted in.
    expect(queryOptions().tools).toEqual([]);
    expect(queryOptions().env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(session.toolExposure?.toolSearchAllowed).toBe(false);

    expect(session.liveKey).toMatch(/\|tx:[0-9a-f]{16}$/);
    expect(session.liveKey).not.toBe(fullKey);
    expect(session.liveKey.startsWith(`${fullKey}|tx:`)).toBe(true);
  });

  it('minimal intersects the curated names with what the surface registers', async () => {
    SURFACE_TOOLS.length = 0;
    SURFACE_TOOLS.push('query_devices', 'set_device_context', 'execute_command');
    await create('s-min-int', modelWith(MINIMAL));
    expect([...onlyToolsOf()].sort()).toEqual(['query_devices', 'set_device_context']);
  });

  it('custom {domains:[integrations], tools:[query_devices]} keeps the tenant tool', async () => {
    const custom = facts({
      toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices'] }, transport: 'gateway',
    });
    const session = await create('s-custom', modelWith(custom));

    expect([...onlyToolsOf()].sort()).toEqual(['query_devices', 'set_device_context']);
    expect(registeredExtras()).toEqual(['hudu__get_asset']);
    expect(queryOptions().allowedTools.slice().sort()).toEqual([
      'mcp__breeze__hudu__get_asset', 'mcp__breeze__query_devices', 'mcp__breeze__set_device_context',
    ]);
    expect(session.liveKey).toMatch(/\|tx:[0-9a-f]{16}$/);
  });

  it('keys from facts alone: a same-facts idle session is reused without resolving tenant tools; changed facts recreate it', async () => {
    const first = await create('s-reuse', modelWith(MINIMAL));
    first.state = 'idle';
    expect(resolveTenantToolsMock).toHaveBeenCalledTimes(1);

    const again = await create('s-reuse', modelWith(MINIMAL));
    expect(again).toBe(first);
    expect(resolveTenantToolsMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(again.allowedTools).toEqual(first.allowedTools);

    const standard = modelWith(facts({ toolProfile: 'standard', transport: 'gateway' }));
    const recreated = await create('s-reuse', standard);
    expect(recreated).not.toBe(first);
    expect(recreated.liveKey).not.toBe(first.liveKey);
    expect(recreated.liveKey).toMatch(/\|tx:[0-9a-f]{16}$/);
    expect(resolveTenantToolsMock).toHaveBeenCalledTimes(2);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a script builder whose profile drops a required tool, before any provider call', async () => {
    const custom = facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['apply_script_code'] }, transport: 'gateway' });
    const factory = vi.fn(() => ({ server: { type: 'sdk' }, name: 'script_builder' }));
    await expect(
      create('s-sb', modelWith(custom, { surface: 'script_builder' }),
        ['mcp__script_builder__apply_script_code', 'mcp__script_builder__execute_script_on_device'], factory),
    ).rejects.toMatchObject({ code: 'tool_profile_underpowered' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
