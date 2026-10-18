import { describe, expect, it } from 'vitest';
import {
  createToolSourceSchemaWithHttp, updateToolSourceSchemaWithHttp, updateToolSourceSchema, createToolSourceSchema, patchToolSourceToolSchema, qualifiedToolName, splitQualifiedToolName,
  isTenantToolName, TOOL_SOURCE_SLUG_RE, RESERVED_TOOL_SOURCE_SLUGS, TOOL_SOURCE_KINDS,
} from './toolSources';

const base = { name: 'Hudu', slug: 'hudu', kind: 'mcp', endpointUrl: 'https://mcp.hudu.example/mcp', authKind: 'bearer', authConfig: { token: 'abc' } };

describe('toolSources validators', () => {
  it('accepts a minimal MCP source with bearer auth', () => {
    expect(createToolSourceSchema.safeParse(base).success).toBe(true);
  });
  it('rejects openapi kind in W1', () => {
    expect(createToolSourceSchema.safeParse({ ...base, kind: 'openapi' }).success).toBe(false);
  });
  it('rejects http endpoints, reserved slugs, slugs with underscores or hyphens', () => {
    expect(createToolSourceSchema.safeParse({ ...base, endpointUrl: 'http://x.example/mcp' }).success).toBe(false);
    for (const slug of RESERVED_TOOL_SOURCE_SLUGS) expect(createToolSourceSchema.safeParse({ ...base, slug }).success).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('hu_du')).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('hu-du')).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('h')).toBe(false);
  });
  it('requires authConfig fields matching authKind', () => {
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'basic', authConfig: { token: 'x' } }).success).toBe(false);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'basic', authConfig: { username: 'u', password: 'p' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'api_key_header', authConfig: { headerName: 'X-Api-Key', value: 'k' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'oauth2_client_credentials', authConfig: { tokenUrl: 'https://id.example/token', clientId: 'a', clientSecret: 'b', scope: 'read' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'none', authConfig: undefined }).success).toBe(true);
  });
  it('rejects a header name that is not a token and a tokenUrl over http', () => {
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'api_key_header', authConfig: { headerName: 'X Api', value: 'k' } }).success).toBe(false);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'oauth2_client_credentials', authConfig: { tokenUrl: 'http://id.example/token', clientId: 'a', clientSecret: 'b' } }).success).toBe(false);
  });
  it('patch tool schema allows tier 1-3 and enabled only', () => {
    expect(patchToolSourceToolSchema.safeParse({ tier: 2 }).success).toBe(true);
    expect(patchToolSourceToolSchema.safeParse({ tier: 4 }).success).toBe(false);
    expect(patchToolSourceToolSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
  it('qualified names split at the first __ and reject core-shaped names', () => {
    expect(qualifiedToolName('hudu', 'get_asset')).toBe('hudu__get_asset');
    expect(splitQualifiedToolName('hudu__get__asset')).toEqual({ slug: 'hudu', name: 'get__asset' });
    expect(splitQualifiedToolName('get_device_details')).toBeNull();
    expect(isTenantToolName('hudu__get_asset')).toBe(true);
    expect(isTenantToolName('__x')).toBe(false);
    expect(isTenantToolName('hu-du__x')).toBe(false);
  });
});

describe('explicit HTTP allowance', () => {
  it.each(['http://host.example/mcp', 'https://host.example/mcp'])('accepts %s only in the appropriate schemas', (endpointUrl) => {
    expect(createToolSourceSchemaWithHttp.safeParse({ ...base, endpointUrl }).success).toBe(true);
    expect(updateToolSourceSchemaWithHttp.safeParse({ endpointUrl }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, endpointUrl }).success).toBe(endpointUrl.startsWith('https:'));
    expect(updateToolSourceSchema.safeParse({ endpointUrl }).success).toBe(endpointUrl.startsWith('https:'));
  });
  it.each(['ftp://host.example/mcp', 'file:///tmp/mcp', 'invalid'])('still rejects %s', (endpointUrl) => {
    expect(createToolSourceSchemaWithHttp.safeParse({ ...base, endpointUrl }).success).toBe(false);
    expect(updateToolSourceSchemaWithHttp.safeParse({ endpointUrl }).success).toBe(false);
  });
  it('does not relax OAuth token URL validation', () => {
    expect(createToolSourceSchemaWithHttp.safeParse({ ...base, authKind: 'oauth2_client_credentials', authConfig: { tokenUrl: 'http://host.example/token', clientId: 'id', clientSecret: 'secret' } }).success).toBe(false);
  });
});

