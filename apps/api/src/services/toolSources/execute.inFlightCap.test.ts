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
  currentToolSourceInFlightForTests,
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

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    ...overrides,
  } as unknown as AuthContext;
}

describe('executeTenantToolDetailed — per-source in-flight cap', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
    mockMcpClientCtor.mockReset();
    vi.mocked(loadTenantToolForExecution).mockReset();
    vi.mocked(checkTenantToolRateLimit).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'none' });
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    __resetToolSourceInFlightForTests();
  });

  it('refuses a call once the source is already at its concurrency ceiling', async () => {
    // Four slow in-flight calls against the same source occupy the cap.
    let releaseCalls: Array<() => void> = [];
    mockCallTool.mockImplementation(
      () => new Promise((resolve) => { releaseCalls.push(() => resolve({ content: [] })); })
    );

    const d = makeDescriptor();
    const auth = makeAuth();
    const inFlight = Array.from({ length: 4 }, () =>
      executeTenantToolDetailed(d, {}, auth, { surface: 'mcp' })
    );

    // Let the in-flight calls actually reach callTool before firing the 5th.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentToolSourceInFlightForTests('source-1')).toBe(4);

    const fifth = await executeTenantToolDetailed(d, {}, auth, { surface: 'mcp' });
    expect(fifth.isError).toBe(true);
    expect(fifth.text).toMatch(/busy|concurrency|too many/i);
    expect(mockCallTool).toHaveBeenCalledTimes(4);

    releaseCalls.forEach((r) => r());
    await Promise.all(inFlight);
  });

  it('releases the slot after a call completes, successfully or not', async () => {
    mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const d = makeDescriptor();
    const auth = makeAuth();

    await executeTenantToolDetailed(d, {}, auth, { surface: 'mcp' });
    expect(currentToolSourceInFlightForTests('source-1')).toBe(0);

    mockCallTool.mockRejectedValueOnce(new Error('boom'));
    await executeTenantToolDetailed(d, {}, auth, { surface: 'mcp' });
    expect(currentToolSourceInFlightForTests('source-1')).toBe(0);
  });
});
