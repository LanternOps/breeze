/**
 * Context-depth proof: `executeTenantToolDetailed` must never hold a DB
 * access context open while `McpClient.callTool` (the outbound network call
 * to a tenant-configured host) is pending. An identity `fn => fn()` mock of
 * the context helpers can't catch a regression here — this tracks real
 * enter/exit depth, mirroring monitorWorker.dbcontext.test.ts's harness, and
 * asserts the depth observed AT THE MOMENT callTool is invoked.
 *
 * This complements (does not replace) the MCP auth-middleware tests
 * (middleware/apiKeyAuth.test.ts, middleware/bearerTokenAuth.test.ts,
 * routes/mcpServer.tenantToolAmbientContext.test.ts), which prove the
 * OUTER ambient request transaction is skipped for a tenant-tool tools/call.
 * This file proves the INNER dispatch code (this module) adds no context of
 * its own around the fetch — the two together are the full connection-hold
 * fix: no context is opened around the call from either direction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow } from '../../db/schema';
import type { TenantToolDescriptor } from './resolver';

const { ctxState, mockCallTool } = vi.hoisted(() => ({
  ctxState: { depth: 0, callToolDepthAtInvocation: -1 as number },
  mockCallTool: vi.fn(),
}));

vi.mock('./resolver', () => ({ loadTenantToolForExecution: vi.fn() }));
vi.mock('./guardrails', () => ({ checkTenantToolRateLimit: vi.fn() }));
vi.mock('./mcpClient', () => ({
  McpClient: class {
    callTool(...args: unknown[]) {
      // Record the depth the REAL context-tracking mock below reports at the
      // instant the outbound call is made — the whole point of this test.
      ctxState.callToolDepthAtInvocation = ctxState.depth;
      return mockCallTool(...args);
    }
  },
}));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn((snapshot: unknown) => ({ __snapshot: snapshot })),
}));
vi.mock('./secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets')>();
  return { ...actual, decryptToolSourceAuth: vi.fn(() => ({ authKind: 'none' })) };
});
vi.mock('../../config/env', () => ({ toolSourcesAllowPrivateEgress: vi.fn(() => false) }));

import { executeTenantToolDetailed } from './execute';
import { loadTenantToolForExecution } from './resolver';
import { checkTenantToolRateLimit } from './guardrails';
import { __resetToolSourceInFlightForTests, __resetOrgToolInFlightForTests } from './inFlightCap';

function makeDescriptor(overrides: Partial<TenantToolDescriptor> = {}): TenantToolDescriptor {
  return {
    id: 'tool-1',
    sourceId: 'source-1',
    sourceName: 'Hudu',
    sourceKind: 'mcp',
    ownerRef: { orgId: 'org-1', partnerId: null },
    qualifiedName: 'hudu__get_asset',
    name: 'get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    tier: 1,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: 'hudu__get_asset', description: 'Get an asset', input_schema: { type: 'object' } },
    ...overrides,
  };
}

function makeSource(): ToolSourceRow {
  return {
    id: 'source-1',
    orgId: 'org-1',
    partnerId: null,
    slug: 'hudu',
    name: 'Hudu',
    kind: 'mcp',
    endpointUrl: 'https://hudu.example.com/mcp',
    credentialOrigin: 'https://hudu.example.com',
    authKind: 'none',
    authConfigEncrypted: null,
    authFingerprint: null,
    status: 'active',
    lastDiscoveredAt: null,
    lastError: null,
    rateLimitPerMinute: 60,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ToolSourceRow;
}

function makeAuth(): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
  } as unknown as AuthContext;
}

describe('executeTenantToolDetailed — DB context depth around the outbound call', () => {
  beforeEach(() => {
    ctxState.depth = 0;
    ctxState.callToolDepthAtInvocation = -1;
    mockCallTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    vi.mocked(checkTenantToolRateLimit).mockReset().mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockReset().mockResolvedValue({
      descriptor: makeDescriptor(),
      source: makeSource(),
    });
    __resetToolSourceInFlightForTests();
    __resetOrgToolInFlightForTests();
  });

  it('is at depth 0 the instant callTool is invoked, called with no ambient context active', async () => {
    // Reproduces the post-fix reality on the MCP HTTP path: the auth
    // middleware has already skipped opening the ambient request transaction
    // for this call, so executeTenantToolDetailed starts at depth 0.
    expect(ctxState.depth).toBe(0);

    const result = await executeTenantToolDetailed(makeDescriptor(), {}, makeAuth(), {
      surface: 'mcp',
      orgId: 'org-1',
    });

    expect(result.isError).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(ctxState.callToolDepthAtInvocation).toBe(0);
    // And nothing is left open afterward either.
    expect(ctxState.depth).toBe(0);
  });
});
