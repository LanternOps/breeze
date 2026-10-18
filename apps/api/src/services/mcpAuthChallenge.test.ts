import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({ OAUTH_ISSUER: 'https://issuer.example.com' }));

import {
  applyInsufficientScopeChallenge,
  buildBearerChallenge,
  MCP_DEFAULT_CHALLENGE_SCOPES,
  requiredMcpScopesFor,
} from './mcpAuthChallenge';

const METADATA = 'resource_metadata="https://issuer.example.com/.well-known/oauth-protected-resource"';

function ctx() {
  const headers: Record<string, string> = {};
  return { c: { header: (k: string, v: string) => { headers[k] = v; } } as never, headers };
}

const scopeDenial = (requiredScope: string) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  error: { code: -32603, message: `Tool "x" requires ${requiredScope} scope`, data: { reason: 'insufficient_scope', requiredScope } },
});

const bearer = { id: 'oauth:jti', orgId: 'org-1', oauthGrantId: 'grant-1', scopes: ['ai:read'], mcpDomains: null };
const xApiKey = { id: 'key-1', orgId: 'org-1', scopes: ['ai:read'], mcpDomains: null };

afterEach(() => vi.unstubAllEnvs());

describe('buildBearerChallenge', () => {
  it('default challenge carries realm, resource_metadata and the three mcp scopes', () => {
    expect(MCP_DEFAULT_CHALLENGE_SCOPES).toEqual(['mcp:read', 'mcp:write', 'mcp:execute']);
    expect(buildBearerChallenge()).toBe(`Bearer realm="breeze", ${METADATA}, scope="mcp:read mcp:write mcp:execute"`);
  });

  it('carries an error code when given one', () => {
    expect(buildBearerChallenge({ error: 'invalid_token' }))
      .toBe(`Bearer realm="breeze", error="invalid_token", ${METADATA}, scope="mcp:read mcp:write mcp:execute"`);
    expect(buildBearerChallenge({ error: 'insufficient_scope', scope: ['mcp:read'] }))
      .toBe(`Bearer realm="breeze", error="insufficient_scope", ${METADATA}, scope="mcp:read"`);
  });
});

describe('requiredMcpScopesFor', () => {
  it('maps tier scopes to mcp scopes', () => {
    expect(requiredMcpScopesFor('ai:write')).toEqual(['mcp:write']);
    expect(requiredMcpScopesFor('ai:execute')).toEqual(['mcp:execute']);
  });

  it('execute_admin never maps to a step-up scope', () => {
    expect(requiredMcpScopesFor('ai:execute_admin')).toEqual([]);
    expect(requiredMcpScopesFor('anything')).toEqual([]);
  });
});

describe('applyInsufficientScopeChallenge', () => {
  it('is dormant when the flag is off', () => {
    const { c, headers } = ctx();
    expect(applyInsufficientScopeChallenge(c, bearer, scopeDenial('ai:write'))).toBe(200);
    expect(headers).toEqual({});
  });

  it('insufficient_scope challenge names current ∪ required', () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const { c, headers } = ctx();
    expect(applyInsufficientScopeChallenge(c, { ...bearer, scopes: ['ai:read', 'ai:write'] }, scopeDenial('ai:execute'))).toBe(403);
    expect(headers['WWW-Authenticate'])
      .toBe(`Bearer realm="breeze", error="insufficient_scope", ${METADATA}, scope="mcp:read mcp:write mcp:execute"`);
  });

  it('never fires for X-API-Key callers, other denials, or unmapped scopes', () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const cases: Array<[unknown, unknown]> = [
      [xApiKey, scopeDenial('ai:write')],
      [undefined, scopeDenial('ai:write')],
      [bearer, scopeDenial('ai:execute_admin')],
      [bearer, { jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'x', data: { reason: 'domain_not_granted', domain: 'devices' } } }],
      [bearer, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Tool "x" requires ai:write scope' } }],
      [bearer, { jsonrpc: '2.0', id: 1, result: { content: [] } }],
    ];
    for (const [apiKey, response] of cases) {
      const { c, headers } = ctx();
      expect(applyInsufficientScopeChallenge(c, apiKey as never, response as never)).toBe(200);
      expect(headers).toEqual({});
    }
  });

  it('only the exact string "true" turns it on', () => {
    for (const v of ['1', 'TRUE', 'yes', '']) {
      vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', v);
      expect(applyInsufficientScopeChallenge(ctx().c, bearer, scopeDenial('ai:write'))).toBe(200);
    }
  });
});
