import { describe, expect, it } from 'vitest';
import { buildMcpRequestCorrelation, correlationAuditDetails, sanitizeMcpClientInfo } from './mcpRequestCorrelation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function build(apiKeyId: string, rawClientInfo?: unknown) {
  return buildMcpRequestCorrelation({
    era: 'modern', protocolVersion: '2026-07-28', transport: 'streamable_http',
    sessionId: null, principalKey: 'oauth-grant:g1', apiKeyId, rawClientInfo,
  });
}

describe('mcpRequestCorrelation', () => {
  it('sanitizeMcpClientInfo keeps two bounded strings and drops everything else', () => {
    expect(sanitizeMcpClientInfo({ name: 'x'.repeat(200) + '\u0007', version: 3, evil: 1 }))
      .toEqual({ name: 'x'.repeat(64), version: null });
    expect(sanitizeMcpClientInfo('nope')).toBeNull();
    expect(sanitizeMcpClientInfo(null)).toBeNull();
    expect(sanitizeMcpClientInfo([])).toBeNull();
    expect(sanitizeMcpClientInfo({ version: '1' })).toBeNull();
    expect(sanitizeMcpClientInfo({ name: 'cli\u0000ent', version: 'v'.repeat(80) }))
      .toEqual({ name: 'client', version: 'v'.repeat(64) });
    expect(sanitizeMcpClientInfo({ name: '\u0001\u0002' })).toBeNull();
  });
  it('jti is null for no-jti and API keys', () => {
    expect(build('oauth:abc').tokenJti).toBe('abc');
    expect(build('oauth:no-jti').tokenJti).toBeNull();
    expect(build('8a4c2b0e-1111-4222-8333-444455556666').tokenJti).toBeNull();
    expect(build('oauth:').tokenJti).toBeNull();
  });
  it('mints a fresh UUID requestId per request and never takes it from input', () => {
    const a = build('oauth:abc');
    const b = build('oauth:abc');
    expect(a.requestId).toMatch(UUID_RE);
    expect(b.requestId).toMatch(UUID_RE);
    expect(a.requestId).not.toBe(b.requestId);
    const withExtra = buildMcpRequestCorrelation({
      era: 'legacy', protocolVersion: '2025-11-25', transport: 'http_sse', sessionId: 'mcp-1',
      principalKey: 'k', apiKeyId: 'k', ...({ requestId: 'attacker' } as object),
    });
    expect(withExtra.requestId).not.toBe('attacker');
    expect(withExtra).not.toHaveProperty('apiKeyId');
    expect(withExtra).not.toHaveProperty('rawClientInfo');
  });
  it('carries the sanitized clientInfo', () => {
    expect(build('k', { name: 'inspector', version: '0.9' }).clientInfo).toEqual({ name: 'inspector', version: '0.9' });
    expect(build('k').clientInfo).toBeNull();
  });
  it('correlationAuditDetails nests the record and flags clientInfo as self-reported', () => {
    const c = build('oauth:abc', { name: 'x' });
    expect(correlationAuditDetails(c)).toEqual({
      correlation: {
        requestId: c.requestId, era: 'modern', protocolVersion: '2026-07-28', transport: 'streamable_http',
        sessionId: null, principalKey: 'oauth-grant:g1', tokenJti: 'abc', clientInfo: { name: 'x', version: null },
      },
      clientInfoTrust: 'self_reported',
    });
  });
});
