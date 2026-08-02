import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthContext } from '../middleware/auth';

/**
 * Task 7b (findings 1 & 2, code-review follow-up): dedicated coverage for
 * the org-install visibility filter on MCP `tools/list` and the matching
 * non-disclosure gate on `tools/call`.
 *
 * Every other `mcpServer*.test.ts` file mocks `../services/aiTools` with a
 * fixed core-tool-only fixture, so `extensionContributionRegistry.findAiToolOwner`
 * is never reached and never returns an owner there — the `installScope ===
 * 'org'` branches added to `handleToolsList` and `handleToolsCall` never
 * executed in any existing suite. This file mocks the extension registry
 * module directly (kept adjacent to the real `installScopeOf`, via
 * `importOriginal`, so the manifest-shape contract is exercised for real)
 * so a fixture tool name can be made to resolve to a real owner + manifest,
 * proving THIS file's wiring — not the registry's own internal mechanics,
 * which `extensionLifecycle.test.ts` / `orgInstallGate.test.ts` already
 * cover in depth.
 *
 * Calls the handlers directly via the `__handleToolsListForTests` /
 * __handleToolsCallForTests` test-only exports (added alongside the fix),
 * bypassing the HTTP + API-key/bearer transport layer entirely — that
 * layer is unrelated to what's under test here and is already covered by
 * mcpServer.test.ts and siblings.
 */

const routeMocks = vi.hoisted(() => ({
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  executeTool: vi.fn(),
  findAiToolOwner: vi.fn(),
  registryGet: vi.fn(),
  installReader: vi.fn(),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: true,
  OAUTH_ISSUER: 'https://us.example.com',
}));

// Mock heavy module-graph leaves so importing ./mcpServer doesn't stand up a
// real postgres client / redis connection (mirrors mcpServer.test.ts).
vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerUsers: {},
  aiSessions: { id: 'aiSessions.id' },
  aiToolExecutions: { id: 'aiToolExecutions.id' },
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => null) };
});

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: (...args: any[]) => routeMocks.getToolDefinitions(...args),
  getToolTier: (...args: any[]) => routeMocks.getToolTier(...args),
  executeTool: (...args: any[]) => routeMocks.executeTool(...args),
  aiTools: new Map(),
}));

// The two modules the org-install gate/filter reach through
// (getMcpOrgInstallModules' dynamic import in mcpServer.ts). Registry calls
// are fully controllable fixtures; `installScopeOf` is the REAL function
// (via importOriginal) so the manifest-shape contract is exercised for real,
// not re-implemented in the mock.
vi.mock('../extensions/contributionRegistry', () => ({
  extensionContributionRegistry: {
    findAiToolOwner: (...args: any[]) => routeMocks.findAiToolOwner(...args),
    get: (...args: any[]) => routeMocks.registryGet(...args),
  },
}));

vi.mock('../extensions/orgInstallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extensions/orgInstallGate')>();
  return {
    ...actual,
    createOrgInstalledReader: () => (...args: [string, string]) => routeMocks.installReader(...args),
  };
});

vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return { ...actual }; // never reached by the deny-path test below; kept real/inert
});

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../services/redis', () => ({ getRedis: () => null }));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (_c: any, next: any) => next(),
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => { throw new Error('not exercised by this suite'); },
  resolvePartnerAccessibleOrgIds: async () => [],
}));

vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn(async () => ({ decision: 'allow' })),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: () => false,
}));

vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

import {
  __handleToolsListForTests as handleToolsList,
  __handleToolsCallForTests as handleToolsCall,
} from './mcpServer';

const CORE_TOOL = 'list_devices';
const EXT_TOOL = 'org_scoped_probe_tool';
const ORG_ID = 'org-1';

function makeAuth(orgId: string | null = ORG_ID): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: orgId ? [orgId] : [],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

/** Every tool (core + the fixture extension tool) is tier 1 — read-only, no
 * scope gating in play — so the only thing under test is the org-install
 * filter, not the pre-existing tier/scope filter. */
function baseTools() {
  routeMocks.getToolDefinitions.mockReturnValue([
    { name: CORE_TOOL, description: 'core', input_schema: { type: 'object', properties: {} } },
    { name: EXT_TOOL, description: 'ext', input_schema: { type: 'object', properties: {} } },
  ]);
  routeMocks.getToolTier.mockImplementation((name: string) =>
    name === CORE_TOOL || name === EXT_TOOL ? 1 : undefined,
  );
}

function toolNamesFrom(res: any): string[] {
  return (res.result.tools as Array<{ name: string }>).map((t) => t.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  baseTools();
  // Default: EXT_TOOL has no owner (behaves like a core tool) unless a test
  // stages one below — keeps the "no extensions active" baseline inert.
  routeMocks.findAiToolOwner.mockReturnValue(undefined);
  routeMocks.registryGet.mockReturnValue(undefined);
});