describe('toolSources validators — openapi kind (W2)', () => {
  const openapiBase = {
    name: 'Vendor',
    slug: 'vendor',
    kind: 'openapi' as const,
    endpointUrl: 'https://api.vendor.example/v1',
    specUrl: 'https://api.vendor.example/v1/openapi.json',
    authKind: 'bearer' as const,
    authConfig: { token: 'abc' },
  };

  it('exports the supported kinds', () => {
    expect([...TOOL_SOURCE_KINDS]).toEqual(['mcp', 'openapi']);
  });

  it('accepts an openapi source with an https spec URL', () => {
    const parsed = createToolSourceSchema.safeParse(openapiBase);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.specUrl).toBe(openapiBase.specUrl);
  });

  it('rejects an openapi source with no specUrl', () => {
    const { specUrl: _omitted, ...withoutSpec } = openapiBase;
    expect(createToolSourceSchema.safeParse(withoutSpec).success).toBe(false);
    expect(createToolSourceSchemaWithHttp.safeParse(withoutSpec).success).toBe(false);
  });

  it('rejects an mcp source that supplies a specUrl', () => {
    const mcpWithSpec = { ...base, specUrl: 'https://mcp.hudu.example/openapi.json' };
    expect(createToolSourceSchema.safeParse(mcpWithSpec).success).toBe(false);
    expect(createToolSourceSchemaWithHttp.safeParse(mcpWithSpec).success).toBe(false);
  });

  it('rejects an http specUrl in the https-only schema and accepts it in the http variant', () => {
    const httpSpec = { ...openapiBase, endpointUrl: 'http://api.vendor.local/v1', specUrl: 'http://api.vendor.local/v1/openapi.json' };
    expect(createToolSourceSchema.safeParse(httpSpec).success).toBe(false);
    expect(createToolSourceSchemaWithHttp.safeParse(httpSpec).success).toBe(true);
    expect(createToolSourceSchemaWithHttp.safeParse({ ...httpSpec, specUrl: 'ftp://api.vendor.local/o.json' }).success).toBe(false);
  });

  it('still rejects an unknown kind', () => {
    expect(createToolSourceSchema.safeParse({ ...openapiBase, kind: 'graphql' }).success).toBe(false);
  });

  it('update schemas accept a new specUrl but refuse a kind change', () => {
    expect(updateToolSourceSchema.safeParse({ specUrl: 'https://api.vendor.example/v2/openapi.json' }).success).toBe(true);
    expect(updateToolSourceSchema.safeParse({ specUrl: 'http://api.vendor.example/v2/openapi.json' }).success).toBe(false);
    expect(updateToolSourceSchemaWithHttp.safeParse({ specUrl: 'http://api.vendor.local/v2/openapi.json' }).success).toBe(true);
    expect(updateToolSourceSchema.safeParse({ kind: 'mcp' }).success).toBe(false);
    expect(updateToolSourceSchemaWithHttp.safeParse({ kind: 'openapi' }).success).toBe(false);
  });

  it('update schemas still accept a credential replacement alongside core fields', () => {
    expect(updateToolSourceSchema.safeParse({ name: 'x', authKind: 'bearer', authConfig: { token: 't' } }).success).toBe(true);
    expect(updateToolSourceSchema.safeParse({ authKind: 'none' }).success).toBe(true);
  });
});
