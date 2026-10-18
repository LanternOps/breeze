import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow, ToolSourceToolRow } from '../../db/schema';
import type { TenantToolDescriptor } from './resolver';

const mockCallOperation = vi.fn();
const mockOpenApiCtor = vi.fn();
const mockMcpCtor = vi.fn();

vi.mock('./resolver', () => ({ loadTenantToolForExecution: vi.fn() }));
vi.mock('./guardrails', () => ({ checkTenantToolRateLimit: vi.fn() }));
vi.mock('./mcpClient', () => ({
  McpClient: class {
    constructor(opts: unknown) {
      mockMcpCtor(opts);
    }
    callTool() {
      throw new Error('the MCP client must not be used for an openapi source');
    }
  },
}));
vi.mock('./openapiClient', () => ({
  OpenApiClient: class {
    constructor(opts: unknown) {
      mockOpenApiCtor(opts);
    }
    callOperation(...args: unknown[]) {
      return mockCallOperation(...args);
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
import { writeAuditEvent } from '../auditEvents';
import { decryptToolSourceAuth } from './secrets';
import { toolSourcesAllowPrivateEgress } from '../../config/env';

const BINDING = {
  method: 'get', path: '/pets/{petId}', operationId: 'showPetById',
  params: [{ name: 'petId', in: 'path', property: 'petId', required: true }],
  body: null, declaredServer: 'https://somewhere-else.example/v9',
};

const descriptor = (overrides: Partial<TenantToolDescriptor> = {}): TenantToolDescriptor => ({
  id: 'tool-1',
  sourceId: 'source-1',
  sourceName: 'Pets',
  sourceKind: 'openapi',
  ownerRef: { orgId: 'org-1', partnerId: null },
  qualifiedName: 'petsvc__showPetById',
  name: 'showPetById',
  description: 'Info for a specific pet',
  inputSchema: { type: 'object' },
  tier: 1,
  revision: 'rev-1',
  rateLimitPerMinute: 60,
  validate: () => ({ success: true }),
  definition: { name: 'petsvc__showPetById', description: 'Info', input_schema: { type: 'object' } },
  ...overrides,
});

const source = (): ToolSourceRow => ({
  id: 'source-1', orgId: 'org-1', partnerId: null, slug: 'petsvc', name: 'Pets', kind: 'openapi',
  endpointUrl: 'https://api.example.com/v1', specUrl: 'https://docs.example.net/openapi.json',
  credentialOrigin: 'https://api.example.com', authKind: 'bearer', authConfigEncrypted: 'x', authFingerprint: 'fp',
  status: 'active', lastDiscoveredAt: null, lastError: null, lastDiscoverySummary: null, rateLimitPerMinute: 60,
  createdByUserId: null, createdAt: new Date(), updatedAt: new Date(),
}) as unknown as ToolSourceRow;

const tool = (annotations: Record<string, unknown>): ToolSourceToolRow =>
  ({ id: 'tool-1', sourceId: 'source-1', name: 'showPetById', annotations }) as unknown as ToolSourceToolRow;

const auth = {
  scope: 'organization', orgId: 'org-1', partnerId: null,
  user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
} as unknown as AuthContext;

function mockLoaded(annotations: Record<string, unknown>) {
  vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: descriptor(), source: source(), tool: tool(annotations) } as any);
}

describe('executeTenantToolDetailed — openapi kind (W2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'bearer', token: 'tok-SECRET-9f2' });
  });

  it('dispatches through OpenApiClient with the source endpoint as the base URL, never declaredServer', async () => {
    mockLoaded({ readOnlyHint: true, operation: BINDING });
    mockCallOperation.mockResolvedValue({ isError: false, text: '{"id":"1"}' });

    const result = await executeTenantToolDetailed(descriptor(), { petId: '1' }, auth, { surface: 'chat' });

    expect(result).toEqual({ isError: false, text: '{"id":"1"}' });
    expect(mockMcpCtor).not.toHaveBeenCalled();
    expect(mockOpenApiCtor).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      credentialOrigin: 'https://api.example.com',
      auth: { authKind: 'bearer', token: 'tok-SECRET-9f2' },
      allowPrivateNetwork: false,
    });
    expect(mockCallOperation).toHaveBeenCalledWith(BINDING, { petId: '1' });
  });

  it('passes the private-egress flag through to the OpenAPI client', async () => {
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(true);
    mockLoaded({ operation: BINDING });
    mockCallOperation.mockResolvedValue({ isError: false, text: 'ok' });

    await executeTenantToolDetailed(descriptor(), { petId: '1' }, auth, { surface: 'chat' });

    expect(mockOpenApiCtor.mock.calls[0]![0]).toMatchObject({ allowPrivateNetwork: true });
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(false);
  });

  it('reports a missing or malformed operation binding without calling out, and still audits', async () => {
    for (const annotations of [{}, { operation: { ...BINDING, path: 'https://evil.example/x' } }]) {
      vi.clearAllMocks();
      vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
      vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'none' });
      mockLoaded(annotations);

      const result = await executeTenantToolDetailed(descriptor(), { petId: '1' }, auth, { surface: 'mcp' });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/re-discover/);
      expect(mockOpenApiCtor).not.toHaveBeenCalled();
      expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    }
  });

  it('redacts the source credential out of an OpenAPI error body', async () => {
    mockLoaded({ operation: BINDING });
    mockCallOperation.mockResolvedValue({ isError: true, text: 'HTTP 401: token tok-SECRET-9f2 rejected' });

    const result = await executeTenantToolDetailed(descriptor(), { petId: '1' }, auth, { surface: 'chat' });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('tok-SECRET-9f2');
    expect(result.text).toContain('HTTP 401');
  });

  it('writes the same audit event shape as the mcp path — keys only, never values', async () => {
    mockLoaded({ operation: BINDING });
    mockCallOperation.mockResolvedValue({ isError: false, text: 'ok' });

    await executeTenantToolDetailed(descriptor(), { petId: 'secret-pet-id' }, auth, { surface: 'test' });

    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(writeAuditEvent).mock.calls[0]![1] as Record<string, any>;
    expect(event).toMatchObject({
      action: 'ai.external_tool.call',
      resourceType: 'tool_source_tool',
      resourceId: 'tool-1',
      details: { sourceId: 'source-1', tier: 1, surface: 'test', inputKeys: ['petId'], isError: false },
    });
    expect(JSON.stringify(event)).not.toContain('secret-pet-id');
  });

  it('turns a throwing OpenAPI client into an error result', async () => {
    mockLoaded({ operation: BINDING });
    mockCallOperation.mockRejectedValue(new Error('boom tok-SECRET-9f2'));

    const result = await executeTenantToolDetailed(descriptor(), { petId: '1' }, auth, { surface: 'chat' });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('tok-SECRET-9f2');
  });
});