describe('tools/list org-install visibility filter (Task 7b, finding 2)', () => {
  it('hides an org-scoped extension tool from a non-installed org', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'org-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'org-ext' ? { manifest: { tenancy: { installScope: 'org' } } } : undefined,
    );
    routeMocks.installReader.mockResolvedValue(false);

    const res = await handleToolsList(1, ['ai:read'], makeAuth());
    const names = toolNamesFrom(res);

    expect(names).toContain(CORE_TOOL);
    expect(names).not.toContain(EXT_TOOL);
    expect(routeMocks.installReader).toHaveBeenCalledWith('org-ext', ORG_ID);
  });

  it('shows an org-scoped extension tool to an installed org', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'org-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'org-ext' ? { manifest: { tenancy: { installScope: 'org' } } } : undefined,
    );
    routeMocks.installReader.mockResolvedValue(true);

    const res = await handleToolsList(1, ['ai:read'], makeAuth());
    const names = toolNamesFrom(res);

    expect(names).toContain(CORE_TOOL);
    expect(names).toContain(EXT_TOOL);
    expect(routeMocks.installReader).toHaveBeenCalledWith('org-ext', ORG_ID);
  });

  it('shows a server-scoped extension tool unconditionally, and never consults the install reader', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'server-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'server-ext' ? { manifest: { tenancy: { installScope: 'server' } } } : undefined,
    );
    // Even a reader that would deny must never be reached for a server-scoped extension.
    routeMocks.installReader.mockResolvedValue(false);

    const res = await handleToolsList(1, ['ai:read'], makeAuth());
    const names = toolNamesFrom(res);

    expect(names).toContain(CORE_TOOL);
    expect(names).toContain(EXT_TOOL);
    expect(routeMocks.installReader).not.toHaveBeenCalled();
  });

  it('hides an org-scoped extension tool when the caller has no single resolvable org', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'org-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'org-ext' ? { manifest: { tenancy: { installScope: 'org' } } } : undefined,
    );
    routeMocks.installReader.mockResolvedValue(true); // must not matter without a resolvable org

    const res = await handleToolsList(1, ['ai:read'], makeAuth(null));
    const names = toolNamesFrom(res);

    expect(names).not.toContain(EXT_TOOL);
    expect(routeMocks.installReader).not.toHaveBeenCalled();
  });
});

describe('tools/call org-install non-disclosure gate (Task 7b, finding 1)', () => {
  it('denies a call naming a non-installed org-scoped tool with the BYTE-IDENTICAL envelope a nonexistent tool name gets', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'org-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'org-ext' ? { manifest: { tenancy: { installScope: 'org' } } } : undefined,
    );
    routeMocks.installReader.mockResolvedValue(false);

    const deniedRes: any = await handleToolsCall(
      1,
      { name: EXT_TOOL, arguments: {} },
      makeAuth(),
      ['ai:read'],
    );
    const unknownRes: any = await handleToolsCall(
      2,
      { name: 'definitely_not_a_registered_tool', arguments: {} },
      makeAuth(),
      ['ai:read'],
    );

    // Both are JSON-RPC ERROR envelopes (never a success envelope with
    // isError content) — the shape the finding pinned as the disclosure leak.
    expect(deniedRes.result).toBeUndefined();
    expect(deniedRes.error).toBeDefined();
    expect(unknownRes.error).toBeDefined();
    expect(deniedRes.error.code).toBe(unknownRes.error.code);
    expect(deniedRes.error.message.replace(EXT_TOOL, 'definitely_not_a_registered_tool'))
      .toBe(unknownRes.error.message);

    // Denied BEFORE any guardrail/permission/rate-limit/execution work.
    expect(routeMocks.executeTool).not.toHaveBeenCalled();
    expect(routeMocks.installReader).toHaveBeenCalledWith('org-ext', ORG_ID);
  });

  it('does not gate a call naming a server-scoped extension tool (falls through past the install check)', async () => {
    routeMocks.findAiToolOwner.mockImplementation((name: string) => (name === EXT_TOOL ? 'server-ext' : undefined));
    routeMocks.registryGet.mockImplementation((owner: string) =>
      owner === 'server-ext' ? { manifest: { tenancy: { installScope: 'server' } } } : undefined,
    );
    routeMocks.installReader.mockResolvedValue(false); // must not matter — never consulted

    // checkGuardrails is the REAL implementation here (see the aiGuardrails
    // mock above) and will run past our gate; assert only that the install
    // gate itself did not short-circuit the call, without asserting on
    // whatever the real guardrail/permission/ledger chain ultimately decides
    // (that chain is exhaustively covered by mcpServer.test.ts already).
    await handleToolsCall(1, { name: EXT_TOOL, arguments: {} }, makeAuth(), ['ai:read']);

    expect(routeMocks.installReader).not.toHaveBeenCalled();
  });
});
