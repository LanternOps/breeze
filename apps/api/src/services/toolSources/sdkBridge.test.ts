import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthContext } from '../../middleware/auth';
import type { TenantToolDescriptor } from './resolver';

vi.mock('./execute', () => ({ executeTenantTool: vi.fn(), executeTenantToolDetailed: vi.fn() }));

import { zodShapeFromJsonSchema, buildTenantSdkTools, tenantMcpToolNames } from './sdkBridge';
import { executeTenantToolDetailed } from './execute';

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
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    tier: 1,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: 'hudu__get_asset', description: 'Get an asset', input_schema: { type: 'object' } },
    ...overrides,
  };
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    user: { id: 'user-1', email: 'tech@example.com' },
  } as unknown as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('zodShapeFromJsonSchema', () => {
  it('compiles an object schema whose shape enforces required fields', () => {
    const shape = zodShapeFromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    const schema = z.object(shape);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: 'x' }).success).toBe(true);
  });

  it('falls back to a permissive `input` field for a non-object top-level schema', () => {
    const shape = zodShapeFromJsonSchema({ type: 'string' });
    expect(Object.keys(shape)).toEqual(['input']);
    const schema = z.object(shape);
    expect(schema.safeParse({ input: { anything: 'goes' } }).success).toBe(true);
  });

  it('falls back to a permissive `input` field when the schema fails to compile', () => {
    const shape = zodShapeFromJsonSchema({ $ref: '#/definitions/doesNotExist' });
    expect(Object.keys(shape)).toEqual(['input']);
    const schema = z.object(shape);
    expect(schema.safeParse({ input: {} }).success).toBe(true);
  });
});

describe('buildTenantSdkTools', () => {
  it('returns one SdkTool per descriptor, named by qualified name', () => {
    const descriptors = [
      makeDescriptor({ qualifiedName: 'hudu__get_asset' }),
      makeDescriptor({ qualifiedName: 'hudu__create_asset', tier: 3 }),
    ];
    const tools = buildTenantSdkTools(descriptors, () => makeAuth(), () => 'org-1');
    expect(tools.map((t) => t.name)).toEqual(['hudu__get_asset', 'hudu__create_asset']);
  });

  it('the description is prefixed with [External: <sourceName>]', () => {
    const [tool] = buildTenantSdkTools([makeDescriptor()], () => makeAuth(), () => 'org-1');
    expect(tool!.description).toBe('[External: Hudu] Get an asset');
  });

  it('handler calls executeTenantToolDetailed with the descriptor, args, resolved auth, and chat surface options, and wraps the text result', async () => {
    vi.mocked(executeTenantToolDetailed).mockResolvedValue({
      isError: false,
      text: JSON.stringify({ ok: true }),
    });
    const descriptor = makeDescriptor();
    const auth = makeAuth();
    const getAuth = vi.fn(() => auth);
    const getOrgId = vi.fn(() => 'org-1');
    const [tool] = buildTenantSdkTools([descriptor], getAuth, getOrgId);

    const result = await tool!.handler({ id: 'abc' }, {} as never);

    expect(executeTenantToolDetailed).toHaveBeenCalledWith(
      descriptor,
      { id: 'abc' },
      auth,
      { surface: 'chat', orgId: 'org-1' },
    );
    expect(getAuth).toHaveBeenCalled();
    expect(getOrgId).toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });
  });

  it('sets isError: true on the returned result when the tenant tool call fails', async () => {
    vi.mocked(executeTenantToolDetailed).mockResolvedValue({
      isError: true,
      text: JSON.stringify({ error: 'remote MCP call failed' }),
    });
    const descriptor = makeDescriptor();
    const [tool] = buildTenantSdkTools([descriptor], () => makeAuth(), () => 'org-1');

    const result = await tool!.handler({ id: 'abc' }, {} as never);

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'remote MCP call failed' }) }],
      isError: true,
    });
  });

  it('reads auth/orgId lazily from the thunks on every call, not once at construction', async () => {
    vi.mocked(executeTenantToolDetailed).mockResolvedValue({ isError: false, text: '{}' });
    let currentOrgId = 'org-1';
    const [tool] = buildTenantSdkTools(
      [makeDescriptor()],
      () => makeAuth(),
      () => currentOrgId,
    );
    await tool!.handler({}, {} as never);
    currentOrgId = 'org-2';
    await tool!.handler({}, {} as never);

    expect(vi.mocked(executeTenantToolDetailed).mock.calls[0]![3]).toEqual({ surface: 'chat', orgId: 'org-1' });
    expect(vi.mocked(executeTenantToolDetailed).mock.calls[1]![3]).toEqual({ surface: 'chat', orgId: 'org-2' });
  });
});

describe('tenantMcpToolNames', () => {
  it('prefixes every qualified name with mcp__breeze__', () => {
    const names = tenantMcpToolNames([
      makeDescriptor({ qualifiedName: 'hudu__get_asset' }),
      makeDescriptor({ qualifiedName: 'hudu__create_asset' }),
    ]);
    expect(names).toEqual(['mcp__breeze__hudu__get_asset', 'mcp__breeze__hudu__create_asset']);
  });

  it('returns an empty array for no descriptors', () => {
    expect(tenantMcpToolNames([])).toEqual([]);
  });
});
