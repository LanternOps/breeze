// The per-source cap (execute.inFlightCap.test.ts) bounds one source, but an
// org that registers several sources can still drive `sources × per-source
// cap` concurrent external calls, which grows unbounded with the number of
// sources. This proves the aggregate per-org cap actually stops that.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow } from '../../db/schema';
import type { TenantToolDescriptor } from './resolver';

const mockCallTool = vi.fn();
const mockMcpClientCtor = vi.fn();

vi.mock('./resolver', () => ({ loadTenantToolForExecution: vi.fn() }));
vi.mock('./guardrails', () => ({ checkTenantToolRateLimit: vi.fn() }));
vi.mock('./mcpClient', () => ({
  McpClient: class {
    constructor(opts: unknown) {
      mockMcpClientCtor(opts);
    }
    callTool(...args: unknown[]) {
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
  return { ...actual, decryptToolSourceAuth: vi.fn() };
});
vi.mock('../../config/env', () => ({ toolSourcesAllowPrivateEgress: vi.fn(() => false) }));

import { executeTenantToolDetailed } from './execute';
import { loadTenantToolForExecution } from './resolver';
import { checkTenantToolRateLimit } from './guardrails';
import { decryptToolSourceAuth } from './secrets';
import {
  __resetToolSourceInFlightForTests,
  __resetOrgToolInFlightForTests,
  currentOrgToolInFlightForTests,
} from './inFlightCap';

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

function makeSource(overrides: Partial<ToolSourceRow> = {}): ToolSourceRow {
  return {
    id: overrides.id ?? 'source-1',
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
    ...overrides,
  } as unknown as ToolSourceRow;
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    ...overrides,
  } as unknown as AuthContext;
}

describe('executeTenantToolDetailed — per-org in-flight cap', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
    mockMcpClientCtor.mockReset();
    vi.mocked(loadTenantToolForExecution).mockReset();
    vi.mocked(checkTenantToolRateLimit).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'none' });
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    __resetToolSourceInFlightForTests();
    __resetOrgToolInFlightForTests();
  });

  it('refuses a call against a DIFFERENT source of the same org once the org ceiling is reached', async () => {
    // 9 sources (one over the default org cap of 8), each with its own
    // 4-call source-level headroom — the per-source cap alone would allow up
    // to 36 concurrent calls for this one org.
    const sourceCount = 9;
    let releaseCalls: Array<() => void> = [];
    mockCallTool.mockImplementation(
      () => new Promise((resolve) => { releaseCalls.push(() => resolve({ content: [] })); })
    );

    const calls = Array.from({ length: sourceCount }, (_, i) => {
      const sourceId = `source-${i}`;
      const d = makeDescriptor({ sourceId, ownerRef: { orgId: 'org-1', partnerId: null } });
      vi.mocked(loadTenantToolForExecution).mockResolvedValueOnce({
        descriptor: d,
        source: makeSource({ id: sourceId }),
      });
      return executeTenantToolDetailed(d, {}, makeAuth(), { surface: 'mcp', orgId: 'org-1' });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Org cap default is 8: the 8th call onward for this org must be refused
    // even though each hits a brand-new source with full source-level headroom.
    expect(currentOrgToolInFlightForTests('org:org-1')).toBeLessThanOrEqual(8);
    expect(mockCallTool.mock.calls.length).toBeLessThan(sourceCount);

    releaseCalls.forEach((r) => r());
    const results = await Promise.all(calls);
    expect(results.some((r) => r.isError && /organization/i.test(r.text))).toBe(true);
  });

  it('does not cross-contaminate two different orgs', async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const dOrgA = makeDescriptor({ sourceId: 'source-a', ownerRef: { orgId: 'org-a', partnerId: null } });
    const dOrgB = makeDescriptor({ sourceId: 'source-b', ownerRef: { orgId: 'org-b', partnerId: null } });
    vi.mocked(loadTenantToolForExecution).mockResolvedValueOnce({ descriptor: dOrgA, source: makeSource({ id: 'source-a', orgId: 'org-a' }) });
    vi.mocked(loadTenantToolForExecution).mockResolvedValueOnce({ descriptor: dOrgB, source: makeSource({ id: 'source-b', orgId: 'org-b' }) });

    const resA = await executeTenantToolDetailed(dOrgA, {}, makeAuth({ orgId: 'org-a' }), { surface: 'mcp', orgId: 'org-a' });
    const resB = await executeTenantToolDetailed(dOrgB, {}, makeAuth({ orgId: 'org-b' }), { surface: 'mcp', orgId: 'org-b' });

    expect(resA.isError).toBe(false);
    expect(resB.isError).toBe(false);
    expect(currentOrgToolInFlightForTests('org:org-a')).toBe(0);
    expect(currentOrgToolInFlightForTests('org:org-b')).toBe(0);
  });
});
